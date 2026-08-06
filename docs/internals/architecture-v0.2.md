# @xapiforge/core v0.2 架构设计

> **状态**：设计稿（2026-07-31）
> **历史说明**：本文保留 v0.2 当时的设计基线。当前错误契约已改为 data-or-throw、`ApiError` 与 `validateStatus`；以 [错误处理指南](../guides/error-handling.md) 和 [行为合同](./behavior-contract.md) 为准。
> **决策基线**：库边界=纯 HTTP 客户端；openapi-fetch 保留；HttpClient 独立；BizError 删除；refresh 独立 AuthService；工厂模式无全局单例；破坏式重写
> **设计原则**：
>
> 1. **库 vs 使用端边界严格**：库只管 HTTP + 鉴权状态机 + 错误传播；envelope / 业务错误 / BizError 归使用端
> 2. **逻辑严谨**：所有路径行为一致，无双路径分叉
> 3. **可扩展性**：新后端协议通过 middleware 接入，不改库代码
>
> **补充文档**：三层分工与 fetch 注入链路详见 [layered-architecture.md](./layered-architecture.md)

---

## 1. 分层架构

```text
┌────────────────── 使用端（业务代码 / genapi 产物）──────────────────┐
│                                                                     │
│  AuthApi（login/refresh）—— 用 HttpClient 裸调，不走 middleware      │
│  业务 middleware：createAbpUnwrapMw / createWechatErrcodeMw         │
│  BizError 类型（业务侧定义，库不提供）                                │
│  AuthService 配置（TokenStore 实例 + AuthRefresher 实现）             │
│                                                                     │
└─────────────────────────────────┬───────────────────────────────────┘
                                  │
┌─────────────────────────────────┴───────────────────────────────────┐
│                @xapiforge/core 库（本库）                               │
│                                                                     │
│  ┌─────────────── 业务主入口 ───────────────┐                       │
│  │  createNet<paths>(config)                │                       │
│  │   ├─ 内部 = openapi-fetch createClient   │                       │
│  │   ├─ 注入 createAuthMiddleware           │                       │
│  │   ├─ 注入业务 middleware（envelope 解包） │                       │
│  │   └─ 包装方法 + retry loop（catch Retry）│                       │
│  └───────────────────┬──────────────────────┘                       │
│                      │                                              │
│      ┌───────────────┼───────────────────┐                          │
│      ▼               ▼                   ▼                          │
│  ┌────────┐    ┌──────────┐    ┌──────────────────┐                 │
│  │ Http   │    │ Auth     │    │  Middleware       │                 │
│  │ Client │    │ Service  │    │  - authMw         │                 │
│  │        │    │          │    │  - retryMw        │                 │
│  │ fetch  │    │ getToken │    │  - httpErrorMw    │                 │
│  │ timeout│    │ refresh  │    │  - 业务侧自定义    │                 │
│  │ abort  │    │ 单飞+窗口 │    │                   │                 │
│  │ 无 mw  │    │ onFail   │    │  错误类型          │                 │
│  └────────┘    └──────────┘    │  AuthError        │                 │
│      ▲             ▲           │  NetworkError     │                 │
│      │             │           │  RetryableError   │                 │
│      │             │           │  （BizError 删）   │                 │
│      │             │           └──────────────────┘                 │
│      │             │                                                │
│      │     ┌───────┴────────┐                                       │
│      └─────┤ TokenStore     │ ← adapter 包实现                       │
│            │ AuthRefresher  │ ← 业务侧实现                           │
│            └────────────────┘                                       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────┴───────────────────────────────────┐
│                      adapter 包（不变）                              │
│  adapter-browser: localStorageStore                              │
│  adapter-capacitor: SecureStorageStore                           │
│  adapter-react-native: KeychainStore                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心组件 API

### 2.1 HttpClient（纯 HTTP，无 envelope，无 auth）

**职责**：fetch 封装、超时、abort、重定向。**不**管 middleware、**不**管 auth、**不**管 envelope。

**用途**：AuthApi 调 `/connect/token`、文件下载、非 OpenAPI 端点。

```ts
export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string; // text() 读出来，方便 middleware 解析
  blob?: Blob; // responseType: "blob" 时填充
}

