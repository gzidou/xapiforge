/**
 * @xapiforge/core — createNet（业务主入口）
 *
 * 对外契约只有两条：
 *   - 成功：resolve `{ data, response }`
 *   - 失败：reject `ApiError`
 *
 * openapi-fetch 原生的 `{ data } | { error }` 只存在于本文件内部。这样页面和业务 service
 * 不需要同时维护“检查 result.error”与“catch 异常”两套失败逻辑。
 *
 * 响应顺序（openapi-fetch onResponse 逆注册执行）：
 *   1. 业务 middleware：envelope 解包 / 业务错误
 *   2. retry middleware：429 → RetryableError
 *   3. auth middleware：401 → refresh → RetryableError
 *   4. HTTP error middleware：validateStatus → ApiError
 *
 * createNet 外层捕获 RetryableError 并重发完整请求；重试耗尽时将内部信号转换为稳定的
 * ApiError(kind="auth" | "rate-limit")，不会把 RetryableError 暴露给业务。
 */

import createClient from "openapi-fetch";
import type { Client as OpenapiClient } from "openapi-fetch";
import { ApiError, NetworkError, RetryableError } from "./errors.js";
import { createAuthMiddleware } from "./middleware/auth-mw.js";
import { createHttpErrorMiddleware, readResponseBody } from "./middleware/http-error-mw.js";
import { createRetryMiddleware } from "./middleware/retry-mw.js";
import type { NetClient } from "./net-client.js";
import type { FetchLike, NetConfig, ValidateStatus } from "./types.js";

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TIMEOUT_MS = 15_000;

