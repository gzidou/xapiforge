# 浏览器应用接入

本文以 Vue 3 + Vite 为例，先完成一个最小可运行请求，再按需增加登录、Token 刷新和业务 middleware。React 或其他浏览器框架使用相同的客户端初始化方式。

## 前置条件

- Node.js >= 20.19
- pnpm >= 9
- 一个 OpenAPI 3.x `swagger.json`
- 已初始化的前端项目，例如 `pnpm create vue@latest`

## 最短接入路径

### 1. 安装依赖

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
pnpm add -D @xapiforge/genapi
```

如果正在验证本地 npm registry，可以显式指定地址：

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser --registry http://localhost:4873
pnpm add -D @xapiforge/genapi --registry http://localhost:4873
```

使用者不需要单独安装 `openapi-typescript` 或 `openapi-fetch`。前者由 `@xapiforge/genapi` 管理，后者由 `@xapiforge/core` 管理。

### 2. 创建 xapiforge.config.ts

在应用根目录创建 `xapiforge.config.ts`：

```typescript
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  timeoutMs: 15_000,
  outputDir: "swagger",
  genOutputDir: "src/api/gen",
  mode: "online",
  projects: [
    {
      name: "myapp",
      displayName: "My Application",
      services: [
        {
          name: "base",
          displayName: "Base API",
          source: { url: "http://localhost:7001/swagger/v1/swagger.json" }
        }
      ]
    }
  ]
});
```

`genOutputDir` 可以省略，默认值是 `src/api/gen`。旧项目如果显式配置了 `src/api`，升级后仍会继续生成到旧目录；迁移时需要同时修改该字段和业务代码中的生成客户端导入路径，确认构建通过后再清理旧产物。

字段说明：

| 字段                     | 必填   | 说明                                                        |
| ------------------------ | ------ | ----------------------------------------------------------- |
| `name`                   | 是     | 项目 ID，同时作为目录名，建议使用稳定英文短码               |
| `displayName`            | 是     | 日志中展示的名称                                            |
| `services[].name`        | 是     | 稳定 service ID；决定生成目录、类型身份和 service namespace |
| `services[].source.url`  | 二选一 | 完整 HTTP(S) OpenAPI URL                                    |
| `services[].source.file` | 二选一 | 本地 JSON；相对路径以配置文件所在项目根目录为基准           |

`mode` 有两种用途：

- `online`：只下载 `source.url` 到 `outputDir/<project>/<service>.json`；`source.file` 仍直接读取。
- `offline`：不访问网络。`source.url` 读取上述缓存，`source.file` 读取其配置路径。

例如上面的 URL source 在离线模式下对应：

```text
swagger/myapp/base.json
```

### 3. 添加生成命令

在应用的 `package.json` 中加入：

```json
{
  "scripts": {
    "download-swagger": "xapiforge-fetch",
    "generate:api": "xapiforge"
  }
}
```

下载并生成：

```bash
pnpm download-swagger
pnpm generate:api myapp
```

生成结果：

```text
src/api/gen/myapp/
├── index.ts
├── api-types.ts
├── manifest.json
└── types/
    └── base.ts
```

`index.ts` 会导出 `createMyappClient`。生成目录可以加入 Git，也可以在 CI 或构建前重新生成；团队应选择一种方式并保持一致。

提交生成产物的团队应在 CI 增加只读漂移检查：

```bash
pnpm run generate:api -- --check
```

### 4. 初始化客户端

创建 `src/api.ts`：

```typescript
import { AuthService } from "@xapiforge/core";
import { localStorageStore } from "@xapiforge/adapter-browser";
import { createMyappClient } from "./api/gen/myapp/index.js";

const BASE_URL = "http://localhost:7001";

const authService = new AuthService({
  tokenStore: localStorageStore("myapp_access_token"),
  authRefresher: {
    async refresh() {
      // 最小示例尚未接入刷新端点。生产项目在下文实现真正的刷新逻辑。
      throw new Error("token refresh is not configured");
    }
  },
  onAuthFailed() {
    // 生产项目通常在这里跳转登录页。
  }
});

export const api = createMyappClient({
  baseURL: BASE_URL,
  authService
});
```

如果接口不需要鉴权，TokenStore 中保持为空即可；客户端不会添加 `Authorization`。生成客户端仍要求传入 `AuthService`，以保证需要鉴权时可以直接启用同一套行为。

浏览器 adapter 还提供 `sessionStorageStore` 和 `cookieStore`。`cookieStore` 创建的是 JavaScript 可读 cookie，不能设置 HttpOnly，也不会自动添加 Secure / SameSite；需要服务端会话安全属性时，应由后端通过 `Set-Cookie` 管理，不要用它代替。

### 5. 发出第一个强类型请求

在 Vue 组件中直接使用：

```vue
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "./api";

const result = ref("loading");

onMounted(async () => {
  const { data } = await api.base.GET("/api/health");
  result.value = JSON.stringify(data);
});
</script>

<template>
  <pre>{{ result }}</pre>
</template>
```

这里的 service 名 `base` 和路径 `/api/health` 都来自 swagger.json。路径、参数或请求体写错时，TypeScript 会在构建阶段报错。

到这里，最小接入已经完成。

