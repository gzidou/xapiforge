/**
 * @xapiforge/vconsole-debug
 *
 * 框架无关的 vConsole 业务调试面板。公共包只提供采集、脱敏、渲染和动作编排，
 * Vue/React/路由/认证等项目细节全部通过配置注入。
 */
export { createVConsoleDebugPlugin } from "./plugin.js";
export { clearStorageExcept, readStorageSnapshot } from "./storage.js";
export type {
  DebugAction,
  DebugActionContext,
  DebugActionRisk,
  DebugClipboard,
  DebugInfoItem,
  DebugInfoValue,
  DebugMessageTone,
  DebugPanelOptions,
  DebugSection,
  DebugStorageArea,
  MaybePromise,
  StorageLike,
  VConsoleConstructorLike,
  VConsolePluginLike,
  VConsoleTool,
} from "./types.js";