function defaultRetryDelay(attempt: number, retryAfterMs?: number): number {
  if (attempt === 0) return 0;
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.pow(2, attempt - 1) * 1000;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 给 openapi-fetch 注入统一的网络错误与默认超时。
 *
 * fetch reject 没有 Response，因此 response/status/body 均为空，底层异常保存在 cause。
 * AbortError 根据触发来源区分 timeout 与 abort，便于 UI 决定是否提示用户。
 */
function createTimeoutFetch(
  timeoutMs: number,
  fetchFn: FetchLike,
  logger?: NetConfig["logger"],
): (input: Request) => Promise<Response> {
  return async (input: Request): Promise<Response> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let userAborted = false;
    let timedOut = false;
    let onUserAbort: (() => void) | null = null;

    const userSignal = input.signal;
    if (userSignal) {
      if (userSignal.aborted) {
        userAborted = true;
        controller.abort();
      } else {
        onUserAbort = () => {
          userAborted = true;
          controller.abort();
        };
        userSignal.addEventListener("abort", onUserAbort, { once: true });
      }
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    try {
      return await fetchFn(input, { ...input, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;

      if (cause instanceof Error && cause.name === "AbortError") {
        if (userAborted) {
          throw new NetworkError("请求已取消", { kind: "abort", cause });
        }
        if (timedOut) {
          logger?.warn?.(
            `[net] request timeout after ${timeoutMs}ms: ${input.method} ${input.url}`,
          );
          throw new NetworkError("请求超时", { kind: "timeout", cause });
        }
      }

      throw new NetworkError("网络请求失败", { kind: "network", cause });
    } finally {
      if (timer) clearTimeout(timer);
      if (onUserAbort && userSignal) {
        userSignal.removeEventListener("abort", onUserAbort);
      }
    }
  };
}

interface OpenapiFetchResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

function isOpenapiFetchResult(value: unknown): value is OpenapiFetchResult {
  if (typeof value !== "object" || value === null) return false;
  return "response" in value && (value as { response?: unknown }).response instanceof Response;
}

/**
 * 显式接受非 2xx 时，openapi-fetch 仍会把解析结果放在 error；这里统一移动到 data。
 * 不可接受的状态已由最终 HTTP middleware 抛错，因此正常情况下不会误吞错误。
 */
function normalizeResolvedResult(value: unknown): OpenapiFetchResult {
  if (!isOpenapiFetchResult(value)) {
    throw new ApiError({
      kind: "unexpected",
      message: "请求处理过程中发生未知错误",
      cause: value,
    });
  }

  if ("error" in value) {
    return { data: value.error, response: value.response };
  }
  return { data: value.data, response: value.response };
}

async function retryExhaustedError(error: RetryableError): Promise<ApiError> {
  const rateLimited = error.reason === "rate-limit";
  const body = error.response ? await readResponseBody(error.response) : undefined;
  return new ApiError({
    kind: rateLimited ? "rate-limit" : "auth",
    message: rateLimited ? "请求过于频繁，请稍后重试" : "身份认证失败",
    status: error.response?.status,
    response: error.response,
    body,
    cause: error,
  });
}

function normalizeThrownError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof SyntaxError) {
    return new ApiError({
      kind: "parse",
      message: "响应数据解析失败",
      cause,
    });
  }
  return new ApiError({
    kind: "unexpected",
    message: "请求处理过程中发生未知错误",
    cause,
  });
}

/** client 级自定义 validateStatus：所有方法的 data 保守包含 error response 类型。 */
export function createNet<Paths extends object>(
  config: NetConfig & { validateStatus: ValidateStatus },
): NetClient<Paths, true>;

/**
 * 默认 client：data 仅包含 OpenAPI 2xx 类型。
 * 单次请求传 validateStatus 时，该次调用的 data 类型会增加 OpenAPI error response。
 */
export function createNet<Paths extends object>(config: NetConfig): NetClient<Paths, false>;

export function createNet<Paths extends object>(config: NetConfig): NetClient<Paths, boolean> {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = config.retryDelayMs ?? defaultRetryDelay;
  const logger = config.logger;

  const timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn: FetchLike = config.fetch ?? globalThis.fetch.bind(globalThis);
  const client: OpenapiClient<Paths> = createClient<Paths>({
    baseUrl: config.baseURL,
    fetch: createTimeoutFetch(timeoutMs, fetchFn, logger),
  });

  // 注册最早 → onResponse 最晚执行。确保 auth/retry 有机会先处理 401/429。
  client.use(
    createHttpErrorMiddleware({
      validateStatus: config.validateStatus,
      resolveErrorMessage: config.resolveErrorMessage,
    }),
  );
  client.use(createAuthMiddleware(config.authService));
  client.use(createRetryMiddleware());

  if (config.middleware) {
    for (const middleware of config.middleware) {
      client.use(middleware);
    }
  }

  const wrapMethod = <Method extends (...args: never[]) => Promise<unknown>>(
    originalMethod: Method,
  ): Method => {
    const wrapped = async (...args: never[]) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return normalizeResolvedResult(await originalMethod(...args));
        } catch (cause) {
          if (!(cause instanceof RetryableError)) {
            throw normalizeThrownError(cause);
          }

          if (attempt >= maxRetries) {
            logger?.warn?.(`[net] retry exhausted after ${attempt} attempts: ${cause.message}`);
            throw await retryExhaustedError(cause);
          }

          if (cause.needsRefresh) {
            logger?.debug?.("[net] auth retry needed (needsRefresh), refreshing token");
            await config.authService.refreshIfNeeded();
          } else if (cause.retryAfterMs !== undefined) {
            const delay = retryDelayMs(attempt + 1, cause.retryAfterMs);
            logger?.debug?.(`[net] retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
            await sleep(delay);
          }
        }
      }

      throw new ApiError({
        kind: "unexpected",
        message: "请求处理过程中发生未知错误",
      });
    };
    return wrapped as Method;
  };

  client.GET = wrapMethod(client.GET.bind(client) as never);
  client.POST = wrapMethod(client.POST.bind(client) as never);
  client.PUT = wrapMethod(client.PUT.bind(client) as never);
  client.DELETE = wrapMethod(client.DELETE.bind(client) as never);
  client.PATCH = wrapMethod(client.PATCH.bind(client) as never);
  client.HEAD = wrapMethod(client.HEAD.bind(client) as never);
  client.OPTIONS = wrapMethod(client.OPTIONS.bind(client) as never);
  client.TRACE = wrapMethod(client.TRACE.bind(client) as never);
  client.request = wrapMethod(client.request.bind(client) as never);

  return client as unknown as NetClient<Paths, boolean>;
}
