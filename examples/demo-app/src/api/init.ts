/**
 * 项目级 API 注册表（v0.2 简化版）
 *
 * v0.2 变化：
 *   - 不再用 createNetMiddleware（库已删除）
 *   - 改用 createNet（工厂模式，注入 AuthService + 业务 middleware）
 *   - request 方法走 createNet（保留内核 auth/retry/httpError），不走 HttpClient
 *
 * 用法（main.ts）：
 *   const authService = new AuthService({ ... });
 *   initApi("default", { baseURL, authService, middleware: [createAbpUnwrapMw()] });
 *   initApi("weather", { baseURL: THIRD_PARTY_URL, authService, middleware: [...] });
 *
 * 业务代码：
 *   const api = useApi();           // 默认 Demo client
 *   const w = useApi("weather");    // 第三方 client
 *   await api.base.GET("/api/identity/users/{id}", { params: { path: { id } } });
 *   await api.request("/api/legacy/user", { unwrap: (p) => p });  // 无 schema 接口
 */

import { createNet, HttpClient } from "@xapiforge/core";
import type { NetConfig } from "@xapiforge/core";
import type { ApiDemo, ApiDemoLayeredClientConfig } from "./gen/demo/index.js";
import { createDemoClient } from "./gen/demo/index.js";

export type { ApiDemo };

export interface InitApiConfig extends NetConfig {
  /** 生成 client 的 service 级覆盖；未定义字段继续使用当前 NetConfig defaults。 */
  services?: ApiDemoLayeredClientConfig["services"];
}

/**
 * 无 schema 请求的选项。
 *
 * request 方法走 createNet 的 client.request（保留内核 auth/retry/httpError），
 * 但不依赖 OpenAPI schema —— 用于"不标准接口"（无 schema 或格式与主协议不同）。
 *
 * unwrap：业务侧自定义解包函数。
 *   - 默认：返回 JSON.parse 后的整个 payload
 *   - 自定义：从 payload 里抽取业务数据（如微信 payload.result）
 */
export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** 自定义解包：从 JSON payload 里抽取业务数据 */
  unwrap?: (payload: unknown) => unknown;
}

/**
 * 下载选项。
 *
 * 两种模式（按是否提供 onChunk 选择）：
 *
 * 1. 内存模式（默认，不传 onChunk）：
 *    累积所有 chunk → 返回 Blob。
 *    ⚠️ 适合小文件（< 100MB）。大文件（1GB+）会撑爆内存，手机 webview 可能崩溃。
 *
 * 2. 流式模式（传 onChunk）：
 *    每个 chunk 调 onChunk 处理，不累积到内存 → DownloadResult.blob 为 null。
 *    ✅ 适合大文件。业务侧可流式写盘（File System Access API / Capacitor Filesystem）。
 *
 * 断点续传：传 rangeFrom 时自动加 Range: bytes=offset- header。
 *   - 服务端返 206 Partial Content → 续传成功
 *   - 服务端返 200 → 不支持 Range，整文件重传
 *   - 业务侧负责记录已下载字节 + 本地存储
 */
export interface DownloadOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** 下载进度回调 */
  onProgress?: (received: number, total: number | null) => void;
  /** 断点续传：从指定字节开始下载（自动加 Range header） */
  rangeFrom?: number;
  /**
   * 流式 chunk 处理器（大文件写盘用）。
   *
   * - 不提供（默认）：累积所有 chunk 到内存 → 返回 Blob（适合小文件 < 100MB）
   *   ⚠️ 大文件（1GB+）会撑爆内存，手机 webview 可能崩溃。
   *
   * - 提供：每个 chunk 调 onChunk，不累积到内存 → blob 返回 null
   *   ✅ 适合大文件。业务侧流式写盘：
   *
   * @example Chromium 浏览器（File System Access API）
   *   const handle = await window.showSaveFilePicker({ suggestedName: "big.zip" });
   *   const writable = await handle.createWritable();
   *   await api.download("/api/big-file", {
   *     onChunk: async (chunk) => { await writable.write(chunk); },
   *     onProgress: (r, t) => updateProgressBar(r, t),
   *   });
   *   await writable.close();
   *
   * @example Capacitor（手机 webview，File System Access API 不可用）
   *   // 注意：Capacitor Filesystem.appendFile 需 base64，大文件性能差。
   *   // 生产环境建议用 Capacitor 插件直接写 File URI（需 native 插件支持 stream 写）。
   *   await api.download("/api/big-file", {
   *     onChunk: async (chunk) => {
   *       const b64 = btoa(String.fromCharCode(...chunk));
   *       await Filesystem.appendFile({ path: "big.zip", directory: Directory.Cache, data: b64 });
   *     },
   *   });
   */
  onChunk?: (chunk: Uint8Array, received: number, total: number | null) => Promise<void> | void;
  /**
   * 文件名提取器（自定义解析 Content-Disposition）。
   * 默认：解析 attachment; filename="xxx" 和 filename*=UTF-8''xxx
   * 不同后端格式可能不同，业务侧可覆盖。
   */
  filenameExtractor?: (disposition: string | null, response: Response) => string | null;
}

