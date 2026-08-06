/**
 * @xapiforge/core — 对外错误契约
 *
 * createNet 对业务侧只暴露一种失败通道：Promise reject，并保证请求链内部产生的失败
 * 都是 ApiError。业务代码通常只需要展示 `error.message`；需要精细处理时再读取
 * kind/status/response/body/cause。
 *
 * 边界说明：
 *   - ApiError 只描述 createNet 请求生命周期内的错误。
 *   - Vue 渲染、业务计算等请求外代码仍会抛出原生 Error/TypeError。
 *   - RetryableError 是内核重试信号，不属于公开错误契约。
 */

/** 请求生命周期中稳定、可供业务判断的错误分类。 */
export type ApiErrorKind =
  | "http"
  | "auth"
  | "rate-limit"
  | "network"
  | "timeout"
  | "abort"
  | "parse"
  | "business"
  | "unexpected";

export interface ApiErrorOptions<TBody = unknown> {
  /** 业务可展示的归一化文案；原始技术错误放在 cause。 */
  message: string;
  kind: ApiErrorKind;
  /** 收到 HTTP 响应时的状态码；断网、DNS 等场景没有。 */
  status?: number;
  /** 原始 Fetch Response；没有收到响应时为空。body 可能已被读取，headers/status 仍可访问。 */
  response?: Response;
  /** 响应体解析结果：JSON 为对象，非 JSON 为字符串，空 body 为 undefined。 */
  body?: TBody;
  /** 后端业务错误码（如果业务解析器能够识别）。 */
  code?: string | number;
  /** 底层原始异常，用于日志、堆栈和错误链排查。 */
  cause?: unknown;
}

/**
 * createNet 的统一公开错误。
 *
 * `message` 始终是非空字符串，适合作为 UI 兜底提示；`body` 和 `cause` 只用于
 * 诊断或明确的业务分支，不应直接展示或无条件上传日志，以免泄露敏感信息。
 */
export class ApiError<TBody = unknown> extends Error {
  readonly isApiError = true as const;
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly response?: Response;
  readonly body?: TBody;
  readonly code?: string | number;

  constructor(options: ApiErrorOptions<TBody>) {
    // 类型只能保证 string，不能保证非空；在错误边界再次守住可展示文案不为空的承诺。
    const message = options.message.trim() || "请求失败";
    super(message, { cause: options.cause });
    this.name = "ApiError";
    this.kind = options.kind;
    this.status = options.status ?? options.response?.status;
    this.response = options.response;
    this.body = options.body;
    this.code = options.code;
  }
}

/** refresh 失败或刷新后的 token 仍被拒绝。 */
export class AuthError<TBody = unknown> extends ApiError<TBody> {
  readonly isAuthError = true as const;

  constructor(
    message = "Authentication failed",
    options?: Omit<ApiErrorOptions<TBody>, "kind" | "message">,
  ) {
    super({ ...options, kind: "auth", message });
    this.name = "AuthError";
  }
}

/** fetch 未获得正常响应：断网、DNS、CORS、超时或主动取消。 */
export class NetworkError<TBody = unknown> extends ApiError<TBody> {
  readonly isNetworkError = true as const;

  constructor(
    message: string,
    options?: Omit<ApiErrorOptions<TBody>, "kind" | "message"> & {
      kind?: "network" | "timeout" | "abort";
    },
  ) {
    super({ ...options, kind: options?.kind ?? "network", message });
    this.name = "NetworkError";
  }

  /** @deprecated 使用 body；仅为旧诊断代码提供只读别名。 */
  get bodyText(): string | undefined {
    return typeof this.body === "string" ? this.body : undefined;
  }

  /** @deprecated 使用 response?.headers。 */
  get headers(): Headers | undefined {
    return this.response?.headers;
  }
}

/** RetryableError 的来源，用于重试耗尽时转换成稳定的 ApiError kind。 */
export type RetryReason = "auth" | "rate-limit" | "business-auth";

/**
 * 可重试错误（内核控制流信号）。
 *
 * middleware 抛出后由 createNet 捕获并重发；若重试耗尽，createNet 会把它转换为
 * ApiError(kind="auth" | "rate-limit")，不会把本类型泄露给业务调用者。
 */
export class RetryableError extends Error {
  readonly isRetryableError = true as const;
  readonly retryAfterMs?: number;
  readonly needsRefresh?: boolean;
  readonly reason: RetryReason;
  readonly response?: Response;

  constructor(
    message: string,
    options?: {
      retryAfterMs?: number;
      needsRefresh?: boolean;
      reason?: RetryReason;
      response?: Response;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "RetryableError";
    this.retryAfterMs = options?.retryAfterMs;
    this.needsRefresh = options?.needsRefresh;
    this.reason = options?.reason ?? (options?.retryAfterMs !== undefined ? "rate-limit" : "auth");
    this.response = options?.response;
  }
}