export interface RequestOptions {
  method: HttpMethod;
  path: string; // 可以含 {param} 占位，由调用方自己填好
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown; // object → JSON.stringify；string/FormData/Blob 直传
  responseType?: "text" | "json" | "blob"; // 默认 "text"
  timeoutMs?: number;
  signal?: AbortSignal; // 用户主动 abort
}

export class HttpClient {
  constructor(config: { baseURL?: string; defaultTimeoutMs?: number });
  request(opts: RequestOptions): Promise<HttpResponse>;
}
```

**设计要点**：

- `bodyText` 永远读出来（text()），middleware 不用再 await res.text()
- `responseType: "blob"` 时调 res.blob()，bodyText 不填
- 不走任何 middleware，纯粹 HTTP

---

### 2.2 AuthService（鉴权状态机，独立于请求流程）

**职责**：token 存取 + 单飞 refresh + 窗口保护 + 超时 + onAuthFailed 回调。

**关键设计**：refresh 是独立状态机，不依赖 HttpClient / createNet。

```ts
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface AuthRefresher {
  /** 业务侧实现：调 /connect/token，返回新 access_token */
  refresh(): Promise<string>;
}

export interface AuthServiceConfig {
  tokenStore: TokenStore;
  authRefresher: AuthRefresher;
  onAuthFailed: () => void; // refresh 失败 / token 失效不可恢复时调
  refreshWindowMs?: number; // 默认 30_000：窗口内已 refresh → 直接返回上次 token
  refreshTimeoutMs?: number; // 默认 10_000：refresh 超时
  logger?: Logger;
}

export class AuthService {
  constructor(config: AuthServiceConfig);

  /** 拿当前 token（不触发 refresh） */
  getToken(): Promise<string | null>;

  /**
   * 单飞 refresh：如果已经有 refresh 在飞，等它；否则发起 refresh。
   * 窗口保护：refreshWindowMs 内已 refresh 成功过 → 直接返回上次 token，不再 refresh。
   *
   * @returns 新 access_token
   * @throws AuthError refresh 失败 / 超时
   */
  refreshIfNeeded(): Promise<string>;

  /** 强制 refresh（绕过窗口保护，但仍单飞） */
  refresh(): Promise<string>;

  clearToken(): Promise<void>;
}
```

**单飞 + 窗口保护实现逻辑**（伪代码，详见代码注解）：

```text
refreshIfNeeded():
  if (now - lastRefreshAt < refreshWindowMs):
    return lastToken  # 窗口内，直接返回
  if (inFlightPromise):
    return inFlightPromise  # 已有 refresh 在飞，等它
  # 发起 refresh
  inFlightPromise = (async () => {
    try:
      token = await withTimeout(authRefresher.refresh(), refreshTimeoutMs)
      await tokenStore.set(token)
      lastRefreshAt = now
      lastToken = token
      return token
    catch e:
      onAuthFailed()  # 通知业务侧跳登录
      throw new AuthError("refresh failed", { cause: e })
    finally:
      inFlightPromise = null
  })()
  return inFlightPromise
```

---

### 2.3 createNet<paths>（业务主入口，封装 openapi-fetch）

**职责**：创建强类型业务 client，内部注入 auth middleware + 业务 middleware，包装方法加 retry loop。

```ts
import type { Middleware } from "openapi-fetch";

export interface NetConfig {
  baseURL: string;
  authService: AuthService;
  middleware?: Middleware[]; // 业务侧 envelope 解包 / 业务错误判定
  defaultTimeoutMs?: number;
  logger?: Logger;
}

