/**
 * @xapiforge/adapter-capacitor — Ionic Capacitor 适配器
 *
 * 提供：
 *   1. TokenStore 适配器（preferencesStore / secureStorageStore）
 *   2. downloadFileNative —— 原生文件下载（0 内存，直写磁盘）
 *
 * 所有 @capacitor/* 依赖均通过动态 import 加载，**不写进 package.json**。
 * 调用方需在自己 App 里安装对应的 @capacitor/* 包。
 */
import type { TokenStore, Logger } from "@xapiforge/core";

// ─── TokenStore 适配器 ───

// @capacitor/preferences 最小类型（运行时动态 import，类型见 capacitor-modules.d.ts）
interface PreferencesModule {
  Preferences: {
    get(opts: { key: string }): Promise<{ value: string | null }>;
    set(opts: { key: string; value: string }): Promise<void>;
    remove(opts: { key: string }): Promise<void>;
  };
}

// @capacitor-community/secure-storage 最小类型
interface SecureStorageModule {
  SecureStoragePlugin: {
    get(opts: { key: string }): Promise<{ value: string }>;
    set(opts: { key: string; value: string }): Promise<void>;
    remove(opts: { key: string }): Promise<void>;
  };
}

/**
 * Capacitor Preferences 实现（async，持久化，明文）。
 * 调用方需自行安装 `@capacitor/preferences`（v5+）。
 *
 * 适合非敏感数据；access_token 建议用 secureStorageStore 存 Keychain/Keystore。
 */
export function preferencesStore(key: string): TokenStore {
  return {
    get: async (): Promise<string | null> => {
      const mod = (await import("@capacitor/preferences")) as PreferencesModule;
      const { value } = await mod.Preferences.get({ key });
      return value;
    },
    set: async (token: string): Promise<void> => {
      const mod = (await import("@capacitor/preferences")) as PreferencesModule;
      await mod.Preferences.set({ key, value: token });
    },
    clear: async (): Promise<void> => {
      const mod = (await import("@capacitor/preferences")) as PreferencesModule;
      await mod.Preferences.remove({ key });
    },
  };
}

/**
 * Capacitor Secure Storage 实现（async，存入 iOS Keychain / Android Keystore）。
 * 调用方需自行安装 `@capacitor-community/secure-storage`（v3+）。
 *
 * 适合 access_token / refresh_token 等敏感凭证。
 *
 * 注意：SecureStoragePlugin.get 在 key 不存在时抛错，本封装转成 null 返回。
 */
export function secureStorageStore(key: string): TokenStore {
  return {
    get: async (): Promise<string | null> => {
      const mod = (await import("@capacitor-community/secure-storage")) as SecureStorageModule;
      try {
        const { value } = await mod.SecureStoragePlugin.get({ key });
        return value;
      } catch {
        // key 不存在或读取失败 → 返回 null（与 TokenStore 语义一致）
        return null;
      }
    },
    set: async (token: string): Promise<void> => {
      const mod = (await import("@capacitor-community/secure-storage")) as SecureStorageModule;
      await mod.SecureStoragePlugin.set({ key, value: token });
    },
    clear: async (): Promise<void> => {
      const mod = (await import("@capacitor-community/secure-storage")) as SecureStorageModule;
      await mod.SecureStoragePlugin.remove({ key });
    },
  };
}

// ─── 原生文件下载 ───

/**
 * downloadFileNative —— Capacitor 原生文件下载（0 内存，直写磁盘）
 *
 * ## 为什么需要
 *
 * `api.download(url, { onChunk })` 走 fetch + ReadableStream，浏览器环境完美。
 * 但 Capacitor 环境下 capacitorFetch 适配的 CapacitorHttp 返回的 response.body
 * 是 null（一次性返回完整响应），流式下载退化到 blob 模式，大文件会 OOM。
 *
 * downloadFileNative 直接调用 @capacitor/filesystem 的 downloadFile，
 * 原生层（iOS NSURLSession / Android OkHttp）流式下载到磁盘，**0 字节进 JS 堆**。
 *
 * ## 适用场景
 *
 * - 服务端给的是静态文件 URL（如 http://xxxxx/xxx.pdf）
 * - 不需要走 middleware 链（鉴权/retry/envelope 解包）
 * - 大文件（>100MB）下载到本地存储
 *
 * ## 不适用场景
 *
 * - POST + body 下载（API 返回流）→ 用 api.download
 * - 需要 ABP envelope 解包 → 用 api.download
 * - 需要 401 refresh → 用 api.download（或 URL 自带签名 token）
 *
 * ## 进度事件
 *
 * Capacitor 的 progress: true 开启全局进度事件，通过 addListener('progress', ...) 接收。
 * 本封装自动注册/移除 listener，调用 onProgress(received, total)。
 *
 * ⚠️ 已知限制：progress listener 是全局的，多个 downloadFileNative 并发时
 *    进度事件会互相串。单文件下载场景（主要用例）无此问题。
 *
 * ## 迁移提示
 *
 * Capacitor 7.1+ 弃用了 Filesystem.downloadFile，推荐 @capacitor/file-transfer。
 * 本封装当前用 Filesystem（兼容 5/6/7），未来可加 file-transfer 分支。
 *
 * @example
 *   import { downloadFileNative } from "@xapiforge/adapter-capacitor";
 *
 *   const result = await downloadFileNative({
 *     url: "http://xxxxx/xxx.pdf",
 *     path: "reports/xxx.pdf",
 *     directory: "DOCUMENTS",
 *     onProgress: (received, total) => {
 *       console.log(`${received}/${total} bytes`);
 *     },
 *   });
 *   console.log(result.path);
 */

