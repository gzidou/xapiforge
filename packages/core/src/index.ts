/**
 * @xapiforge/core — 框架无关的公共网络库
 *
 * 架构（v0.2 破坏式重写）：
 *   - 纯 HTTP 客户端（envelope 解包归业务侧 middleware）
 *   - 工厂模式（无全局单例）
 *   - AuthService 独立（refresh 单飞 + 窗口保护 + 超时）
 *   - createNet<paths> 封装 openapi-fetch + data-or-throw + middleware + retry loop
 *
 * 使用示例：
 *
 *   import { createNet, AuthService, HttpClient } from "@xapiforge/core";
 *   import { localStorageStore } from "@xapiforge/adapter-browser";
 *
 *   // 1. HttpClient（给 AuthApi / 文件下载用）
 *   const http = new HttpClient({ baseURL: "http://localhost:8787" });
 *
 *   // 2. AuthService（鉴权状态机）
 *   const auth = new AuthService({
 *     tokenStore: localStorageStore("app_token"),
 *     authRefresher: { refresh: async () => { ... } },
 *     onAuthFailed: () => router.push("/login"),
 *   });
 *
 *   // 3. 业务 client（强类型 + middleware）
 *   const api = createNet<AppPaths>({
 *     baseURL: "http://localhost:8787",
 *     authService: auth,
 *     middleware: [createAbpUnwrapMw()],  // 业务侧 middleware
 *   });
 *
 *   const { data: user, response } = await api.GET("/api/identity/users/{id}", {
 *     params: { path: { id: "u-001" } }
 *   });
 */

// ─── 类型契约 ───
export type {
  TokenStore,
  AuthRefresher,
  Logger,
  FetchLike,
  HttpMethod,
  ResponseType,
  HttpResponse,
  HttpRequestOptions,
  AuthServiceConfig,
  NetConfig,
  NetRequestOptions,
  ValidateStatus,
  ErrorMessageContext,
  ResolveErrorMessage,
  Middleware,
} from "./types.js";
export type { NetClient, NetResponse } from "./net-client.js";

// ─── 统一公开错误 + 内核/专用子类型 ───
export { ApiError, AuthError, NetworkError, RetryableError } from "./errors.js";
export type { ApiErrorKind, ApiErrorOptions, RetryReason } from "./errors.js";

// ─── HttpClient（纯 HTTP，给 AuthApi / 文件下载用）───
export { HttpClient } from "./http-client.js";

// ─── AuthService（鉴权状态机：单飞 + 窗口保护 + 超时）───
export { AuthService } from "./auth-service.js";

// ─── createNet（业务主入口，封装 openapi-fetch + middleware + retry loop）───
export { createNet } from "./create-net.js";

// ─── 官方 middleware ───
export {
  createAuthMiddleware,
  createRetryMiddleware,
  createHttpErrorMiddleware,
} from "./middleware/index.js";
export type { RetryMiddlewareConfig, HttpErrorMiddlewareConfig } from "./middleware/index.js";
