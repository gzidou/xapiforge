/**
 * @xapiforge/genapi — swagger.json 下载（fetch + retry + URL 拼接）
 *
 * 原 @xapiforge/swagger-fetch 包合入 genapi。本模块只关心"下载一个 JSON"，
 * 业务项目通过 `xapiforge-fetch` CLI 调用。
 *
 * 设计原则：
 *   - 0 业务封装：只暴露 buildUrl / fetchSwaggerJson / 类型
 *   - 0 第三方依赖：直接用 node:fetch（Node 18+）
 *   - 自动 retry 一次（5xx / 网络抖动）
 *   - AbortController 超时
 *   - 校验 Content-Type 含 json + JSON.parse 合法性
 *
 * 类型从 ./index.js re-export，避免与 genapi 双份维护。
 */

import type { ServiceConfig, ProjectConfig } from "./index.js";

export type { ServiceConfig, ProjectConfig, XApiForgeConfig } from "./index.js";

export interface FetchOptions {
  /** 默认 swagger 路径，必须以 / 开头 */
  defaultPath: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /** 项目配置 */
  project: ProjectConfig;
  /** 要下载的服务名（必须在 project.services 里） */
  serviceName: string;
  /** 重试次数（默认 1，即 2 次请求） */
  retryOnce?: boolean;
}

export interface FetchResult {
  ok: boolean;
  /** 响应文本（成功时） */
  text?: string;
  /** 响应字节数（成功时） */
  bytes?: number;
  /** 错误信息（失败时） */
  error?: string;
  /** HTTP 状态码（失败时） */
  status?: number;
  /** 实际请求 URL（成功时，或 port: 0 占位时为 null） */
  url: string | null;
}

/**
 * 拼接 service URL。
 * port: 0 表示占位 / 暂未联调 → 返回 null（交给调用方决定怎么提示）。
 */
export function buildUrl(
  defaultPath: string,
  projectBaseHost: string,
  svc: ServiceConfig,
): string | null {
  if (svc.port === 0) return null;
  const path = svc.path ?? defaultPath;
  const host = (svc.baseHost ?? projectBaseHost).replace(/\/$/, "");
  const port = `:${svc.port}`;
  return `${host}${port}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * 单次 fetch（带超时）。
 */
async function fetchOnce(url: string, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 共识：无第三方 retry 库。手动 retry 一次（5xx / 网络抖动）。
 * 返回 { text, status } 抛错则由调用方记录。
 */
export async function downloadJson(
  url: string,
  timeoutMs: number,
  retryOnce = true,
): Promise<{ text: string; status: number }> {
  let lastErr: unknown;
  const attempts = retryOnce ? 2 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchOnce(url, timeoutMs);
      if (res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.toLowerCase().includes("json")) {
          throw new Error(`Content-Type 不是 JSON: ${ct || "<empty>"}`);
        }
        const text = await res.text();
        try {
          JSON.parse(text);
        } catch (e) {
          throw new Error(`响应不是合法 JSON: ${(e as Error).message}`);
        }
        return { text, status: res.status };
      }
      if (res.status >= 500 && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 一站式 "算 URL + 下载 + 校验"。
 * scripts 层只需 import 这个，调一下，写文件即可。
 */
export async function fetchSwaggerJson(opts: FetchOptions): Promise<FetchResult> {
  const svc = opts.project.services.find((s) => s.name === opts.serviceName);
  if (!svc) {
    return {
      ok: false,
      url: null,
      error: `service '${opts.serviceName}' not in project '${opts.project.name}'`,
    };
  }
  const url = buildUrl(opts.defaultPath, opts.project.baseHost, svc);
  if (url === null) {
    return {
      ok: true,
      url: null,
      bytes: 0,
    };
  }
  try {
    const { text } = await downloadJson(url, opts.timeoutMs, opts.retryOnce);
    return {
      ok: true,
      url,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
    };
  } catch (e) {
    const err = e as Error;
    const status = Number(err.message.match(/HTTP (\d+)/)?.[1]) || undefined;
    return {
      ok: false,
      url,
      error: err.message,
      status,
    };
  }
}

/** 格式化字节数（人类可读） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