`GET` 在 HTTP 或网络失败时会抛出 `ApiError` / `NetworkError`，生产页面应在加载状态之外补上 `try/catch`、用户可读提示和重试入口，详见[错误处理](../guides/error-handling.md)。

同一应用接入多个 service、配置独立运行时地址或处理同名 schema 时，继续阅读 [genapi v2 多服务接入](../guides/genapi-v2.md)。从旧生成契约升级时使用 [v2 迁移清单](../guides/genapi-v2-migration.md)。

## 生产环境增强

### 登录后保存 Token

登录端点本身不要通过生成客户端调用。生成客户端包含鉴权和 401 刷新 middleware，登录或刷新再次经过它可能造成递归。

使用纯 HTTP 的 `HttpClient`：

```typescript
import { HttpClient } from "@xapiforge/core";

const http = new HttpClient({ baseURL: "http://localhost:7001" });

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
}

export async function login(username: string, password: string): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "web_app",
    scope: "openid profile offline_access",
    username,
    password
  }).toString();

  const response = await http.request({
    method: "POST",
    path: "/oauth/token",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    throw new Error(`login failed: HTTP ${response.status}`);
  }

  const token = JSON.parse(response.bodyText) as TokenResponse;
  localStorage.setItem("myapp_access_token", token.access_token);
  if (token.refresh_token) {
    localStorage.setItem("myapp_refresh_token", token.refresh_token);
  }
}
```

端点、`client_id`、scope 和响应字段必须以实际后端协议为准，不要直接照抄示例值。

### 配置 Token 刷新

把最小示例中的 `authRefresher` 替换为真实刷新实现：

```typescript
const authService = new AuthService({
  tokenStore: localStorageStore("myapp_access_token"),
  authRefresher: {
    async refresh() {
      const refreshToken = localStorage.getItem("myapp_refresh_token");
      if (!refreshToken) throw new Error("refresh token is missing");

      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "web_app",
        refresh_token: refreshToken
      }).toString();

      const response = await http.request({
        method: "POST",
        path: "/oauth/token",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!response.ok) throw new Error(`refresh failed: HTTP ${response.status}`);

      const token = JSON.parse(response.bodyText) as TokenResponse;
      if (token.refresh_token) {
        localStorage.setItem("myapp_refresh_token", token.refresh_token);
      }
      return token.access_token;
    }
  },
  onAuthFailed() {
    void router.push("/login");
  }
});
```

并发请求同时遇到 401 时，`AuthService` 会把刷新合并为一次；其他请求等待同一个刷新结果。具体行为见[鉴权详解](../guides/auth.md)。

### 添加业务 middleware

只有后端使用 HTTP 状态码以外的业务 envelope 时才需要额外 middleware。下面是通用示例，不属于 xapiforge 内核协议：

```typescript
import { RetryableError } from "@xapiforge/core";
import type { Middleware } from "@xapiforge/core";

interface Envelope<T = unknown> {
  code: number;
  data: T;
  message?: string;
}

export function createEnvelopeMiddleware(authCodes: number[] = []): Middleware {
  const authCodeSet = new Set(authCodes);
  return {
    async onResponse({ response }) {
      if (!response.ok) return response;
      if (!(response.headers.get("Content-Type") ?? "").includes("application/json")) {
        return response;
      }

      const text = await response.clone().text();
      if (!text) return response;

      const payload = JSON.parse(text) as Partial<Envelope>;
      if (typeof payload.code !== "number") return response;
      if (payload.code === 0) {
        return new Response(JSON.stringify(payload.data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
      if (authCodeSet.has(payload.code)) {
        throw new RetryableError(`authentication code ${payload.code}`, {
          needsRefresh: true
        });
      }
      throw new Error(payload.message ?? `business error ${payload.code}`);
    }
  };
}
```

初始化时传入：

```typescript
export const api = createMyappClient({
  baseURL: BASE_URL,
  authService,
  middleware: [createEnvelopeMiddleware([40101])],
  maxRetries: 3
});
```

后端协议差异应由业务项目通过 middleware 或 genapi hooks 适配，不应写进通用内核。

## 常见问题

### xapiforge 或 xapiforge-fetch 找不到

确认开发依赖已经安装：

```bash
pnpm add -D @xapiforge/genapi
```

通过 `package.json` scripts 调用，不要依赖全局安装。

### pnpm 报 ERR_PNPM_IGNORED_BUILDS

pnpm 的严格供应链配置可能阻止 `esbuild` 安装脚本。确认依赖来源后执行：

```bash
pnpm approve-builds esbuild
pnpm install
```

### offline 模式提示 swagger 文件缺失

检查目录是否符合：

```text
<outputDir>/<project.name>/<service.name>.json
```

默认就是：

```text
swagger/myapp/base.json
```

### 生成成功，但 TypeScript 找不到路径

先确认该 path 确实存在于对应 swagger.json，再重新执行：

```bash
pnpm generate:api myapp
```

不要手工修改生成文件。

## 完整示例与后续阅读

仓库中的 `examples/demo-app` 展示了登录、刷新、多客户端、业务 middleware 和文件下载。

- [鉴权详解](../guides/auth.md)
- [自定义 middleware](../guides/middleware.md)
- [genapi hooks](../guides/genapi-hooks.md)
- [文件下载](../guides/file-download.md)
- [错误处理](../guides/error-handling.md)
