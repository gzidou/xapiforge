/**
 * @xapiforge/core — 公共类型契约
 *
 * 框架无关、0 运行时依赖（openapi-fetch 是 peerDep，不算运行时依赖）。
 *
 * 核心设计：
 *   1. createNet 成功只返回 `{ data, response }`，失败只抛 ApiError。
 *   2. HTTP 成功判定默认使用 response.ok，可由全局或单次请求 validateStatus 覆盖。
 *   3. envelope 解包 / 业务错误判定归业务侧 middleware。
 *   4. 无全局单例，运行时 fetch、鉴权和错误文案解析均可注入。
 */

// 前向声明：AuthService 类实现在 auth-service.ts，这里只引类型避免运行时循环依赖
import type { AuthService } from "./auth-service.js";

/**
 * token 存储抽象。由调用方决定怎么存（localStorage / Capacitor / Keychain）。
 * 库不预设 store 类型（避免第三方依赖）。
 *
 * 实现在 adapter 包：
 *   - @xapiforge/adapter-browser: localStorageStore
 *   - @xapiforge/adapter-capacitor: SecureStorageStore
 *   - @xapiforge/adapter-react-native: KeychainStore
 */
export interface TokenStore {
  get(): string | null | Promise<string | null>;
  set(token: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

/**
 * token 刷新器。由业务侧实现：
 *   - refresh 端点鉴权靠 HTTP-only cookie → 直接 fetch('/auth/refresh')
 *   - refresh token 在 body 里 → 调用方自行从某处取出
 *
 * 业务侧一般用 HttpClient 裸调 refresh 端点（不走 middleware 链，避免循环）：
 *   authRefresher: {
 *     refresh: async () => {
 *       const res = await http.request({ method: "POST", path: "/connect/token", ... });
 *       return JSON.parse(res.bodyText).access_token;
 *     }
 *   }
 *
 * 库只负责「单飞 + 窗口保护 + 超时 + onAuthFailed」。业务侧 retry 自由发挥。
 */
export interface AuthRefresher {
  /** 返回新的 access token。失败抛错即可（库会 catch 转 AuthError）。 */
  refresh(): Promise<string>;
}

/**
 * 日志接口。默认 console。
 * 业务侧可传自定义 logger（如 demo-app 的 logger 模块）。
 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ─────────────────────────────────────────────────────────────────────
// HttpClient 相关类型
// ─────────────────────────────────────────────────────────────────────

/**
 * fetch 函数类型（与 globalThis.fetch 同签名）。
 *
 * 用途：支持运行时注入。业务侧在 Capacitor / Electron 等环境可传自定义 fetch，
 * 走原生 HTTP（绕过 webview CORS / 信任自签证书 / 原生网络栈）。
 *
 * 详见 docs/LAYERED-ARCHITECTURE.md 第 3 节「fetch 注入链路」。
 *
 * @example Capacitor 注入原生 HTTP
 *   import { CapacitorHttp } from "@capacitor/core";
 *   const capacitorFetch: FetchLike = async (input, init) => {
 *     const req = new Request(input, init);
 *     const res = await CapacitorHttp.request({ url: req.url, method: req.method, ... });
 *     return new Response(JSON.stringify(res.data ?? ""), { status: res.status, headers: res.headers });
 *   };
 *   const api = createNet({ baseURL, authService, fetch: capacitorFetch, ... });
 */
export type FetchLike = typeof fetch;

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

/**
 * 响应类型。决定 HttpClient 怎么读 body。
 *   - "text"（默认）→ res.text()，bodyText 有值
 *   - "json"        → res.text()（业务侧自己 JSON.parse），bodyText 有值
 *   - "blob"        → res.blob()，blob 有值（文件下载场景）
 *
 * 注意：不提供 "stream"（v0.3 再加，SSE / NDJSON 场景）。
 */
export type ResponseType = "text" | "json" | "blob";

/**
 * HttpClient 的响应。bodyText 或 blob 二者有其一。
 */
export interface HttpResponse {
  /** HTTP 状态码 */
  readonly status: number;
  /** status >= 200 && status < 300 */
  readonly ok: boolean;
  /** 响应头 */
  readonly headers: Headers;
  /** body 文本（responseType 为 "text" / "json" 时有值） */
  readonly bodyText: string;
  /** body Blob（responseType 为 "blob" 时有值，文件下载场景） */
  readonly blob?: Blob;
}

/**
 * HttpClient.request 的参数。
 *
 * 注意：path 不自动填充 {param} 占位 —— 由调用方自己填好（保持 HttpClient 纯粹）。
 * 业务侧用 createNet 时，openapi-fetch 会自动填 path params。
 */
export interface HttpRequestOptions {
  method: HttpMethod;
  /** URL path（可含 query string，或用 query 参数） */
  path: string;
  /** query string 参数（自动 urlencode） */
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /**
   * request body。三种形式：
   *   1. 普通对象 → JSON.stringify + Content-Type: application/json（默认）
   *   2. string → 原样传（如 urlencoded string）
   *   3. FormData / Blob → 原样传（不自动设 Content-Type，让浏览器加 boundary）
   */
  body?: unknown;
  /** 响应类型，默认 "text" */
  responseType?: ResponseType;
  /** 超时（毫秒），0 = 不设超时 */
  timeoutMs?: number;
  /** 用户主动 abort 信号 */
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────
// AuthService 相关类型
// ─────────────────────────────────────────────────────────────────────

/**
 * AuthService 配置。
 *
 * refreshWindowMs 的设计动机：
 *   防止「refresh 成功 → 重发仍 401 → 再 refresh」死循环。
 *   30s 内已 refresh 成功过 → 直接返回上次 token，不再 refresh。
 *   如果重发仍 401，说明 token 被服务端撤销，onAuthFailed 跳登录。
 *
 * refreshTimeoutMs 的设计动机：
 *   refresh 端点死锁 / 网络断开 → 并发请求永久挂起。
 *   超时抛 AuthError，所有 await refreshIfNeeded 的请求同 reject → onAuthFailed。
 */
export interface AuthServiceConfig {
  tokenStore: TokenStore;
  authRefresher: AuthRefresher;
  /** refresh 失败 / token 失效不可恢复时调用。Vue → router.push，React → navigate */
  onAuthFailed: () => void;
  /** refresh 窗口保护（毫秒），默认 30_000。窗口内已 refresh → 直接返回上次 token */
  refreshWindowMs?: number;
  /** refresh 超时（毫秒），默认 10_000。0 = 不设超时 */
  refreshTimeoutMs?: number;
  logger?: Logger;
}

// ─────────────────────────────────────────────────────────────────────
// createNet 相关类型
// ─────────────────────────────────────────────────────────────────────

/**
 * openapi-fetch 的 Middleware 类型（从 openapi-fetch re-export）。
 * 业务侧写 envelope 解包 middleware 时用这个类型。
 */
import type { Middleware as OpenapiMiddleware } from "openapi-fetch";
export type Middleware = OpenapiMiddleware;

/**
 * 判定最终 HTTP 响应是否应进入成功通道。
 *
 * 调用时机在 401 refresh 与 429 retry 之后，因此普通配置不会破坏内核重试。
 * 默认值是 `(response) => response.ok`。如果某个接口把 404 当正常结果，应在
 * 单次请求中显式接受，并根据 `response.status` 解释对应的 data 类型。
 */
export type ValidateStatus = (response: Response) => boolean;

/** 错误文案解析器收到的、与后端框架无关的上下文。 */
export interface ErrorMessageContext {
  response: Response;
  /** JSON 已解析为对象；非 JSON 保持字符串；空响应为 undefined。 */
  body: unknown;
}

/**
 * 自定义后端错误文案提取器。
 *
 * 返回空字符串或 undefined 时，内核继续尝试通用 message/error.message/detail/title，
 * 最后回退到 `请求失败（HTTP n）`。ABP、Spring Boot 等专有结构应由业务侧实现。
 */
export type ResolveErrorMessage = (context: ErrorMessageContext) => string | undefined;

/**
 * createNet 每次请求额外接受的选项。
 *
 * 这些字段只影响 xapiforge 的最终响应归一化，不会改变 URL、headers 或 body。
 */
export interface NetRequestOptions {
  /** 覆盖 client 级 validateStatus。 */
  validateStatus?: ValidateStatus;
  /** 覆盖 client 级 resolveErrorMessage。 */
  resolveErrorMessage?: ResolveErrorMessage;
}

/**
 * createNet 配置。
 *
 * onResponse 的逻辑顺序：
 *   1. config.middleware（业务 envelope 解包 / 业务错误判定）
 *   2. 429 retry
 *   3. 401 refresh + retry
 *   4. validateStatus + ApiError 归一化
 *
 * 最终归一化必须最后执行，否则第一次 401/429 会提前变成业务可见错误，导致刷新或
 * 重试失效。createNet 负责固定这一顺序，业务侧无需手动注册内核 middleware。
 */
export interface NetConfig {
  baseURL: string;
  authService: AuthService;
  /** 业务侧 middleware（envelope 解包 / 业务错误判定） */
  middleware?: Middleware[];
  /** 全局 HTTP 成功判定；默认 response.ok。单次请求可覆盖。 */
  validateStatus?: ValidateStatus;
  /** 全局错误文案解析器；单次请求可覆盖。 */
  resolveErrorMessage?: ResolveErrorMessage;
  /**
   * 自定义 fetch 实现（默认 globalThis.fetch）。
   *
   * 用于运行时切换：Capacitor 注入 capacitorFetch 走原生 HTTP（绕过 CORS / 信任自签证书）。
   * 详见 docs/LAYERED-ARCHITECTURE.md 第 3 节「fetch 注入链路」。
   */
  fetch?: FetchLike;
  /** 默认请求超时（毫秒），默认 15_000 */
  defaultTimeoutMs?: number;
  /**
   * 最大重试次数（不含首次请求）。
   *   - 0 = 只发 1 次，不重试
   *   - 1 = 首次 + 1 次重试（默认，auth retry 场景够用）
   *   - 3-5 = 429 退避场景
   * 重试由 createNet 的 retry loop 统一管，catch RetryableError 后重发。
   */
  maxRetries?: number;
  /**
   * 重试退避延时计算。
   * 默认：attempt=1 时 retryAfterMs ?? 1000，attempt=2 时 retryAfterMs ?? 2000，指数退避。
   */
  retryDelayMs?: (attempt: number, retryAfterMs?: number) => number;
  logger?: Logger;
}