/**
 * 下载结果。
 *
 * blob：内存模式下为 Blob；流式模式（onChunk）下为 null。
 */
export interface DownloadResult {
  /** 文件 Blob（内存模式）。流式模式（onChunk）下为 null。 */
  blob: Blob | null;
  /** 从 Content-Disposition 提取的文件名（提取失败为 null） */
  filename: string | null;
  /** HTTP 状态码（200 完整下载 / 206 断点续传） */
  status: number;
  /** 响应头 */
  headers: Headers;
  /** 总字节数（Content-Length，可能为 null） */
  total: number | null;
}

/**
 * 上传选项。
 *
 * ⚠️ fetch API 不支持上传进度回调。如需进度，业务侧用 XHR。
 */
export interface UploadOptions {
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** 自定义解包（同 request.unwrap） */
  unwrap?: (payload: unknown) => unknown;
}

/**
 * 批量上传选项。
 */
export interface UploadBatchOptions {
  /** 并发数，默认 3 */
  concurrency?: number;
  /** 单文件上传成功回调 */
  onFileComplete?: (index: number, result: unknown) => void;
  /** 单文件上传失败回调（不抛错，记录到结果数组） */
  onFileError?: (index: number, error: Error) => void;
}

/**
 * 注册表 entry：Demo 强类型 client + request（无 schema）+ HttpClient（纯 HTTP）。
 *
 * 三层 API 入口（按"是否走内核"分层）：
 *   1. api.base.GET(...)  — 强类型 + 内核 + 业务 middleware（主协议接口）
 *   2. api.request(...)   — 无 schema + 内核（不标准接口，保留 auth/retry/httpError）
 *   3. api.http.request(...) — 纯 HTTP，无内核（文件下载 / 真正需要绕过时用）
 */
export interface RegisteredApiClient extends ApiDemo {
  /**
   * 无 schema 请求（走 createNet，保留内核 auth/retry/httpError）。
   *
   * 用于"不标准接口"：
   *   - 无 OpenAPI schema 的老接口
   *   - 格式与主协议不同的接口（如微信 errcode / 自研协议）
   *   - 第三方代理接口
   *
   * 与 api.base.GET 的区别：
   *   - 无 schema 类型校验（用泛型 <T> 手动指定返回类型）
   *   - 不走业务 middleware（envelope 解包由 unwrap 参数自定义）
   *   - 走内核 middleware（auth 注入 token / httpError 5xx 抛错 / retry loop 429 退避）
   *
   * @example
   *   // 老接口（无 envelope）
   *   const user = await api.request<User>("/api/legacy/user");
   *
   *   // 微信接口（自定义解包）
   *   const data = await api.request<{ openid: string }>("/api/wechat/proxy", {
   *     unwrap: (p) => (p as any).result,
   *   });
   */
  request: <T = unknown>(path: string, options?: RequestOptions) => Promise<T>;

