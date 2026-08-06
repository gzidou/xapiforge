/**
 * file-saver.ts — 跨环境文件保存工具
 *
 * 前端写入磁盘的能力因宿主环境而异，没有统一标准 API：
 *
 * | 环境                    | 流式写盘 | API                              |
 * | ---------------------- | ------- | -------------------------------- |
 * | Chrome/Edge            | ✅      | File System Access API            |
 * | Safari/Firefox         | ❌      | Blob + `<a download>`（占内存）    |
 * | Capacitor (iOS/Android)| ✅      | @capacitor/filesystem              |
 * | Electron               | ✅      | Node.js fs                         |
 * | React Native           | ✅      | react-native-fs / expo-file-system |
 *
 * 本工具提供：
 *   1. saveBlobToFile(blob, filename)               — 通用浏览器下载（小文件）
 *   2. streamDownloadWithPicker(api, path, options)  — Chrome 流式下载写盘（大文件）
 *   3. createCapacitorChunkSaver(filename, directory) — Capacitor 流式写盘（大文件）
 *
 * 用法见 Scenarios.vue M9/M10 场景。
 */

import type { RegisteredApiClient } from "../api/init.js";

/** API client 类型（含 download 方法） */
type ApiClient = Pick<RegisteredApiClient, "download">;

/**
 * @capacitor/filesystem 的最小类型声明。
 *
 * demo-app 不是 Capacitor 项目，不安装 @capacitor/filesystem。
 * 此声明让 TS 能编译通过；在真实 Capacitor 项目里用真实的 @capacitor/filesystem。
 */
interface CapacitorFilesystemLike {
  writeFile(opts: {
    path: string;
    data: string;
    directory: string;
    recursive?: boolean;
  }): Promise<unknown>;
  appendFile(opts: { path: string; data: string; directory: string }): Promise<unknown>;
}

// ─── 类型工具 ───────────────────────────────────────────────

/**
 * 保存文件到磁盘的结果。
 */
export interface SaveResult {
  /** 保存方式 */
  method: "blob-download" | "fs-access-api" | "capacitor-filesystem";
  /** 保存的文件名 */
  filename: string;
  /** 文件大小（字节） */
  size: number;
  /** 耗时（毫秒） */
  elapsed: number;
}

// ─── 1. 通用浏览器下载（小文件，占内存）─────────────────────────

/**
 * 通用浏览器下载：创建 `<a download>` 触发浏览器下载。
 *
 * 适用所有浏览器，但文件全在内存（大文件会撑爆 webview）。
 * 适合 < 100MB 的小文件。
 *
 * @example
 * const result = await api.download("/api/file");
 * if (result.blob) {
 *   saveBlobToFile(result.blob, result.filename ?? "download.bin");
 * }
 */
export function saveBlobToFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // 清理：延迟移除（浏览器需要时间处理 download 事件）
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

// ─── 2. Chrome 流式下载写盘（大文件，不占内存）──────────────────

/**
 * 检测当前环境是否支持 File System Access API（仅 Chromium 浏览器）。
 */
export function isFileSystemAccessSupported(): boolean {
  return (
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function"
  );
}

/**
 * Chrome 流式下载：用 File System Access API 流式写盘，不占内存。
 *
 * 用户会看到系统文件保存对话框，选择保存位置后开始下载。
 * 每个 chunk 直接写磁盘，1GB+ 文件也不会撑爆内存。
 *
 * ⚠️ 仅 Chromium 浏览器（Chrome/Edge/Opera）支持。Safari/Firefox 不支持。
 *
 * @example
 * const result = await streamDownloadWithPicker(api, "/api/big-file", {
 *   suggestedName: "big-file.zip",
 *   onProgress: (received, total) => updateProgressBar(received, total),
 * });
 */
