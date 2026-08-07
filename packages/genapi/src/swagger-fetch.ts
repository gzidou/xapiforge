/**
 * @xapiforge/genapi — 远程 OpenAPI JSON 下载。
 *
 * URL 由 service.source.url 完整提供；本模块不再拼接 host、port、path。
 * 本地 source.file 不经过网络层，由生成器直接读取。
 */

import type { SwaggerUrlSource } from "./swagger-source.js";

export interface FetchOptions {
  source: SwaggerUrlSource;
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
  /** 是否在 5xx 或网络错误后重试一次，默认 true。 */
  retryOnce?: boolean;
}

export interface FetchResult {
  ok: boolean;
  url: string;
  text?: string;
  bytes?: number;
  error?: string;
  status?: number;
}

async function fetchOnce(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 下载并校验 JSON；成功时返回原始文本，避免无意义的重新序列化。 */
export async function downloadJson(
  url: string,
  timeoutMs: number,
  retryOnce = true,
): Promise<{ text: string; status: number }> {
  const attempts = retryOnce ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchOnce(url, timeoutMs);
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (response.status >= 500 && attempt < attempts - 1) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
        continue;
      }
      throw error;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Error(`Content-Type 不是 JSON: ${contentType || "<empty>"}`);
    }
    const text = await response.text();
    try {
      JSON.parse(text);
    } catch (error) {
      throw new Error(`响应不是合法 JSON: ${(error as Error).message}`);
    }
    return { text, status: response.status };
  }

  // 循环的每条路径都会 return/throw；保留显式保护，避免未来修改形成静默 undefined。
  throw new Error("[genapi] downloadJson exhausted attempts without a result");
}

/** 下载一个明确的 source.url；source.file 不属于此函数职责。 */
export async function fetchSwaggerJson(options: FetchOptions): Promise<FetchResult> {
  const url = options.source.url;
  try {
    const { text } = await downloadJson(url, options.timeoutMs, options.retryOnce);
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