// ─── 内部类型（@capacitor/filesystem 的最小声明）───
// 不写进 package.json（AGENTS.md 约定），运行时动态 import，调用方自己装。
// 只声明 downloadFileNative 用到的 API；真实环境装了 @capacitor/filesystem 后，
// 业务侧项目用 node_modules 里的完整类型，本接口只在 adapter 包内有效。
interface CapacitorFilesystemLike {
  downloadFile(options: {
    url: string;
    path: string;
    directory: string;
    headers?: Record<string, string>;
    progress?: boolean;
  }): Promise<{ path?: string; blob?: unknown }>;
  addListener(
    eventName: "progress",
    listener: (event: { bytes: number; contentLength: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

interface FilesystemModule {
  Filesystem: CapacitorFilesystemLike;
  Directory: { Documents: string };
}

/** downloadFileNative 错误类型（保留原始 cause） */
export class DownloadFileNativeError extends Error {
  readonly code:
    | "MODULE_NOT_FOUND" // @capacitor/filesystem 未安装
    | "ABORTED" // 用户取消（signal aborted）
    | "DOWNLOAD_FAILED"; // 原生下载失败（网络/磁盘/权限等）
  override readonly cause: unknown;

  constructor(
    code: "MODULE_NOT_FOUND" | "ABORTED" | "DOWNLOAD_FAILED",
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "DownloadFileNativeError";
    this.code = code;
    this.cause = cause;
  }
}

/** downloadFileNative 配置 */
export interface DownloadFileNativeOptions {
  /** 文件 URL（如 http://xxxxx/xxx.pdf） */
  url: string;
  /** 本地存储路径（相对 directory，如 "reports/xxx.pdf"） */
  path: string;
  /**
   * 存储目录（Capacitor Directory enum 的字符串值）：
   * - "DOCUMENTS"（默认，iOS/Android 都可用）
   * - "CACHE"（临时缓存，系统可清理）
   * - "EXTERNAL"（Android 外部存储，iOS 不可用）
   */
  directory?: string;
  /**
   * 请求 headers（如鉴权 Authorization）。
   * 与 getHeaders 互斥；两者都传时 getHeaders 优先。
   */
  headers?: Record<string, string>;
  /**
   * 动态 headers 回调（下载前调用，支持 auth refresh）。
   *
   * 为什么需要：静态 headers 里的 token 可能已过期。getHeaders 在下载前调用，
   * 业务侧可在回调里先 `await authService.refreshIfNeeded()` 拿到最新 token，
   * 再返回 `{ Authorization: \`Bearer \${token}\` }`。
   *
   * 与 headers 合并：getHeaders 返回的值覆盖 headers 同名字段。
   */
  getHeaders?: () => Promise<Record<string, string>>;
  /** 下载进度回调（received bytes, total bytes） */
  onProgress?: (received: number, total: number) => void;
  /**
   * 取消信号。abort 后本函数立即 reject（code="ABORTED"）。
   *
   * ⚠️ 已知限制：Capacitor Filesystem.downloadFile 不支持原生 abort，
   * 原生下载会在后台继续，但 JS 侧 promise 已 reject，listener 已移除。
   * 业务侧应在 abort 后自行处理本地残留文件（如 Filesystem.deleteFile）。
   */
  signal?: AbortSignal;
  /** 日志（调试用，默认不输出） */
  logger?: Logger;
  /** @internal 测试用：注入 mock Filesystem 模块，覆盖默认 dynamic import */
  _loader?: () => Promise<unknown>;
}

/** downloadFileNative 返回值 */
export interface DownloadFileNativeResult {
  /** 本地文件路径（可用 Capacitor.convertFileSrc() 转 WebView 可访问的 URL） */
  path: string;
}

/**
 * Capacitor 原生文件下载（0 内存，直写磁盘）
 *
 * 内部用 @capacitor/filesystem 的 downloadFile，动态 import 避免编译时依赖。
 * 调用方需在自己 App 里安装 @capacitor/filesystem。
 *
 * ## 并发串行化
 *
 * Capacitor 的 progress listener 是全局事件，多个 downloadFileNative 并发时
 * 进度事件会互相串。本函数内部用串行队列保证同时只有一个下载在跑，
 * 多次调用会自动排队（FIFO）。
 *
 * @throws DownloadFileNativeError code:
 *   - "MODULE_NOT_FOUND": @capacitor/filesystem 未安装
 *   - "ABORTED": 用户 signal aborted
 *   - "DOWNLOAD_FAILED": 原生下载失败（cause 保留原始错误）
 */
export async function downloadFileNative(
  options: DownloadFileNativeOptions,
): Promise<DownloadFileNativeResult> {
  return downloadQueue.run(() => downloadFileNativeImpl(options));
}

// 串行队列：Capacitor progress listener 是全局事件，并发下载进度会串扰。
// 用单链表 Promise 链保证同时只有一个 downloadFileNative 在跑，后续调用排队。
interface DownloadQueue {
  tail: Promise<unknown>;
  run<T>(task: () => Promise<T>): Promise<T>;
}
const downloadQueue: DownloadQueue = {
  tail: Promise.resolve(),
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    // tail 链不断尾，防 unhandled rejection 警告（调用方自己 catch）
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  },
};

async function downloadFileNativeImpl(
  options: DownloadFileNativeOptions,
): Promise<DownloadFileNativeResult> {
  const log = options.logger;

  // 1. 检查 signal（开始前已 abort 直接拒绝）
  if (options.signal?.aborted) {
    throw new DownloadFileNativeError("ABORTED", "downloadFileNative aborted before start");
  }

  // 2. 动态加载 @capacitor/filesystem（避免编译时依赖）
  //    @capacitor/filesystem 不在 package.json 里（AGENTS.md 约定），调用方自己装。
  //    类型由 capacitor-modules.d.ts 提供；用 unknown 中转避免 ESLint no-unsafe-* 误报。
  //    _loader 供测试注入 mock（不触发真实 dynamic import）
  let mod: FilesystemModule;
  try {
    const raw: unknown = options._loader
      ? await options._loader()
      : await import("@capacitor/filesystem");
    mod = raw as FilesystemModule;
  } catch (e) {
    throw new DownloadFileNativeError(
      "MODULE_NOT_FOUND",
      `加载 @capacitor/filesystem 失败（${(e as Error).message}）。` +
        `请在 Capacitor 项目里调用，且已安装 @capacitor/filesystem（v5+）`,
      e,
    );
  }

  const { Filesystem, Directory } = mod;
  const directory = options.directory ?? Directory.Documents;

  // 3. 合并 headers（getHeaders 覆盖 headers 同名字段，支持 auth refresh）
  let headers = options.headers;
  if (options.getHeaders) {
    const dynamicHeaders = await options.getHeaders();
    headers = { ...headers, ...dynamicHeaders };
  }

  log?.debug("[downloadFileNative] start", {
    url: options.url,
    path: options.path,
    directory,
  });

  // 4. 注册进度 listener（Capacitor 的 progress 是全局事件）
  //    串行队列保证同时只有一个 listener，不会串扰
  let progressListener: { remove: () => Promise<void> } | null = null;
  if (options.onProgress) {
    progressListener = await Filesystem.addListener("progress", (event) => {
      options.onProgress!(event.bytes, event.contentLength);
    });
  }

  // 5. signal 监听（abort 后立即 reject，原生下载后台继续但 JS 侧已脱钩）
  let onAbort: (() => void) | null = null;
  if (options.signal) {
    onAbort = () => {
      // listener 移除由 finally 兜底，这里不重复
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // 用 Promise.race 让 signal abort 能立即 reject
    // 注意：Filesystem.downloadFile 的 promise 无法真正取消，abort 后它仍会 settle
    const downloadPromise = Filesystem.downloadFile({
      url: options.url,
      path: options.path,
      directory,
      headers,
      progress: !!options.onProgress,
    });

    const result = options.signal
      ? await raceWithSignal(downloadPromise, options.signal, "downloadFileNative")
      : await downloadPromise;

    const localPath = result.path ?? options.path;
    log?.debug("[downloadFileNative] done", { path: localPath });

    return { path: localPath };
  } catch (e) {
    // 区分 abort 和原生失败
    if (e instanceof DownloadFileNativeError) {
      throw e; // raceWithSignal 已包装
    }
    if (options.signal?.aborted) {
      throw new DownloadFileNativeError("ABORTED", "downloadFileNative aborted by user", e);
    }
    throw new DownloadFileNativeError(
      "DOWNLOAD_FAILED",
      `下载失败：${(e as Error).message ?? e}`,
      e,
    );
  } finally {
    if (onAbort && options.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
    await progressListener?.remove();
  }
}

/**
 * 用 signal 包装 promise：abort 时立即 reject，不等待原 promise settle。
 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DownloadFileNativeError("ABORTED", `${name} aborted before start`));
      return;
    }
    const onAbort = () => {
      reject(new DownloadFileNativeError("ABORTED", `${name} aborted by user`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // 原生下载失败，包装成 Error（外层 catch 再包成 DownloadFileNativeError）
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
