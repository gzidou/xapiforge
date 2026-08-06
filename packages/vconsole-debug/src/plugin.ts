import { readStorageSnapshot } from "./storage.js";
import type {
  DebugAction,
  DebugActionContext,
  DebugInfoValue,
  DebugMessageTone,
  DebugPanelOptions,
  VConsoleConstructorLike,
  VConsolePluginLike,
} from "./types.js";

const DEFAULT_PLUGIN_ID = "xapiforge-business-debug";
const DEFAULT_PLUGIN_NAME = "业务调试";
const MASKED_VALUE = "[已脱敏]";

interface ResolvedInfoItem {
  label: string;
  value: string;
}

interface ResolvedSection {
  title: string;
  items: ResolvedInfoItem[];
}

interface ResolvedStorageArea {
  label: string;
  entries: ReturnType<typeof readStorageSnapshot>;
  error?: string;
}

interface DebugSnapshot {
  capturedAt: string;
  sections: ResolvedSection[];
  storageAreas: ResolvedStorageArea[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeValue(value: DebugInfoValue): string {
  if (value === null) return "null";
  if (value === undefined || value === "") return "-";
  return String(value);
}

function riskColor(risk: DebugAction["risk"]): string {
  if (risk === "danger") return "#ee0a24";
  if (risk === "warning") return "#ed6a0c";
  return "#1989fa";
}

function messageColor(tone: DebugMessageTone): string {
  if (tone === "success") return "#07c160";
  if (tone === "error") return "#ee0a24";
  return "#1989fa";
}

async function resolveSnapshot(options: DebugPanelOptions): Promise<DebugSnapshot> {
  const sections = await Promise.all(
    (options.sections ?? []).map(async (section): Promise<ResolvedSection> => ({
      title: section.title,
      items: await Promise.all(
        section.items.map(async (item): Promise<ResolvedInfoItem> => {
          try {
            const value = item.sensitive ? MASKED_VALUE : normalizeValue(await item.getValue());
            return { label: item.label, value };
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { label: item.label, value: `[读取失败] ${message}` };
          }
        }),
      ),
    })),
  );

  const storageAreas = (options.storageAreas ?? []).map((area): ResolvedStorageArea => {
    try {
      return { label: area.label, entries: readStorageSnapshot(area) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { label: area.label, entries: [], error: message };
    }
  });

  return {
    capturedAt: new Date().toISOString(),
    sections,
    storageAreas,
  };
}

function renderSection(section: ResolvedSection): string {
  const items = section.items
    .map(
      (item) => `
        <div style="display:grid;grid-template-columns:minmax(92px,34%) 1fr;gap:8px;padding:5px 0;border-bottom:1px solid #f2f3f5;">
          <span style="color:#646566;">${escapeHtml(item.label)}</span>
          <span style="color:#323233;word-break:break-all;">${escapeHtml(item.value)}</span>
        </div>`,
    )
    .join("");

  return `
    <section style="margin-bottom:14px;">
      <div style="margin-bottom:4px;font-weight:600;color:#323233;">${escapeHtml(section.title)}</div>
      ${items || '<div style="color:#969799;">暂无信息</div>'}
    </section>`;
}

function renderStorageArea(area: ResolvedStorageArea): string {
  const entries = area.entries
    .map(
      (entry) => `
        <div style="padding:5px 0;border-bottom:1px solid #f2f3f5;">
          <div style="color:#323233;word-break:break-all;">${escapeHtml(entry.key)}</div>
          <div style="color:#969799;word-break:break-all;">${escapeHtml(entry.value)}</div>
        </div>`,
    )
    .join("");

  return `
    <section style="margin-bottom:14px;">
      <div style="margin-bottom:4px;font-weight:600;color:#323233;">${escapeHtml(area.label)}（${area.entries.length} 项）</div>
      ${area.error ? `<div style="color:#ee0a24;">读取失败：${escapeHtml(area.error)}</div>` : entries || '<div style="color:#969799;">当前为空</div>'}
    </section>`;
}

function snapshotToText(snapshot: DebugSnapshot): string {
  const lines = [`采集时间：${snapshot.capturedAt}`];
  snapshot.sections.forEach((section) => {
    lines.push("", `[${section.title}]`);
    section.items.forEach((item) => lines.push(`${item.label}：${item.value}`));
  });
  snapshot.storageAreas.forEach((area) => {
    lines.push("", `[${area.label}]`);
    if (area.error) {
      lines.push(`读取失败：${area.error}`);
      return;
    }
    if (area.entries.length === 0) lines.push("(空)");
    area.entries.forEach((entry) => lines.push(`${entry.key}=${entry.value}`));
  });
  return lines.join("\n");
}

async function defaultCopyText(text: string): Promise<void> {
  if (globalThis.navigator?.clipboard) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }

  const textarea = globalThis.document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  globalThis.document.body.append(textarea);
  textarea.select();
  const copied = globalThis.document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("当前 WebView 不支持复制诊断信息");
}

/**
 * 创建框架无关的 vConsole 业务调试插件。
 *
 * 使用方通过 sections、storageAreas 和 actions 注册业务能力；本模块统一负责：
 * - 动态采集与脱敏
 * - HTML 安全转义
 * - 动作确认、执行状态和失败反馈
 * - 复制脱敏诊断信息
 *
 * 模块不依赖 Vue/React/Vant，也不直接依赖 vconsole npm 包。
 */
export function createVConsoleDebugPlugin(
  VConsole: VConsoleConstructorLike,
  options: DebugPanelOptions,
): VConsolePluginLike {
  const pluginId = options.pluginId ?? DEFAULT_PLUGIN_ID;
  const rootId = `${pluginId}-root`;
  const contentId = `${pluginId}-content`;
  const messageId = `${pluginId}-message`;
  const plugin = new VConsole.VConsolePlugin(pluginId, options.pluginName ?? DEFAULT_PLUGIN_NAME);
  let boundRoot: HTMLElement | null = null;

  const setMessage = (message: string, tone: DebugMessageTone = "info"): void => {
    const element = globalThis.document.getElementById(messageId);
    if (!element) return;
    element.textContent = message;
    element.style.color = messageColor(tone);
  };

  const refresh = async (): Promise<void> => {
    const content = globalThis.document.getElementById(contentId);
    if (!content) return;
    const snapshot = await resolveSnapshot(options);
    content.innerHTML = [
      ...snapshot.sections.map(renderSection),
      ...snapshot.storageAreas.map(renderStorageArea),
    ].join("");
  };

  const copyDiagnostics = async (): Promise<void> => {
    const snapshot = await resolveSnapshot(options);
    const text = snapshotToText(snapshot);
    if (options.clipboard) await options.clipboard.writeText(text);
    else await defaultCopyText(text);
    setMessage("脱敏诊断信息已复制", "success");
  };

  const context: DebugActionContext = { refresh, copyDiagnostics, setMessage };

  const runTool = (label: string, task: () => Promise<void>): void => {
    void task().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${options.pluginName ?? DEFAULT_PLUGIN_NAME}] ${label}失败`, error);
      setMessage(`${label}失败：${message}`, "error");
    });
  };

  const runAction = async (action: DebugAction): Promise<void> => {
    try {
      if (action.confirmMessage) {
        const confirmed = options.confirm
          ? await options.confirm(action.confirmMessage)
          : globalThis.confirm(action.confirmMessage);
        if (!confirmed) return;
      }

      setMessage(`正在执行：${action.label}`);
      await action.run(context);
      await refresh();
      setMessage(action.successMessage ?? `${action.label}已完成`, "success");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${options.pluginName ?? DEFAULT_PLUGIN_NAME}] ${action.label}失败`, error);
      setMessage(`${action.label}失败：${message}`, "error");
    }
  };

  const clickHandler = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || !boundRoot?.contains(target)) return;
    const button = target.closest<HTMLElement>("[data-debug-action]");
    const actionId = button?.dataset.debugAction;
    if (!actionId) return;
    const action = options.actions?.find((candidate) => candidate.id === actionId);
    if (action) void runAction(action);
  };

  const bindPanel = (): void => {
    const root = globalThis.document.getElementById(rootId);
    if (!root || root === boundRoot) return;
    boundRoot?.removeEventListener("click", clickHandler);
    root.addEventListener("click", clickHandler);
    boundRoot = root;
  };

  const unbindPanel = (): void => {
    boundRoot?.removeEventListener("click", clickHandler);
    boundRoot = null;
  };

  const actionButtons = (options.actions ?? [])
    .map(
      (action) => `
        <button
          type="button"
          data-debug-action="${escapeHtml(action.id)}"
          style="width:100%;margin-top:8px;padding:9px 12px;border:1px solid ${riskColor(action.risk)};border-radius:6px;background:#fff;color:${riskColor(action.risk)};text-align:left;"
        >
          <span style="display:block;font-weight:600;">${escapeHtml(action.label)}</span>
          ${action.description ? `<span style="display:block;margin-top:2px;font-size:12px;color:#969799;">${escapeHtml(action.description)}</span>` : ""}
        </button>`,
    )
    .join("");

  plugin.on("renderTab", (render) => {
    render(`
      <div id="${escapeHtml(rootId)}" style="padding:12px 14px;line-height:1.6;">
        <div id="${escapeHtml(contentId)}" style="color:#969799;">正在读取诊断信息…</div>
        ${actionButtons ? `<section style="margin-top:12px;"><div style="font-weight:600;color:#323233;">调试操作</div>${actionButtons}</section>` : ""}
        <div id="${escapeHtml(messageId)}" style="min-height:22px;margin-top:10px;color:#1989fa;"></div>
        <div style="margin-top:6px;color:#969799;">任意键值编辑请使用 vConsole 自带的 Storage 面板。</div>
      </div>
    `);
  });

  plugin.on("addTool", (addTools) => {
    addTools([
      { name: "刷新", global: false, onClick: () => runTool("刷新", refresh) },
      { name: "复制诊断", global: false, onClick: () => runTool("复制诊断", copyDiagnostics) },
    ]);
  });

  const preparePanel = (): void => {
    bindPanel();
    void refresh();
  };
  plugin.on("ready", preparePanel);
  plugin.on("show", preparePanel);
  plugin.on("remove", unbindPanel);

  return plugin;
}
