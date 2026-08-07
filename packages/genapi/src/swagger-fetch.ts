/**
 * @xapiforge/genapi — 远程 OpenAPI JSON 下载。
 *
 * URL 由 service.source.url 完整提供；本模块不再拼接 host、port、path。
 * 本地 source.file 不经过网络层，由生成器直接读取。
 */

import type { SwaggerUrlSource } from "./swagger-source.js";
import { normalizeJsonInputText, parseJsonInput } from "./json-input.js";

const MAX_TIMEOUT_MS = 2_147_483_647;
export const DEFAULT_MAX_SWAGGER_BYTES = 64 * 1024 * 1024;

export function isValidFetchTimeout(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= MAX_TIMEOUT_MS;
}

export function isValidSwaggerSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export interface FetchOptions {
  source: SwaggerUrlSource;
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
  /** 是否在 5xx 或网络错误后重试一次，默认 true。 */
  retryOnce?: boolean;
  /** 解压后的 JSON body 最大字节数，默认 64 MiB。 */
  maxBytes?: number;
}

export interface FetchResult {
  ok: boolean;
  url: string;
  text?: string;
  bytes?: number;
  error?: string;
  status?: number;
}

class DownloadAttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DownloadAttemptError";
  }
}

function discardResponse(response: Response): void {
  // 丢弃失败或底层 stream.cancel() 卡住，都不能覆盖/阻塞真正的响应错误。
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // 非标准 fetch 实现即使同步抛错，也保留原始响应错误。
  }
}

function tooLargeError(maxBytes: number): DownloadAttemptError {
  return new DownloadAttemptError(`Swagger 超过最大允许大小 ${formatBytes(maxBytes)}`, false);
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    discardResponse(response);
    throw tooLargeError(maxBytes);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(new Error("response body aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLargeError(maxBytes);
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // 非标准或仍有 pending read 的 stream 不得覆盖超时/大小错误。
    }
  }
  return normalizeJsonInputText(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      totalBytes,
    ).toString("utf8"),
  );
}

async function downloadAttempt(
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ text: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (cause) {
      const message = controller.signal.aborted
        ? `请求超时 (${timeoutMs}ms)`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new DownloadAttemptError(message, true, { cause });
    }

    if (!response.ok) {
      discardResponse(response);
      throw new DownloadAttemptError(
        `HTTP ${response.status} ${response.statusText}`,
        response.status >= 500,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      discardResponse(response);
      throw new DownloadAttemptError(`Content-Type 不是 JSON: ${contentType || "<empty>"}`, false);
    }

    let text: string;
    try {
      text = await readResponseText(response, controller.signal, maxBytes);
    } catch (cause) {
      if (cause instanceof DownloadAttemptError) throw cause;
      const message = controller.signal.aborted
        ? `请求超时 (${timeoutMs}ms)`
        : cause instanceof Error
          ? cause.message
          : String(cause);
      throw new DownloadAttemptError(message, true, { cause });
    }
    try {
      parseJsonInput(text);
    } catch (cause) {
      throw new DownloadAttemptError(
        `响应不是合法 JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        false,
        { cause },
      );
    }
    return { text, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

/** 下载并校验 JSON；成功时返回原始文本，避免无意义的重新序列化。 */
export async function downloadJson(
  url: string,
  timeoutMs: number,
  retryOnce = true,
  maxBytes = DEFAULT_MAX_SWAGGER_BYTES,
): Promise<{ text: string; status: number }> {
  if (!isValidFetchTimeout(timeoutMs)) {
    throw new TypeError(`timeoutMs 必须是 1..${MAX_TIMEOUT_MS} 范围内的整数毫秒`);
  }
  if (!isValidSwaggerSize(maxBytes)) {
    throw new TypeError("maxBytes 必须是正安全整数");
  }
  const attempts = retryOnce ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await downloadAttempt(url, timeoutMs, maxBytes);
    } catch (error) {
      if (error instanceof DownloadAttemptError && error.retryable && attempt < attempts - 1) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
        continue;
      }
      throw error;
    }
  }

  // 循环的每条路径都会 return/throw；保留显式保护，避免未来修改形成静默 undefined。
  throw new Error("[genapi] downloadJson exhausted attempts without a result");
}

/** 下载一个明确的 source.url；source.file 不属于此函数职责。 */
export async function fetchSwaggerJson(options: FetchOptions): Promise<FetchResult> {
  const url = options.source.url;
  try {
    const { text } = await downloadJson(
      url,
      options.timeoutMs,
      options.retryOnce,
      options.maxBytes ?? DEFAULT_MAX_SWAGGER_BYTES,
    );
    return {
      ok: true,
      url,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP (\d+)/)?.[1]) || undefined;
    return {
      ok: false,
      url,
      error: message,
      status,
    };
  }
}

/** 格式化字节数（人类可读）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