  /**
   * 文件下载（走内核，支持进度回调 + 文件名提取 + 流式写盘）。
   *
   * 走 rawClient（内核 middleware：auth + httpError + retry loop）：
   *   - 401 自动刷新 token 后重试
   *   - 不可接受的 HTTP 状态抛 ApiError（保留解析后的 body 与原始 Response）
   *   - 429 退避重试
   *
   * 两种模式（按是否传 options.onChunk）：
   *
   * 1. 内存模式（默认，不传 onChunk）：
   *    累积所有 chunk → 返回 Blob。
   *    ⚠️ 适合小文件（< 100MB）。1GB 文件会撑爆内存，手机 webview 可能崩溃。
   *
   * 2. 流式模式（传 onChunk）：
   *    每个 chunk 调 onChunk 处理，不累积到内存 → blob 返回 null。
   *    ✅ 适合大文件。业务侧流式写盘：
   *
   * @example 小文件（内存模式）
   *   const { blob, filename } = await api.download("/api/file/download?id=123", {
   *     onProgress: (received, total) => console.log(`${received}/${total}`),
   *   });
   *   const url = URL.createObjectURL(blob!);
   *   const a = document.createElement("a");
   *   a.href = url; a.download = filename ?? "download.bin"; a.click();
   *
   * @example 大文件（流式模式，File System Access API）
   *   const handle = await window.showSaveFilePicker({ suggestedName: "big.zip" });
   *   const writable = await handle.createWritable();
   *   await api.download("/api/big-file", {
   *     onChunk: async (chunk) => { await writable.write(chunk); },
   *     onProgress: (r, t) => updateProgressBar(r, t),
   *   });
   *   await writable.close();
   */
  download: (path: string, options?: DownloadOptions) => Promise<DownloadResult>;

  /**
   * 文件上传（走内核，FormData 原样传）。
   *
   * 走 rawClient（内核 middleware）：
   *   - 401 自动刷新 token 后重试
   *   - 不可接受的 HTTP 状态抛 ApiError
   *   - 429 退避重试
   *
   * ⚠️ 上传进度：fetch API 不支持上传进度回调。
   *   如需上传进度，业务侧用 XMLHttpRequest 自己实现（不走内核）。
   *   库层不提供 XHR 上传（避免引入 XHR 依赖，保持 fetch-only）。
   *
   * @example
   *   const fd = new FormData();
   *   fd.append("file", file, file.name);
   *   const result = await api.upload<UploadResult>("/api/file/upload", fd);
   */
  upload: <T = unknown>(path: string, body: FormData, options?: UploadOptions) => Promise<T>;

  /**
   * 批量并发上传（并发控制 + 单文件完成回调）。
   *
   * @example
   *   const results = await api.uploadBatch(
   *     files.map(f => ({ path: "/api/file/upload", body: toFormData(f) })),
   *     { concurrency: 3, onFileComplete: (i, r) => console.log(`file ${i} done`) },
   *   );
   */
  uploadBatch: <T = unknown>(
    items: { path: string; body: FormData; options?: UploadOptions }[],
    batchOptions?: UploadBatchOptions,
  ) => Promise<(T | Error)[]>;

  /**
   * HttpClient（纯 HTTP，无内核 middleware）。
   *
   * 只在真正需要绕过内核时用：
   *   - AuthApi 的 refresh 端点（避免循环：refresh 401 不能再触发 refresh）
   *   - 完全独立的第三方 API（不需要鉴权）
   *
   * ⚠️ 不走 auth/retry/httpError，401 不会自动刷新，失败状态不会自动抛 ApiError。
   * ⚠️ 文件下载请用 api.download（走内核 + 进度），不要用 http.request。
   */
  http: HttpClient;
}

const registry = new Map<string, RegisteredApiClient>();
const DEFAULT_NAME = "default";

/**
 * 注册一个命名 client。
 * 同一 name 调两次会抛错（避免重复 init）。
 */