export async function streamDownloadWithPicker(
  api: ApiClient,
  path: string,
  options: {
    /** 建议的文件名（用户可在保存对话框修改） */
    suggestedName?: string;
    /** 下载进度回调 */
    onProgress?: (received: number, total: number | null) => void;
  } = {},
): Promise<SaveResult> {
  if (!isFileSystemAccessSupported()) {
    throw new Error(
      "File System Access API 不可用。请用 Chrome/Edge，或改用 saveBlobToFile（小文件）/ createCapacitorChunkSaver（移动端）。",
    );
  }

  const start = Date.now();
  const w = window as unknown as {
    showSaveFilePicker: (opts: { suggestedName?: string }) => Promise<{
      createWritable: () => Promise<{
        write: (data: Uint8Array | BlobPart) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };

  // 1. 弹出系统文件保存对话框
  const handle = await w.showSaveFilePicker({
    suggestedName: options.suggestedName,
  });
  const writable = await handle.createWritable();

  let received = 0;
  let filename = options.suggestedName ?? "download";

  try {
    // 2. 流式下载 + 写盘（onChunk 每个 chunk 直接写磁盘，不累积到内存）
    const result = await api.download(path, {
      onProgress: options.onProgress,
      onChunk: async (chunk, _received, _total) => {
        await writable.write(chunk);
        received = _received;
      },
    });

    // 从 Content-Disposition 提取文件名（如果服务端提供了）
    if (result.filename) {
      filename = result.filename;
    }
  } finally {
    // 3. 关闭写入流（无论成功失败）
    await writable.close();
  }

  return {
    method: "fs-access-api",
    filename,
    size: received,
    elapsed: Date.now() - start,
  };
}

// ─── 3. Capacitor 流式下载写盘（移动端，不占内存）──────────────

/**
 * 检测当前是否在 Capacitor 原生环境（iOS/Android webview）。
 */
export function isCapacitorNative(): boolean {
  return (
    typeof (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform === "function" &&
    (
      window as unknown as { Capacitor: { isNativePlatform: () => boolean } }
    ).Capacitor.isNativePlatform()
  );
}

/**
 * Capacitor 文件系统目录（与 @capacitor/filesystem 的 Directory 枚举对应）。
 *
 * 用 string 而非 import @capacitor/filesystem，避免 demo-app 编译时找不到包
 * （按 AGENTS.md 约定，第三方 framework 依赖不写进 package.json）。
 */
export type CapacitorDirectory =
  | "Documents" // 用户文档目录（可被 iTunes/文件管理器访问）
  | "Data" // 应用数据目录（不被用户直接访问）
  | "Cache" // 缓存目录（系统可清理）
  | "External"; // 外部存储（Android only）

/**
 * Capacitor chunk 写入器的接口（由 createCapacitorChunkSaver 返回）。
 *
 * 为什么需要 firstChunk 参数？
 *   Capacitor Filesystem.writeFile 会覆盖文件，appendFile 会追加。
 *   第一个 chunk 用 writeFile，后续用 appendFile。
 */
export interface CapacitorChunkWriter {
  /** 写入一个 chunk（内部自动区分首次/追加） */
  write: (chunk: Uint8Array) => Promise<void>;
  /** 完成写入（关闭文件句柄等清理） */
  close: () => Promise<void>;
}

/**
 * Uint8Array → base64（Capacitor Filesystem API 要求 base64 编码）。
 *
 * ⚠️ base64 编码有 33% 体积膨胀，且大 chunk 转换占 CPU。
 * 生产环境建议 chunk 大小控制在 64KB-256KB。
 */
export function uint8ArrayToBase64(data: Uint8Array): string {
  // 分块转换避免 call stack overflow（大 chunk 时 fromCharCode 展开会爆栈）
  const CHUNK_SIZE = 0x8000; // 32KB
  let result = "";
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const slice = data.subarray(i, i + CHUNK_SIZE);
    result += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(result);
}

/**
 * 创建 Capacitor 流式写入器。
 *
 * 返回一个 { write, close } 写入器，业务侧在 onChunk 里调 write(chunk)。
 *
 * ⚠️ 此函数需要 @capacitor/filesystem 运行时。demo-app 不是 Capacitor 项目
 *   不会实际调用，仅作示例。在 Ionic/Capacitor 项目里使用时，确保已安装：
 *   `pnpm add @capacitor/filesystem`
 *
 * @example
 * // 在 Capacitor 项目里：
 * import { Filesystem } from "@capacitor/filesystem";
 *
 * const saver = await createCapacitorChunkSaver("big-file.zip", "Documents");
 * await api.download("/api/big-file", {
 *   onChunk: async (chunk) => { await saver.write(chunk); },
 *   onProgress: (received, total) => updateProgressBar(received, total),
 * });
 * await saver.close();
 *
 * // 文件保存到：iOS ~/Documents/big-file.zip / Android Documents/big-file.zip
 */
export async function createCapacitorChunkSaver(
  filename: string,
  directory: CapacitorDirectory = "Documents",
): Promise<CapacitorChunkWriter> {
  if (!isCapacitorNative()) {
    throw new Error(
      `createCapacitorChunkSaver 只能在 Capacitor 原生环境使用（当前非原生平台）。` +
        `浏览器请用 streamDownloadWithPicker（Chrome）或 saveBlobToFile（通用）。`,
    );
  }

  // 动态 import @capacitor/filesystem（避免 demo-app 编译时找不到包）
  // 在 Capacitor 项目里这行能正常解析；在 demo-app 里不会执行到这里
  // @ts-expect-error — demo-app 未安装 @capacitor/filesystem，仅在 Capacitor 项目里解析
  const mod = (await import(/* @vite-ignore */ "@capacitor/filesystem")) as {
    Filesystem: CapacitorFilesystemLike;
  };
  const Filesystem = mod.Filesystem;

  let isFirstChunk = true;

  return {
    async write(chunk: Uint8Array): Promise<void> {
      const base64 = uint8ArrayToBase64(chunk);
      if (isFirstChunk) {
        // 首次写入：createFile（覆盖已存在的同名文件）
        await Filesystem.writeFile({
          path: filename,
          data: base64,
          directory,
          recursive: true,
        });
        isFirstChunk = false;
      } else {
        // 后续：追加
        await Filesystem.appendFile({
          path: filename,
          data: base64,
          directory,
        });
      }
    },
    async close(): Promise<void> {
      // Capacitor Filesystem 没有"关闭流"的概念，write/appendFile 是独立的原子操作
      // 这里留作扩展点（未来可用原生插件实现真正的 stream write）
    },
  };
}

/**
 * Capacitor 流式下载（封装 createCapacitorChunkSaver + api.download）。
 *
 * @example
 * const result = await streamDownloadCapacitor(api, "/api/big-file", {
 *   filename: "big-file.zip",
 *   directory: "Documents",
 *   onProgress: (received, total) => updateProgressBar(received, total),
 * });
 * console.log(`已保存到 ${result.path}, ${result.size} bytes`);
 */
export async function streamDownloadCapacitor(
  api: ApiClient,
  path: string,
  options: {
    filename: string;
    directory?: CapacitorDirectory;
    onProgress?: (received: number, total: number | null) => void;
  },
): Promise<SaveResult & { path: string }> {
  const start = Date.now();
  const filename = options.filename;
  const directory = options.directory ?? "Documents";

  const saver = await createCapacitorChunkSaver(filename, directory);
  let received = 0;

  try {
    const result = await api.download(path, {
      onProgress: options.onProgress,
      onChunk: async (chunk, _received) => {
        await saver.write(chunk);
        received = _received;
      },
    });
    // 服务端文件名优先
    const finalName = result.filename ?? filename;
    return {
      method: "capacitor-filesystem",
      filename: finalName,
      size: received,
      elapsed: Date.now() - start,
      path: `${directory}/${finalName}`,
    };
  } finally {
    await saver.close();
  }
}
