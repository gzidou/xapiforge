# 浏览器应用接入

> 本文档以 Vue 3 + Vite 为例，展示从零接入 `@xapiforge/core` 的完整步骤。React / 其他框架步骤相同，仅入口文件写法不同。

## 前置条件

- Node.js >= 20.19
- pnpm >= 9
- 后端已提供 swagger.json（OpenAPI 3.x）
- 你的项目已初始化（`pnpm create vite` 或等价方式）

## 架构概览

```text
┌─────────────── 你的应用 ───────────────┐
│  业务代码（api.base.GET(...)）          │
├────────────────────────────────────────┤
│  @xapiforge/core                         │
│  ├─ createNet（工厂，封装 openapi-fetch）│
│  ├─ AuthService（token / refresh / 401）│
│  ├─ HttpClient（纯 HTTP，给 AuthApi 用） │
│  └─ middleware 链（auth + retry + httpError）│
├────────────────────────────────────────┤
│  @xapiforge/adapter-browser         │
│  └─ localStorageStore（token 存储）     │
├────────────────────────────────────────┤
│  @xapiforge/genapi (含 xapiforge-fetch CLI) │
│  └─ swagger.json → TS API 客户端生成    │
└────────────────────────────────────────┘
```

## 步骤 1：安装依赖

在你的应用项目里：

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
pnpm add -D @xapiforge/genapi openapi-fetch
```

> `@xapiforge/*` packages are published to npm. If you're working inside this monorepo, use `workspace:*` instead.

## 步骤 2：配置 xapiforge.config.ts

在项目根目录创建 `xapiforge.config.ts`：

```typescript
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  // swagger.json 下载路径（后端默认通常是 /swagger/v1/swagger.json）
  defaultPath: "/swagger/v1/swagger.json",
  timeoutMs: 15_000,
  // swagger.json 落盘目录
  outputDir: "swagger",
  // API 客户端生成目录
  genOutputDir: "src/api",
  // offline: 用本地 swagger.json（不连后端）
  // online:  连后端下载
  mode: "online",
  projects: [
    {
      name: "myapp", // 项目 ID（英文短码，作目录名）
      displayName: "我的应用", // 中文全称（日志展示用）
      baseHost: "http://localhost:7001", // 后端地址
      services: [
        { name: "base", displayName: "基础服务", port: 7001 },
        { name: "file", displayName: "文件服务", port: 7002 }
      ]
    }
  ]
});
```

**字段说明**：

| 字段                  | 必填 | 说明                                                |
| --------------------- | ---- | --------------------------------------------------- |
| `name`                | ✓    | 项目 ID / 目录名（英文短码）                        |
| `displayName`         | ✓    | 中文全称                                            |
| `baseHost`            | ✓    | 后端主机，不带尾部 `/`                              |
| `services[].name`     | ✓    | 服务 ID / 文件名                                    |
| `services[].port`     | ✓    | 端口                                                |
| `services[].path`     | ×    | 覆盖 `defaultPath`（某些微服务 swagger 路径不同）   |
| `services[].baseHost` | ×    | 覆盖 `project.baseHost`（服务部署在另一台机器时用） |

## 步骤 3：下载 swagger.json + 生成 API 客户端

在 `package.json` 加脚本：

```json
{
  "scripts": {
    "download-swagger": "xapiforge-fetch",
    "generate:api": "xapiforge demo"
  }
}
```

执行：

```bash
# 1. 下载 swagger.json 到 swagger/myapp/*.json
pnpm download-swagger

# 2. 生成 TS API 客户端到 src/api/myapp/
pnpm generate:api myapp
```

生成产物（gitignored，每次重新生成）：

```text
src/api/myapp/
├── index.ts          # createXxxClient() 工厂 + 强类型 client
├── api-types.ts      # 路径 / 参数 / 响应的聚合类型
└── types/
    ├── base.ts       # 各 service 的 schema 类型
    └── file.ts
```

## 步骤 4：写 AuthApi（登录 / 刷新 token）

`AuthApi` 必须用 `HttpClient`（纯 HTTP），**不能**用 `createNet`。

原因：`createNet` 会注入 auth middleware（自动加 token + 401 刷新），但登录 / 刷新端点本身就是鉴权端点，走 middleware 会死循环。

```typescript
// src/AuthApi.ts
import { NetworkError } from "@xapiforge/core";
import type { HttpClient } from "@xapiforge/core";

export interface AuthPojo {
  token: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn: number;
}

interface OAuth2TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export class AuthLoginError extends Error {
  constructor(
    message: string,
    readonly oauth2?: { error: string; error_description?: string }
  ) {
    super(message);
    this.name = "AuthLoginError";
  }
}

export class AuthApi {
  constructor(
    private readonly http: HttpClient,
    private readonly config: {
      tokenUrl: string; // 如 "/connect/token"
      clientId: string; // 如 "Infrastructure_Web"
      scope: string; // 如 "offline_access Infrastructure"
    }
  ) {}

  async login(username: string, password: string, tenant?: string): Promise<AuthPojo> {
    // ⚠ 关键：手动拼 form-urlencoded，不要用 URLSearchParams
    // URLSearchParams.toString() 会把 %20 转 +，后端不认
    const body = [`client_id=${encodeURIComponent(this.config.clientId)}`, `scope=${encodeURIComponent(this.config.scope)}`, `username=${encodeURIComponent(username)}`, `password=${encodeURIComponent(password)}`, `grant_type=password`].join("&");

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded"
    };
    if (tenant) headers.__tenant = tenant;

    const res = await this.http.request({
      method: "POST",
      path: this.config.tokenUrl,
      body,
      headers
    });

    const json = JSON.parse(res.bodyText || "{}");
    if (!res.ok || json.error) {
      throw new AuthLoginError(json.error_description || json.error || `HTTP ${res.status}`, json);
    }
    return {
      token: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type,
      expiresIn: json.expires_in
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthPojo> {
    const body = [`client_id=${encodeURIComponent(this.config.clientId)}`, `scope=${encodeURIComponent(this.config.scope)}`, `refresh_token=${encodeURIComponent(refreshToken)}`, `grant_type=refresh_token`].join("&");

    const res = await this.http.request({
      method: "POST",
      path: this.config.tokenUrl,
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    const json = JSON.parse(res.bodyText || "{}");
    if (!res.ok || json.error) {
      throw new AuthLoginError(json.error_description || json.error || `HTTP ${res.status}`, json);
    }
    return {
      token: json.access_token,
      refreshToken: json.refresh_token,
      tokenType: json.token_type,
      expiresIn: json.expires_in
    };
  }
}
```

## 步骤 5：写业务 middleware（可选，按后端协议）

如果后端用 envelope 包装（如 ABP 的 `{code, data, message}`），需要写解包 middleware。

```typescript
// src/middleware/abp-unwrap-mw.ts
import { RetryableError } from "@xapiforge/core";
import type { Middleware } from "openapi-fetch";

interface AbpEnvelope<T = unknown> {
  code: number;
  data: T;
  message?: string;
}

// ABP 业务鉴权码（HTTP 200 + envelope code，触发 refresh）
const ABP_AUTH_CODES = new Set([40001, 40002, 41001]);

export class AbpBizError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`ABP biz error ${code}: ${message}`);
    this.name = "AbpBizError";
    this.code = code;
  }
}

export function createAbpUnwrapMw(authCodes: number[] = [...ABP_AUTH_CODES]): Middleware {
  const authCodeSet = new Set(authCodes);
  return {
    async onResponse({ response }) {
      if (!response.ok) return response; // 非 2xx 交给内核 middleware
      const ct = response.headers.get("Content-Type") ?? "";
      if (!ct.includes("application/json")) return response;

      const text = await response.clone().text();
      if (!text) return response;

      let envelope: AbpEnvelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        return response; // 非 JSON 不处理
      }

      if (typeof envelope.code !== "number") return response; // 非 ABP 格式

      if (envelope.code === 0) {
        // 成功：解包 data，替换 response body
        return new Response(JSON.stringify(envelope.data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }

      if (authCodeSet.has(envelope.code)) {
        // 业务鉴权码：抛 RetryableError 触发 refresh + 重试
        throw new RetryableError(`abp auth code ${envelope.code}`, { needsRefresh: true });
      }

      // 业务错误：抛 AbpBizError
      throw new AbpBizError(envelope.code, envelope.message ?? "unknown");
    }
  };
}
```

## 步骤 6：初始化（应用入口）

```typescript
// src/main.ts
import { createApp } from "vue";
import { AuthService, HttpClient } from "@xapiforge/core";
import { localStorageStore } from "@xapiforge/adapter-browser";
import { createRouter, createWebHistory } from "vue-router";
import { AuthApi } from "./AuthApi";
import { createAbpUnwrapMw } from "./middleware/abp-unwrap-mw";
import { initApi } from "./api";

const BASE_URL = "http://localhost:7001";

// Vue Router（401 跳登录用）
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: () => import("./views/Login.vue") },
    { path: "/", component: () => import("./views/Home.vue") }
  ]
});

// 1. HttpClient（纯 HTTP，给 AuthApi / 文件下载用）
const httpClient = new HttpClient({ baseURL: BASE_URL });

// 2. AuthApi（用 HttpClient 调 /connect/token）
const authApi = new AuthApi(httpClient, {
  tokenUrl: "/connect/token",
  clientId: "Infrastructure_Web",
  scope: "offline_access Infrastructure"
});

// 3. AuthService（鉴权状态机）
const authService = new AuthService({
  tokenStore: localStorageStore("app_token"),
  authRefresher: {
    async refresh() {
      const refreshToken = localStorage.getItem("app_refresh_token");
      if (!refreshToken) throw new Error("no refresh_token");
      const r = await authApi.refreshToken(refreshToken);
      localStorage.setItem("app_refresh_token", r.refreshToken ?? "");
      return r.token;
    }
  },
  onAuthFailed: () => {
    void router.push("/login"); // refresh 失败 → 跳登录
  }
});

// 4. 注册业务 client（createNet + middleware）
initApi("default", {
  baseURL: BASE_URL,
  authService,
  middleware: [createAbpUnwrapMw()], // ABP envelope 解包
  maxRetries: 3 // 429 退避重试
});

createApp(App).use(router).mount("#app");
```

## 步骤 7：业务代码调用

```typescript
// src/views/Home.vue
import { useApi } from "../api";

const api = useApi();

// 强类型调用（路径 / 参数 / 响应都有类型校验）
const user = await api.base.GET("/api/identity/users/{id}", {
  params: { path: { id: "u-001" } }
});

// 文件下载（走内核 middleware：鉴权 + 重试 + 进度）
const { blob, filename } = await api.download("/api/file/download?id=123", {
  onProgress: (received, total) => console.log(`${received}/${total}`)
});

// 错误处理
import { AuthError, NetworkError } from "@xapiforge/core";
import { AbpBizError } from "../middleware/abp-unwrap-mw";

try {
  await api.base.POST("/api/orders", { body: {/* ... */} });
} catch (e) {
  if (e instanceof AuthError) {
    /* 鉴权失败（refresh 也失败） */
  } else if (e instanceof NetworkError) {
    /* 网络错误（5xx / 超时） */
  } else if (e instanceof AbpBizError) {
    /* 业务错误（envelope code != 0） */
  }
}
```

## 完整示例

完整的浏览器接入示例见 [examples/demo-app/](https://github.com/)，包含：

- 登录页面 + token 存储
- CRUD 页面（强类型 API 调用）
- 文件下载（进度 + 文件名提取）
- 第三方 API 接入（多 client 共存）
- ABP envelope 解包 middleware

## 下一步

- [鉴权详解](../guides/auth.md) — token 刷新机制 / 单飞 / 窗口保护
- [自定义 middleware](../guides/middleware.md) — 适配非 ABP 后端协议
- [文件下载](../guides/file-download.md) — 流式下载 / 大文件 / 断点续传
- [错误处理](../guides/error-handling.md) — 错误类型体系 / 业务错误
