/**
 * @xapiforge/core — HttpClient（纯 HTTP 客户端）
 *
 * 职责：fetch 封装 + 超时 + abort + 重定向。
 *
 * **不管**：middleware / auth / envelope / 业务错误。
 *
 * 用途：
 *   1. AuthApi 调 `/connect/token`（不走 middleware 链，避免循环）
 *   2. 文件下载（responseType: "blob"）
 *   3. 非 OpenAPI 端点
 *
 * 与 createNet 的关系：
 *   HttpClient 是底层，createNet 是上层（openapi-fetch + middleware）。
 *   createNet 内部不直接用 HttpClient（openapi-fetch 自己管 fetch），
 *   但 AuthApi / 文件下载等场景直接用 HttpClient。
 */

import { NetworkError } from "./errors.js";
import type { HttpRequestOptions, HttpResponse, HttpMethod, FetchLike } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpClient {
  private readonly baseURL: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  constructor(config: { baseURL?: string; defaultTimeoutMs?: number; fetch?: FetchLike } = {}) {
    this.baseURL = config.baseURL;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 默认 globalThis.fetch；业务侧可注入 capacitorFetch / undiciFetch 等
    // 注意：必须 .bind(globalThis) — 浏览器里 window.fetch 是方法，赋值后调用
    // 丢失 this 上下文会抛 "Illegal invocation"（Node undici fetch 无此问题，
    // 所以 scripts/test/scenarios.ts 在 Node 里跑测不出这个 bug）
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * 发起 HTTP 请求。
   *
   * 流程：
   *   1. 构造 URL（baseURL + path + query）
   *   2. 构造 body（对象 → JSON.stringify，string/FormData/Blob 原样）
   *   3. 构造 AbortController（超时 + 用户 signal 合并）
   *   4. fetch
   *   5. 读 body（text / blob）
   *   6. 返回 HttpResponse
   *
   * 错误处理：
   *   - fetch reject（CORS / DNS / TCP / abort）→ NetworkError
   *   - 超时（AbortController）→ NetworkError
   *   - 注意：HTTP 4xx/5xx **不**抛错（由 middleware / 业务侧决定）
   *
   * @throws NetworkError fetch 失败 / 超时 / abort
   */
  async request(opts: HttpRequestOptions): Promise<HttpResponse> {
    const url = this.buildURL(opts.path, opts.query);
    const { body, headers } = this.buildBodyAndHeaders(opts.body, opts.headers);
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    // AbortController：超时 + 用户 signal 合并
    // 用户 signal abort → 立即 abort
    // 超时 → 自动 abort
    const controller = new AbortController();
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
    }

    // 合并用户 signal：用户 abort 也触发 controller.abort
    // 注意：listener 必须在 finally 移除，防 signal 复用时累积 listener
    // （once 只在触发时自清，未触发则常驻）
    const onUserAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", onUserAbort, { once: true });
      }
    }

    try {
      const res = await this.fetchFn(url, {
        method: opts.method,
        headers,
        body,
        signal: controller.signal,
        // 浏览器默认 follow redirect，Node 18+ 也支持
        redirect: "follow",
      });

      // 读 body：responseType 决定
      const responseType = opts.responseType ?? "text";
      let bodyText = "";
      let blob: Blob | undefined;

      if (responseType === "blob") {
        blob = await res.blob();
      } else {
        // "text" / "json" 都用 text()（json 由业务侧自己 parse）
        bodyText = await res.text();
      }

      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        bodyText,
        blob,
      };
    } catch (e) {
      // fetch reject 或 abort
      if (e instanceof Error && e.name === "AbortError") {
        // 区分用户 abort 和超时 abort
        if (opts.signal?.aborted) {
          throw new NetworkError("Request aborted by user");
        }
        throw new NetworkError(`Request timeout (${timeoutMs}ms)`);
      }
      // CORS / DNS / TCP 等网络错误
      throw new NetworkError(`fetch failed: ${(e as Error).message ?? e}`, { cause: e });
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onUserAbort);
      }
    }
  }

  /**
   * 构造完整 URL：baseURL + path + query string
   */
  private buildURL(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    let url = path;
    // 绝对 URL（http(s):// 或协议相对 //）原样使用，不拼 baseURL
    if (!/^https?:\/\//i.test(path) && !path.startsWith("//") && this.baseURL) {
      url = `${this.baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    }
    if (query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          qs.append(key, String(value));
        }
      }
      const qsStr = qs.toString();
      if (qsStr) {
        url += (url.includes("?") ? "&" : "?") + qsStr;
      }
    }
    return url;
  }

  /**
   * 构造 body 和 headers。
   *
   * body 三种形式：
   *   1. undefined/null → 不设 body
   *   2. string / FormData / Blob → 原样传
   *   3. 对象 → JSON.stringify + Content-Type: application/json
   */
  private buildBodyAndHeaders(
    body: unknown,
    headers?: Record<string, string>,
  ): { body: BodyInit | undefined; headers: Headers } {
    const h = new Headers(headers);

    if (body === undefined || body === null) {
      return { body: undefined, headers: h };
    }

    // string / FormData / Blob / URLSearchParams → 原样传
    if (
      typeof body === "string" ||
      body instanceof FormData ||
      body instanceof Blob ||
      body instanceof URLSearchParams ||
      body instanceof ArrayBuffer
    ) {
      return { body: body as BodyInit, headers: h };
    }

    // 对象 → JSON.stringify
    if (!h.has("Content-Type")) {
      h.set("Content-Type", "application/json");
    }
    return { body: JSON.stringify(body), headers: h };
  }
}

// 便捷方法（可选，业务侧也可直接调 request）
export type { HttpMethod };