/**
 * 创建业务 client（强类型，封装 openapi-fetch）。
 *
 * 内部流程：
 * 1. openapi-fetch createClient<paths>({ baseUrl })
 * 2. 注入 createAuthMiddleware(authService) 到 middleware 链最前
 * 3. 注入业务 middleware（config.middleware）
 * 4. 包装 GET/POST/PUT/DELETE/PATCH/request 方法，加 retry loop：
 *    - catch RetryableError → 重发原请求（最多 1 次）
 *    - 其他错误直接抛
 *
 * @example
 * const api = createNet<AppPaths>({
 *   baseURL: "http://localhost:8787",
 *   authService,
 *   middleware: [createAbpUnwrapMw()],
 * });
 * const user = await api.GET("/api/identity/users/{id}", { params: { path: { id: "u-001" } } });
 */
export function createNet<paths>(config: NetConfig): NetClient<paths>;

// NetClient<paths> = openapi-fetch client 的方法签名 + retry 包装
//   api.GET / api.POST / api.PUT / api.DELETE / api.PATCH（强类型）
//   api.request(method, path, opts)（也强类型）
```

**Retry 机制设计**：

```text
api.GET(path, opts) 内部流程：
  for i in 0..1:
    try:
      result = await client.GET(path, opts)  # 走完整 middleware 链
      return result
    catch e:
      if e instanceof RetryableError and i < 1:
        continue  # 重发（新 token 已在 authService 里，下次请求自动带上）
      throw e
```

**为什么 RetryableError 由 createNet catch，而不是 middleware 自己重发？**

- middleware 自己重发绕过 middleware 链，后续 middleware（如 envelope 解包）不会执行
- createNet catch 后重发，会走完整 middleware 链，保证一致性

---

### 2.4 错误类型（库只提供这 3 个）

```ts
/** refresh 失败 / token 失效不可恢复 */
export class AuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
  }
}

/** fetch 失败 / 超时 / abort / HTTP 5xx */
export class NetworkError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts);
    this.name = "NetworkError";
    this.status = opts?.status;
  }
}

/**
 * 可重试错误（库内部信号，业务侧一般不直接 catch）。
 *
 * 抛出场景：
 * - createAuthMiddleware：401 → refresh 成功 → 抛 RetryableError（让 createNet 重发）
 * - createRetryMiddleware：429 → 抛 RetryableError（让 createNet 退避重发）
 *
 * createNet 内部 catch RetryableError → 重发原请求。
 * 业务侧看到的是最终结果（成功）或 AuthError/NetworkError。
 */
export class RetryableError extends Error {
  readonly retryAfterMs?: number; // 429 场景，从 Retry-After header 读
  constructor(message: string, opts?: { retryAfterMs?: number; cause?: unknown }) {
    super(message, opts);
    this.name = "RetryableError";
  }
}
```

**BizError 删除**：业务错误归业务侧 middleware，业务侧自己定义 BizError（如 `AbpBizError`）。

---

### 2.5 官方 Middleware（库提供，业务侧可选）

#### createAuthMiddleware(authService)

```ts
export function createAuthMiddleware(authService: AuthService): Middleware;
```

**职责**：

- `onRequest`：从 authService.getToken() 拿 token，注入 `Authorization: Bearer xxx`
- `onResponse`：HTTP 401 → 调 authService.refreshIfNeeded()
  - refresh 成功 → 抛 `RetryableError("auth retry needed")`（createNet catch 后重发）
  - refresh 失败 → 抛 `AuthError`（authService 已调 onAuthFailed）

**关键注解**：

```ts
// onRequest: 注入 token
async onRequest({ request }) {
  const token = await authService.getToken();
  if (token) {
    request.headers.set("Authorization", `Bearer ${token}`);
  }
  return request;
}

// onResponse: 401 处理
async onResponse({ request, response }) {
  if (response.status !== 401) return response;

  // 401 → 单飞 refresh（窗口保护在 authService 内部）
  try {
    await authService.refreshIfNeeded();
    // refresh 成功 → 抛 RetryableError，让 createNet 重发
    // 新 token 会在重发时由 onRequest 重新注入
    throw new RetryableError("auth retry needed");
  } catch (e) {
    if (e instanceof RetryableError) throw e;
    // refresh 失败 → AuthError（authService 已调 onAuthFailed）
    throw new AuthError("token refresh failed", { cause: e });
  }
}
```

#### createRetryMiddleware(opts)

```ts
export interface RetryMiddlewareConfig {
  maxRetries?: number; // 默认 3
  retryOnStatus?: number[]; // 默认 [429]
  retryDelayMs?: number | ((attempt: number, retryAfterMs?: number) => number);
}

