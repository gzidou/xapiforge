// @capacitor/filesystem 最小类型声明
//
// 为什么需要：net-adapter-capacitor 不把 capacitor/filesystem 写进 package.json
// （AGENTS.md 约定：第三方 framework 依赖不放，让用户自己装）。
// 但 TS 的 import() 需要模块有类型声明，否则编译报 TS2307。
//
// 这个 .d.ts 只在 net-adapter-capacitor 包内有效（tsconfig include: src/**/*.ts）。
// 如果用户装了真实的 capacitor/filesystem，TS 会用 node_modules 里的完整类型，
// 本声明被覆盖（skipLibCheck: true 避免冲突）。
//
// 只声明 downloadFileNative 用到的 API，其他 API（readFile/writeFile 等）不声明。
// ⚠️ 修改时同步 index.ts 里的 CapacitorFilesystemLike / FilesystemModule 接口。
declare module "@capacitor/filesystem" {
  export interface DownloadFileOptions {
    url: string;
    path: string;
    directory: string;
    headers?: Record<string, string>;
    progress?: boolean;
  }
  export interface DownloadFileResult {
    path?: string;
    blob?: unknown;
  }
  export interface ProgressEvent {
    bytes: number;
    contentLength: number;
  }
  export interface PluginListenerHandle {
    remove(): Promise<void>;
  }
  export interface FilesystemPlugin {
    downloadFile(options: DownloadFileOptions): Promise<DownloadFileResult>;
    addListener(
      eventName: "progress",
      listener: (event: ProgressEvent) => void,
    ): Promise<PluginListenerHandle>;
  }
  export const Filesystem: FilesystemPlugin;
  export const Directory: {
    Documents: "DOCUMENTS";
    Cache: "CACHE";
    External: "EXTERNAL";
    Library: "LIBRARY";
  };
}

// @capacitor/preferences 最小类型声明
//
// 为什么需要：同 filesystem — net-adapter-capacitor 不把 capacitor/preferences 写进
// package.json（AGENTS.md 约定），但 TS import() 需要模块类型声明。
// 用户装了真实的 @capacitor/preferences 后，本声明被覆盖（skipLibCheck: true）。
declare module "@capacitor/preferences" {
  export interface GetOptions {
    key: string;
  }
  export interface SetOptions {
    key: string;
    value: string;
  }
  export interface RemoveOptions {
    key: string;
  }
  export interface GetResult {
    value: string | null;
  }
  export interface PreferencesPlugin {
    get(options: GetOptions): Promise<GetResult>;
    set(options: SetOptions): Promise<void>;
    remove(options: RemoveOptions): Promise<void>;
  }
  export const Preferences: PreferencesPlugin;
}

// @capacitor-community/secure-storage 最小类型声明
declare module "@capacitor-community/secure-storage" {
  export interface GetOptions {
    key: string;
  }
  export interface SetOptions {
    key: string;
    value: string;
  }
  export interface RemoveOptions {
    key: string;
  }
  export interface GetResult {
    value: string;
  }
  export interface SecureStoragePlugin {
    get(options: GetOptions): Promise<GetResult>;
    set(options: SetOptions): Promise<void>;
    remove(options: RemoveOptions): Promise<void>;
  }
  export const SecureStoragePlugin: SecureStoragePlugin;
}