export function initApi(name: string, config: InitApiConfig): void {
  if (registry.has(name)) {
    throw new Error(`[useApi] initApi('${name}') called more than once`);
  }

  const { services, ...defaults } = config;

  // 创建 Demo 强类型 client；service override 只替换显式定义的 Core 配置字段。
  const demoClient = createDemoClient({ defaults, services });

  // HttpClient 给文件下载 / AuthApi refresh 用（纯 HTTP，无内核）
  //   fetch 透传：业务侧传 capacitorFetch 时，文件下载也走原生 HTTP
  const http = new HttpClient({ baseURL: config.baseURL, fetch: config.fetch });

  // 无 schema client：createNet 但不注入业务 middleware
  //   - 内核 middleware（auth + httpError + retry loop）自动注入 ← 保留内核
  //   - 业务 middleware（abpUnwrap 等）不注入                  ← 不受主协议干扰
  //   用于"不标准接口"：格式与主协议不同的接口（微信 / 自研 / 老接口）
  const rawClient = createNet<Record<string, never>>({
    ...defaults,
    middleware: [], // 无业务 middleware，纯内核
  });

  // request：走 rawClient（内核 + 自定义 unwrap）
  //   - 走 auth middleware：401 自动刷新
  //   - 走最终状态校验：不可接受的 HTTP 状态抛 ApiError（保留 body / Response）
  //   - 走 retry loop：429 退避重试
  //   - 不走 abpUnwrap：业务侧用 unwrap 自定义解包
  async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    // openapi-fetch client.request 签名：(method, path, opts)
    // 成功返回 { data, response }；失败统一抛 ApiError。
    // data 是按 content-type 解析后的 body。
    // openapi-fetch 的 method 参数是 lowercase（"get" / "post" ...），不是 HTTP 大写
    //
    // 类型绕过：paths 是 Record<string, never>（无 schema），openapi-fetch 对无 schema
    // 的 request 参数类型推导为 undefined。cast 成宽松函数类型绕过（运行时正确，
    // openapi-fetch 不校验 path/method，直接转发给 fetch）。
    type RawRequest = (
      method: string,
      path: string,
      opts: Record<string, unknown>,
    ) => Promise<{ data: unknown; response: Response }>;
    const rawRequest = rawClient.request as unknown as RawRequest;
    const method = (options.method ?? "GET").toLowerCase();
    const res = await rawRequest(method, path, {
      headers: options.headers,
      body: options.body,
      // openapi-fetch query 格式：{ query: { key: value } }
      ...(options.query ? { query: options.query } : {}),
    });

    // openapi-fetch 返回的 data 是 JSON.parse 后的 body
    let payload: unknown = res.data;

    // 如果 data 为 null/undefined 且 response 有 bodyText，尝试 parse
    // （openapi-fetch 对非 JSON content-type 可能不 parse）
    if (payload === null || payload === undefined) {
      const text = await res.response.clone().text();
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
    }

    if (options.unwrap) {
      return options.unwrap(payload) as T;
    }
    return payload as T;
  }

  // ─── 文件名提取（默认实装，业务侧可通过 filenameExtractor 覆盖）───
  // 解析 Content-Disposition: attachment; filename="xxx" 和 filename*=UTF-8''xxx
  // RFC 6266 格式，支持中文文件名（URL encoded）
  function defaultFilenameExtractor(disposition: string | null): string | null {
    if (!disposition) return null;
    // 优先 filename*（RFC 5987，支持 UTF-8）
    const starMatch = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (starMatch?.[1]) {
      try {
        return decodeURIComponent(starMatch[1].trim());
      } catch {
        return starMatch[1].trim();
      }
    }
    // 其次 filename="xxx"
    const quotedMatch = disposition.match(/filename\s*=\s*"([^"]+)"/i);
    if (quotedMatch?.[1]) return quotedMatch[1];
    // 最后 filename=xxx（无引号）
    const plainMatch = disposition.match(/filename\s*=\s*([^;]+)/i);
    if (plainMatch?.[1]) return plainMatch[1].trim();
    return null;
  }

  // download：走 rawClient（内核）+ ReadableStream 进度 + 文件名提取 + 流式写盘
  //   - 走 auth middleware：401 自动刷新
  //   - 走最终状态校验：不可接受的 HTTP 状态抛 ApiError
  //   - 走 retry loop：429 退避重试
  //   - 用 response.body.getReader() 读 chunk
  //   - 两种模式：
  //     1. 内存模式（无 onChunk）：累积 chunk → Blob（小文件）
  //     2. 流式模式（有 onChunk）：chunk 传 onChunk 处理，不累积（大文件写盘）
  async function download(path: string, options: DownloadOptions = {}): Promise<DownloadResult> {
    const headers = { ...options.headers };
    // 断点续传：加 Range header
    if (options.rangeFrom !== undefined && options.rangeFrom > 0) {
      headers["Range"] = `bytes=${options.rangeFrom}-`;
    }

    type RawRequest = (
      method: string,
      path: string,
      opts: Record<string, unknown>,
    ) => Promise<{ data: unknown; response: Response }>;
    const rawRequest = rawClient.request as unknown as RawRequest;
    const method = (options.method ?? "GET").toLowerCase();
    const res = await rawRequest(method, path, {
      headers,
      body: options.body,
      signal: options.signal,
      // parseAs: "stream" → openapi-fetch 不自动 parse body（默认 "json" 会 JSON.parse 二进制失败）
      // 我们从 response.body 读 stream + 进度
      parseAs: "stream",
      ...(options.query ? { query: options.query } : {}),
    });

    const response = res.response;
    const contentLength = response.headers.get("Content-Length");
    const total = contentLength ? parseInt(contentLength, 10) : null;
    const disposition = response.headers.get("Content-Disposition");

    // 提取文件名（业务侧可覆盖）
    const filename = options.filenameExtractor
      ? options.filenameExtractor(disposition, response)
      : defaultFilenameExtractor(disposition);

    // 读 stream
    // response.body 是 ReadableStream<Uint8Array>（fetch API）
    // 注：Node.js 环境下 response.body 可能是 null（test-scenarios.ts 里用 fetch）
    const reader = response.body?.getReader();
    if (!reader) {
      // 无 stream（Node.js 或无 body）→ 直接 blob()
      const blob = await response.blob();
      options.onProgress?.(blob.size, total);
      // 流式模式但无 reader：无法调 onChunk，退化为返回 blob
      return { blob, filename, status: response.status, headers: response.headers, total };
    }

    const useStreamMode = !!options.onChunk;
    // 内存模式才累积 chunk；流式模式不累积（避免大文件撑爆内存）
    // 注：用 BlobPart[] 类型（TS 5.9 的 Uint8Array<ArrayBufferLike> 需 cast）
    const chunks: BlobPart[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (useStreamMode && options.onChunk) {
          // 流式模式：chunk 交给业务侧处理（写盘），不累积到内存
          await options.onChunk(value, received, total);
        } else {
          // 内存模式：累积到 chunks（后续 new Blob）
          chunks.push(value as BlobPart);
        }
        options.onProgress?.(received, total);
      }
    }

    const blob = useStreamMode ? null : new Blob(chunks);
    return { blob, filename, status: response.status, headers: response.headers, total };
  }

  // upload：走 rawClient（内核）+ FormData 原样传
  //   - 走 auth middleware：401 自动刷新
  //   - 走最终状态校验：不可接受的 HTTP 状态抛 ApiError
  //   - 走 retry loop：429 退避重试
  //   - FormData 原样传（openapi-fetch 不自动设 Content-Type，浏览器加 boundary）
  //   - ⚠️ 无上传进度（fetch API 限制），需进度用 XHR
  async function upload<T = unknown>(
    path: string,
    body: FormData,
    options: UploadOptions = {},
  ): Promise<T> {
    return request<T>(path, {
      method: options.method ?? "POST",
      body,
      headers: options.headers,
      query: options.query,
      unwrap: options.unwrap,
    });
  }

  // uploadBatch：并发控制 + 单文件回调
  //   - concurrency 控制同时上传数（默认 3）
  //   - 单文件失败不中断其他，记录到结果数组（Error 实例）
  //   - onFileComplete / onFileError 回调
  async function uploadBatch<T = unknown>(
    items: { path: string; body: FormData; options?: UploadOptions }[],
    batchOptions: UploadBatchOptions = {},
  ): Promise<(T | Error)[]> {
    const concurrency = Math.max(1, batchOptions.concurrency ?? 3);
    const results: (T | Error)[] = new Array(items.length);

    let cursor = 0;

    async function worker(): Promise<void> {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (!item) continue;
        try {
          const result = await upload<T>(item.path, item.body, item.options ?? {});
          results[index] = result;
          batchOptions.onFileComplete?.(index, result);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          results[index] = err;
          batchOptions.onFileError?.(index, err);
        }
      }
    }

    // 启动 concurrency 个 worker
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  registry.set(name, { ...demoClient, http, request, download, upload, uploadBatch });
}

/**
 * 拿一个命名 client（业务侧统一入口）。
 * - 不传 name → 拿 'default' client
 * - 传 name → 拿该命名 client
 */
export function useApi(): RegisteredApiClient;
export function useApi<T = RegisteredApiClient>(name: string): T;
export function useApi<T = RegisteredApiClient>(name: string = DEFAULT_NAME): T {
  const client = registry.get(name);
  if (!client) {
    if (name === DEFAULT_NAME) {
      throw new Error(
        `[useApi] initApi('${DEFAULT_NAME}', {...}) not called. Call it in main.ts before mount.`,
      );
    }
    throw new Error(
      `[useApi] no client registered under name '${name}'. Did you forget initApi('${name}', {...})?`,
    );
  }
  return client as T;
}

/** 已注册的客户端名列表（调试 / 工具用） */
export function listClients(): readonly string[] {
  return Array.from(registry.keys());
}

/** 测试场景：清空 singleton。不要在生产代码里调。 */
export function _resetApiForTests(): void {
  registry.clear();
}