export function createRetryMiddleware(config?: RetryMiddlewareConfig): Middleware;
```

**职责**：onResponse 收到 429 → 读 `Retry-After` header → 抛 `RetryableError({ retryAfterMs })`。

createNet catch RetryableError 后重发，但 createNet 默认只重发 1 次（auth retry 用）。**429 退避需要多次重试**，这个由 createRetryMiddleware 自己管计数器？

**设计选择**：createNet 的 retry loop 只处理 auth retry（1 次）。429 多次重试由 createRetryMiddleware 内部循环（不依赖 createNet retry）。

但 middleware 不能重发（前面说过）。所以 429 重试只能：

- (a) createNet retry loop 扩展为 maxRetries（可配置）
- (b) createRetryMiddleware 内部循环重发（绕过 middleware 链，但只针对 429）

**选 (a)**：createNet 的 retry loop 配置 `maxRetries`（默认 1，auth 用；429 场景配 3）。retryDelayMs 由 RetryableError.retryAfterMs 传递。

```ts
export interface NetConfig {
  // ...
  maxRetries?: number; // 默认 1（auth retry）
  retryDelayMs?: (attempt: number, retryAfterMs?: number) => number;
}
```

#### createHttpErrorMiddleware()

```ts
export function createHttpErrorMiddleware(config?: {
  fatalStatuses?: number[]; // 默认 [500, 502, 503, 504]
}): Middleware;
```

**v0.2 当时的职责**：onResponse 收到 5xx → 抛 `NetworkError({ status })`（当前已由最终 `validateStatus` 校验并抛 `ApiError` 取代）。

---

## 3. 使用端代码示例

### 3.1 demo-app main.ts（重构后）

```ts
import { createNet, AuthService, HttpClient, createAuthMiddleware } from "@xapiforge/core";
import { localStorageStore } from "@xapiforge/adapter-browser";
import { createAbpUnwrapMw } from "@xapiforge/core-mw-abp"; // 假设的官方 middleware 包
import type { paths as AppPaths } from "./api/demo/types/base.js";

// 1. HttpClient（给 AuthApi 用，不走 middleware 链）
const http = new HttpClient({ baseURL: "http://localhost:8787" });

// 2. AuthService（鉴权状态机）
const auth = new AuthService({
  tokenStore: localStorageStore("app_token"),
  authRefresher: {
    refresh: async () => {
      // 用 http 裸调 /connect/token（不走 middleware）
      const res = await http.request({
        method: "POST",
        path: "/connect/token",
        body: "grant_type=refresh_token&refresh_token=xxx",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      const oauth = JSON.parse(res.bodyText);
      return oauth.access_token;
    }
  },
  onAuthFailed: () => router.push("/login"),
  refreshWindowMs: 30_000
});

// 3. 业务 client（强类型 + middleware）
const api = createNet<AppPaths>({
  baseURL: "http://localhost:8787",
  authService: auth,
  middleware: [createAbpUnwrapMw()]
});

// 4. 业务调用
const user = await api.GET("/api/identity/users/{id}", { params: { path: { id: "u-001" } } });
```

### 3.2 业务 middleware 示例（ABP envelope 解包）

```ts
// 业务侧自己写，或装 @xapiforge/core-mw-abp 包
export class AbpBizError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
    this.name = "AbpBizError";
  }
}

