/**
 * @xapiforge/core — 最终 HTTP 状态归一化 middleware
 *
 * 本 middleware 必须在 onResponse 链的最后执行：401/429 先完成 refresh/retry，业务
 * middleware 先完成 envelope 处理，剩余最终响应才由 validateStatus 判定。
 *
 * 不可接受的状态统一抛 ApiError；可接受的状态继续交给 openapi-fetch 解析。若业务
 * 显式接受 404 等非 2xx，createNet 外层会把 openapi-fetch 的 error body 转入 data。
 */

import { ApiError } from "../errors.js";
import type {
  ErrorMessageContext,
  Middleware,
  NetRequestOptions,
  ResolveErrorMessage,
  ValidateStatus,
} from "../types.js";

export interface HttpErrorMiddlewareConfig {
  /** client 级成功状态判定，默认 response.ok。 */
  validateStatus?: ValidateStatus;
  /** client 级错误文案解析器。 */
  resolveErrorMessage?: ResolveErrorMessage;
}

const defaultValidateStatus: ValidateStatus = (response) => response.ok;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON 优先；非法 JSON/普通文本保留原字符串，避免丢失后端错误内容。 */
function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 与框架无关的常见错误字段；专有 envelope 由 resolveErrorMessage 处理。 */
function resolveCommonMessage(body: unknown, response: Response): string | undefined {
  if (typeof body === "string") {
    const text = body.trim();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    // HTML/XML 错误页适合诊断，不适合作为面向用户的 message。
    if (
      contentType.includes("html") ||
      contentType.includes("xml") ||
      /^<(!doctype|html|\?xml)/i.test(text)
    ) {
      return undefined;
    }
    return text || undefined;
  }
  if (!isRecord(body)) return undefined;

  const direct =
    readString(body, "message") ??
    readString(body, "detail") ??
    readString(body, "title") ??
    readString(body, "error_description");
  if (direct) return direct;

  const nestedError = body.error;
  if (typeof nestedError === "string") return nestedError.trim() || undefined;
  if (isRecord(nestedError)) {
    return (
      readString(nestedError, "message") ??
      readString(nestedError, "detail") ??
      readString(nestedError, "title")
    );
  }
  return undefined;
}

function fallbackMessage(response: Response): string {
  return `请求失败（HTTP ${response.status}）`;
}

/** 供 auth/rate-limit 归一化复用；不是包级公共 API。 */
export async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return parseBody(await response.clone().text());
  } catch {
    // 某个业务 middleware 若错误地消费了原 response，body 无法恢复；状态和 headers 仍保留。
    return undefined;
  }
}

function getRequestOptions(request: Request): NetRequestOptions {
  // openapi-fetch 会把未知 init 字段复制到 Request；createNet 用它传递本库的单次请求选项。
  return request as Request & NetRequestOptions;
}

export function createHttpErrorMiddleware(config: HttpErrorMiddlewareConfig = {}): Middleware {
  return {
    async onResponse({ request, response }) {
      const requestOptions = getRequestOptions(request);
      const validateStatus =
        requestOptions.validateStatus ?? config.validateStatus ?? defaultValidateStatus;

      if (validateStatus(response)) return response;

      const body = await readResponseBody(response);
      const context: ErrorMessageContext = { response, body };
      const resolver = requestOptions.resolveErrorMessage ?? config.resolveErrorMessage;
      const customMessage = resolver?.(context)?.trim();
      const message =
        customMessage || resolveCommonMessage(body, response) || fallbackMessage(response);

      throw new ApiError({
        kind: "http",
        message,
        status: response.status,
        response,
        body,
      });
    },
  };
}
