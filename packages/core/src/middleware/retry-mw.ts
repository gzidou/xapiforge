/**
 * @xapiforge/core — createRetryMiddleware
 *
 * 429 退避 middleware：收到 429 → 读 Retry-After header → 抛 RetryableError。
 *
 * 工作流程：
 *
 *   onResponse:
 *     ┌─────────────────────────────────────┐
 *     │  status === 429 ?                   │
 *     │  ├─ 否 → return response            │
 *     │  └─ 是 → 读 Retry-After header       │
 *     │          ├─ 有 → retryAfterMs = 秒*1000 │
 *     │          └─ 无 → retryAfterMs = undefined │
 *     │          抛 RetryableError({ retryAfterMs }) │
 *     └─────────────────────────────────────┘
 *
 * createNet 的 retry loop catch RetryableError →
 *   sleep(retryDelayMs(attempt, retryAfterMs)) → 重发原请求
 *
 * Retry-After header 格式（RFC 7231）：
 *   - 秒数：Retry-After: 120
 *   - HTTP-date：Retry-After: Wed, 21 Oct 2026 07:28:00 GMT
 *   本实现只支持秒数（HTTP-date 较少见，v0.3 再加）。
 *
 * 多次重试：
 *   createNet 的 maxRetries 配置（默认 1，429 场景配 3-5）。
 *   每次重发都会走完整 middleware 链（auth + retry + 业务）。
 *   如果重试 maxRetries 次后仍 429，createNet 转为 ApiError(kind="rate-limit")。
 */

import { RetryableError } from "../errors.js";
import type { Middleware } from "../types.js";

export interface RetryMiddlewareConfig {
  /** 触发重试的 HTTP 状态码，默认 [429] */
  retryOnStatus?: number[];
  /**
   * 无 Retry-After header 时的默认退避（毫秒）。
   * 默认 1000。
   */
  defaultRetryMs?: number;
}

const DEFAULT_RETRY_STATUS = [429];
const DEFAULT_RETRY_MS = 1000;

export function createRetryMiddleware(config: RetryMiddlewareConfig = {}): Middleware {
  const retryStatuses = config.retryOnStatus ?? DEFAULT_RETRY_STATUS;
  const defaultRetryMs = config.defaultRetryMs ?? DEFAULT_RETRY_MS;

  return {
    onResponse({ response }) {
      if (!retryStatuses.includes(response.status)) return response;

      // 读 Retry-After header（秒数）
      const retryAfterHeader = response.headers.get("Retry-After");
      let retryAfterMs: number | undefined;

      if (retryAfterHeader) {
        // 尝试解析为秒数
        const seconds = Number(retryAfterHeader);
        if (!Number.isNaN(seconds) && seconds > 0) {
          retryAfterMs = seconds * 1000;
        }
        // HTTP-date 格式暂不支持（v0.3）
      }

      // 抛 RetryableError，让 createNet 退避重发
      throw new RetryableError(`retry: ${response.status}`, {
        retryAfterMs: retryAfterMs ?? defaultRetryMs,
        reason: "rate-limit",
        response,
      });
    },
  };
}