export function createAbpUnwrapMw(): Middleware {
  return {
    async onResponse({ response }) {
      // 401/403 不解包，交给 authMiddleware
      if (response.status === 401 || response.status === 403) return response;

      const text = await response.clone().text();
      if (!text) return response;

      try {
        const envelope = JSON.parse(text);
        if (envelope && typeof envelope.code === "number") {
          if (envelope.code !== 0) {
            // 业务错误 → 抛 AbpBizError（业务侧定义）
            throw new AbpBizError(envelope.code, envelope.msg ?? "业务错误");
          }
          // 成功 → 替换 body 为 unwrapped data
          return new Response(JSON.stringify(envelope.data), {
            status: response.status,
            headers: response.headers
          });
        }
      } catch (e) {
        if (e instanceof AbpBizError) throw e;
        // JSON parse 失败，原样返回
      }
      return response;
    }
  };
}
```

### 3.3 业务侧错误 catch 模式

```ts
try {
  const user = await api.GET("/api/identity/users/{id}", { params: { path: { id } } });
} catch (e) {
  if (e instanceof AuthError) {
    // 已被 onAuthFailed 处理（跳登录），这里一般不 catch
  } else if (e instanceof NetworkError) {
    toast.error("网络错误，请稍后重试");
  } else if (e instanceof AbpBizError) {
    toast.error(e.message); // 业务错误，显示后端 msg
  } else {
    toast.error("未知错误");
  }
}
```

---

## 4. 场景覆盖矩阵

### 4.1 Layer A 协议覆盖（22 类）

| 协议                             | envelope 形状                            | 新架构覆盖方式                                       | 覆盖 |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------- | ---- |
| A1 ABP                           | `{code, data, msg}`                      | 业务 middleware `createAbpUnwrapMw`                  | ✅   |
| A2 Spring Boot                   | `{code, message, data}`                  | 业务 middleware（类似 ABP）                          | ✅   |
| A3 OAuth2 token endpoint         | `{error, error_description}`             | HttpClient 裸调（AuthApi 自己解析）                  | ✅   |
| A4 RFC 7807                      | `{type, title, status, detail}`          | 业务 middleware                                      | ✅   |
| A5 企业微信                      | `{errcode, errmsg}`                      | 业务 middleware `createWechatErrcodeMw`              | ✅   |
| A6 微信小程序 errcode 200        | `{errcode, errmsg}` HTTP 200             | 业务 middleware（HTTP 200 + errcode 判定）           | ✅   |
| A7 支付宝                        | `{code, msg, sub_code}`                  | 业务 middleware                                      | ✅   |
| A8 GraphQL                       | `{data, errors[]}`                       | 业务 middleware                                      | ✅   |
| A9 gRPC-Web                      | `{}` / `{code, message}`                 | 业务 middleware                                      | ✅   |
| A10 JSON-RPC                     | `{jsonrpc, result}` / `{jsonrpc, error}` | 业务 middleware                                      | ✅   |
| A11 HAL / JSON:API               | `{data, links, meta}`                    | 业务 middleware                                      | ✅   |
| A12 嵌套 envelope                | `{status, result}`                       | 业务 middleware                                      | ✅   |
| A13 array root                   | `[{...}]`                                | 业务 middleware（identity）                          | ✅   |
| A14 业务 200 鉴权码              | `{code: 40001}` HTTP 200                 | 业务 middleware 检测 code → 抛 RetryableError        | ✅   |
| A15 success bool                 | `{success: true, data}`                  | 业务 middleware                                      | ✅   |
| A16 HTTP 401/403/419/440/498/499 | 各种                                     | createAuthMiddleware（401）+ 业务 middleware（其他） | ✅   |
| A17 429 + Retry-After            | envelope + header                        | createRetryMiddleware                                | ✅   |
| A18 5xx + HTML（v0.2 历史行为）  | `<html>...`                              | createHttpErrorMiddleware → NetworkError             | ✅   |
| A19 5xx + JSON envelope          | `{code: 500, msg}`                       | createHttpErrorMiddleware + 业务 middleware          | ✅   |
| A20 503 k8s                      | `{message}`                              | createHttpErrorMiddleware                            | ✅   |
| A21 204 No Content               | `""`                                     | HttpClient（bodyText=""）                            | ✅   |
| A22 200 + empty body             | `""`                                     | HttpClient（bodyText=""）                            | ✅   |

### 4.2 Layer B 网络层覆盖（28 类）

| 场景                                 | 新架构覆盖                                | 覆盖 |
| ------------------------------------ | ----------------------------------------- | ---- |
| B1-B6 CORS/HTTPS/DNS/TCP/close/abort | HttpClient fetch 抛错 → NetworkError      | ✅   |
| B7 timeout                           | HttpClient AbortController → NetworkError | ✅   |
| B8 用户 abort                        | HttpClient signal → NetworkError          | ✅   |
| B9-B28 其他边角                      | HttpClient / middleware 覆盖              | ✅   |

### 4.3 Layer C envelope 变体（10 类）

全部由业务 middleware 覆盖。库不预设 envelope 形状，业务侧按需写 middleware。

### 4.4 Layer D 鉴权场景（18 类）

| 场景                           | 新架构覆盖                                  | 覆盖 |
| ------------------------------ | ------------------------------------------- | ---- |
| D1 首次请求带 token            | createAuthMiddleware onRequest 注入         | ✅   |
| D2 无 token 请求               | createAuthMiddleware 跳过注入               | ✅   |
| D3 401 → refresh → 重试        | createAuthMiddleware + createNet retry loop | ✅   |
| D4 refresh 并发单飞            | AuthService.refreshIfNeeded 单飞            | ✅   |
| D5 refresh 窗口保护            | AuthService.refreshWindowMs                 | ✅   |
| D6 refresh 超时                | AuthService.refreshTimeoutMs                | ✅   |
| D7 refresh 失败 → onAuthFailed | AuthService onAuthFailed                    | ✅   |
| D8 死循环防护                  | refreshWindowMs + createNet maxRetries=1    | ✅   |
| D9-D18 其他鉴权场景            | AuthService + createAuthMiddleware          | ✅   |

### 4.5 Layer E/F（生命周期 / 错误传播）

全部由新架构覆盖。无全局单例 → 生命周期由业务侧管理。错误类型只有 3 个 → 传播路径清晰。

---

## 5. 文件变更清单

### 5.1 新建文件

| 文件                                            | 内容                                                  |
| ----------------------------------------------- | ----------------------------------------------------- |
| `packages/core/src/http-client.ts`              | HttpClient 类                                         |
| `packages/core/src/auth-service.ts`             | AuthService 类（含单飞 + 窗口保护，详细注解）         |
| `packages/core/src/errors.ts`                   | AuthError / NetworkError / RetryableError（覆盖现有） |
| `packages/core/src/middleware/auth-mw.ts`       | createAuthMiddleware                                  |
| `packages/core/src/middleware/retry-mw.ts`      | createRetryMiddleware                                 |
| `packages/core/src/middleware/http-error-mw.ts` | createHttpErrorMiddleware                             |
| `packages/core/src/middleware/index.ts`         | re-export                                             |
| `packages/core/src/create-net.ts`               | createNet<paths> 工厂函数                             |
| `packages/core/src/types.ts`                    | 覆盖现有，只留新类型                                  |

### 5.2 删除文件

| 文件                                  | 原因                                             |
| ------------------------------------- | ------------------------------------------------ |
| `packages/core/src/setup.ts`          | 全局单例 + envelope 混合 → 删除                  |
| `packages/core/src/client.ts`         | rawFetch 逻辑迁移到 HttpClient                   |
| `packages/core/src/auth.ts`           | token 注入迁移到 createAuthMiddleware            |
| `packages/core/src/refresh.ts`        | TokenRefresher 迁移到 AuthService                |
| `packages/core/src/biz-error.ts`      | BizError 删除（归业务侧）                        |
| `packages/core/src/biz-helpers.ts`    | createUnwrapResponseMw 删除（归业务 middleware） |
| `packages/core/src/guard-helpers.ts`  | guard / unwrapResponse 删除（归业务 middleware） |
| `packages/core/src/openapi-bridge.ts` | createNetMiddleware 删除（被 createNet 替代）    |

### 5.3 修改文件

| 文件                          | 变更                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `packages/core/src/index.ts`  | 全新导出：HttpClient / AuthService / createNet / middleware / errors |
| `packages/core/package.json`  | 版本升 0.2.0                                                         |
| `packages/core/tsconfig.json` | 可能需要加 `composite: true`（如果新文件多）                         |

### 5.4 使用端变更

| 文件                                        | 变更                                             |
| ------------------------------------------- | ------------------------------------------------ |
| `examples/demo-app/src/main.ts`             | 重写：HttpClient + AuthService + createNet       |
| `examples/demo-app/src/AuthApi.ts`          | 重写：用 HttpClient 裸调                         |
| `examples/demo-app/src/components/Home.vue` | 改 catch 模式（AbpBizError）                     |
| `examples/demo-app/src/api/`                | genapi 产物不变（openapi-fetch client 仍可用）   |
| `examples/react-app/` 等其他 example        | 同步改造（占位 examples 已删，接入新项目时新建） |
| `examples/mock-server/`                     | 可能加新协议端点（企业微信 / GraphQL 等）        |

---

## 6. 关键设计决策

### 6.1 为什么 refresh 独立成 AuthService？

**当前问题**：refresh 逻辑分散在 setup.ts（TokenRefresher）和 openapi-bridge.ts（闭包 refreshing），两处实现不一致。

**新设计**：refresh 是「鉴权状态机」的一部分，不是「请求流程」的一部分。AuthService 独立持有：

- tokenStore（token 存取）
- authRefresher（业务侧实现的 refresh 逻辑）
- 单飞 promise（防并发）
- 窗口时间戳（防死循环）
- onAuthFailed 回调（通知业务侧）

请求流程（createAuthMiddleware）只调 `authService.getToken()` / `authService.refreshIfNeeded()`，不知道 refresh 怎么实现。

**好处**：

- 单一职责：AuthService 只管鉴权状态
- 可测试：AuthService 可独立单测
- 可复用：多个 client 共享同一 AuthService（Demo + weather 共用一个 auth）

### 6.2 为什么 RetryableError 由 createNet catch，而不是 middleware 自己重发？

**问题**：middleware 的 onResponse 拿到 Response，要重发必须 `fetch(request.clone())`，但：

- 重发绕过 middleware 链，后续 middleware（envelope 解包）不执行
- body 如果是 stream，clone 失败

**新设计**：

- createAuthMiddleware refresh 成功后抛 `RetryableError`
- createRetryMiddleware 429 时抛 `RetryableError({ retryAfterMs })`
- createNet 的 retry loop catch RetryableError → 重发原请求（走完整 middleware 链）

**好处**：

- 重发走完整 middleware 链，行为一致
- middleware 只管判定，不管重发（单一职责）
- retry 计数集中在一处（createNet），可配置

### 6.3 为什么删除 guard / unwrapResponse / isBizError？

**当前问题**：四种表达业务协议的方式（guard / unwrapResponse / isBizError / isAuthError），关系混乱：

- guard 提供时其他被忽略
- isBizError 类型上必填但语义重叠
- 业务侧不知道该写哪个

**新设计**：统一用 middleware 链表达业务协议：

- envelope 解包 → middleware 的 onResponse（替换 response.body）
- 业务错误判定 → middleware 的 onResponse（抛业务错误）
- 鉴权判定 → createAuthMiddleware（HTTP 401）

**好处**：

- 一种机制（middleware），一种表达方式
- 顺序明确：onRequest 正序，onResponse 反序
- 可组合：ABP + retry + auth 三个 middleware 独立

### 6.4 为什么删除 BizError？

**当前问题**：BizError 是库提供的业务错误类型，但 27 类协议的业务错误形态各异（code 是 number / string / boolean，msg 字段名不同），库无法统一。

**新设计**：BizError 归业务侧：

- 业务侧自己定义（如 `AbpBizError extends Error`）
- 或装官方 middleware 包（`@xapiforge/core-mw-abp` 提供 `AbpBizError` + `createAbpUnwrapMw`）

**好处**：

- 库不预设业务错误形态
- 业务侧有完全控制权
- 库的错误类型只有 3 个（Auth/Network/Retryable），语义清晰

### 6.5 为什么用工厂模式，不用全局单例？

**当前问题**：`net.setup()` 全局单例 + 模块级 `let state`：

- 多客户端场景别扭（demo-app 的 weather client 跑错 unwrap）
- SSR / 测试场景全局状态污染
- 「框架无关」名不副实

**新设计**：`createNet<paths>(config)` 返回独立 client 实例：

- 业务侧自己持有多份（Demo client + weather client）
- 无全局状态，SSR 友好
- 测试隔离好（每个 test 创建独立 client）

**好处**：

- 真正框架无关
- 多客户端天然支持
- 符合「无全局状态」的工程实践

---

## 7. 与 v0.1 的差异对照

| 维度             | v0.1                                 | v0.2                                   |
| ---------------- | ------------------------------------ | -------------------------------------- |
| 库边界           | HTTP + envelope 混合                 | 纯 HTTP + 鉴权状态机                   |
| 实例模型         | 全局单例 `net.setup()`               | 工厂 `createNet<paths>()`              |
| 路径             | 双路径（net.request + bridge）       | 单路径（createNet 包装 openapi-fetch） |
| refresh          | setup.ts + bridge 两处               | AuthService 独立                       |
| 协议表达         | guard / unwrap / isBiz / isAuth 四种 | middleware 链一种                      |
| 错误类型         | Auth/Biz/Network                     | Auth/Network/Retryable（Biz 删）       |
| openapi-fetch    | bridge 接入                          | createNet 内部封装                     |
| AuthApi          | 绕过 net                             | 用 HttpClient 裸调                     |
| 文件下载         | 不支持（rawFetch 永远 text）         | HttpClient responseType: "blob"        |
| 429 retry        | 不支持                               | createRetryMiddleware                  |
| refresh 窗口保护 | 不支持                               | AuthService.refreshWindowMs            |
| 全局状态         | 模块级 let state                     | 无                                     |

---

## 8. 验证清单

实现完成后，逐项验证：

### 8.1 协议覆盖验证

- [ ] A1 ABP：createAbpUnwrapMw 解包 `{code, data, msg}`
- [ ] A3 OAuth2：HttpClient 裸调 `/connect/token`
- [ ] A6 微信小程序 errcode 200：业务 middleware 检测
- [ ] A14 业务 200 鉴权码：业务 middleware 抛 RetryableError
- [ ] A17 429 + Retry-After：createRetryMiddleware 退避
- [ ] A21 204 No Content：HttpClient bodyText=""
- [ ] A18 5xx + HTML（v0.2 历史行为）：createHttpErrorMiddleware → NetworkError

### 8.2 鉴权场景验证

- [ ] D3 401 → refresh → 重试：createAuthMiddleware + createNet retry
- [ ] D4 refresh 并发单飞：AuthService 单飞
- [ ] D5 refresh 窗口保护：refreshWindowMs
- [ ] D6 refresh 超时：refreshTimeoutMs
- [ ] D7 refresh 失败 → onAuthFailed
- [ ] D8 死循环防护：窗口 + maxRetries=1

### 8.3 多客户端验证

- [ ] demo-app Demo client + weather client 共存，envelope 不串
- [ ] 多 client 共享同一 AuthService

### 8.4 框架无关验证

- [ ] 框架无关性：demo-app（Vue）已验证，接入 React / Ionic / React Native 时复用同一份 createNet
- [ ] 无全局状态污染（每个 app 独立 client 实例）

### 8.5 错误传播验证

- [ ] AuthError 业务侧能 catch
- [ ] NetworkError 业务侧能 catch
- [ ] RetryableError 业务侧看不到（createNet 内部消化）
- [ ] AbpBizError 业务侧能 catch

---

## 9. 后续迭代方向（v0.3+）

- `@xapiforge/core-mw-abp` 官方 middleware 包（ABP envelope 解包 + AbpBizError）
- `@xapiforge/core-mw-wechat` 官方 middleware 包（企业微信 / 小程序 errcode）
- 文件下载流式响应（responseType: "stream"）
- SSE / NDJSON 支持
- GraphQL 客方 middleware（`createGraphqlMw`）
