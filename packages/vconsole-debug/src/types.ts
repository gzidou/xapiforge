export type MaybePromise<T> = T | Promise<T>;

export type DebugInfoValue = string | number | boolean | null | undefined;

/** 调试面板中的一项动态诊断信息。敏感项只显示占位符，也不会进入复制结果。 */
export interface DebugInfoItem {
  label: string;
  getValue: () => MaybePromise<DebugInfoValue>;
  sensitive?: boolean;
}

/** 将相关诊断信息组织为一个可维护的分组。 */
export interface DebugSection {
  id: string;
  title: string;
  items: readonly DebugInfoItem[];
}

export type DebugActionRisk = "normal" | "warning" | "danger";
export type DebugMessageTone = "info" | "success" | "error";

export interface DebugActionContext {
  refresh(): Promise<void>;
  copyDiagnostics(): Promise<void>;
  setMessage(message: string, tone?: DebugMessageTone): void;
}

/**
 * 业务侧注册的调试动作。
 *
 * 公共包只负责确认、执行、反馈和刷新；具体业务清理逻辑由使用方注入。
 */
export interface DebugAction {
  id: string;
  label: string;
  description?: string;
  risk?: DebugActionRisk;
  confirmMessage?: string;
  successMessage?: string;
  run: (context: DebugActionContext) => MaybePromise<void>;
}

/** 浏览器 Storage 的最小协议，便于测试或非 window 宿主注入兼容实现。 */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

/** 调试面板展示的一个存储区。任意编辑仍交给 vConsole 自带 Storage 面板。 */
export interface DebugStorageArea {
  id: string;
  label: string;
  storage: StorageLike;
  isSensitiveKey?: (key: string) => boolean;
  valuePreviewLength?: number;
}

export interface DebugClipboard {
  writeText(text: string): MaybePromise<void>;
}

export interface DebugPanelOptions {
  pluginId?: string;
  pluginName?: string;
  sections?: readonly DebugSection[];
  storageAreas?: readonly DebugStorageArea[];
  actions?: readonly DebugAction[];
  confirm?: (message: string) => MaybePromise<boolean>;
  clipboard?: DebugClipboard;
}

export interface VConsoleTool {
  name: string;
  global?: boolean;
  onClick: () => void;
}

export type RenderTabCallback = (html: string) => void;
export type AddToolCallback = (tools: VConsoleTool[]) => void;

export interface VConsolePluginLike {
  on(eventName: "renderTab", callback: (render: RenderTabCallback) => void): this;
  on(eventName: "addTool", callback: (addTools: AddToolCallback) => void): this;
  on(eventName: "ready" | "show" | "remove", callback: () => void): this;
}

export interface VConsolePluginConstructorLike {
  new (id: string, name: string): VConsolePluginLike;
}

/** vConsole 默认导出类需要满足的最小静态协议。 */
export interface VConsoleConstructorLike {
  VConsolePlugin: VConsolePluginConstructorLike;
}
