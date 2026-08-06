/**
 * demo-app 业务侧 middleware —— ABP envelope 解包
 *
 * ABP 后端响应格式（envelope）：
 *   成功: { "code": 0, "data": {...}, "message": "success" }
 *   失败: { "code": 40001, "data": null, "message": "token expired" }
 *
 * 本 middleware 职责：
 *   1. code=0  → 解包 data，替换 response body（业务侧拿到 data 而非 envelope）
 *   2. code!=0 且是鉴权码 → 抛 RetryableError({ needsRefresh: true })
 *      → createNet retry loop catch → authService.refreshIfNeeded() → 重发（新 token 注入）
 *   3. code!=0 且非鉴权码 → 抛 AbpBizError（业务错误）
 *
 * 为什么写在 demo-app 而不在 @xapiforge/core？
 *   因为 envelope 格式是业务侧的（ABP / 微信 / 自研协议各不同）。
 *   库只提供 RetryableError 这个「重试信号」，不关心 envelope 形状。
 *
 * middleware 执行顺序（onResponse 反序）：
 *   createNet 注入顺序: [auth, retry, httpError, abpUnwrap]
 *   onResponse 执行顺序: abpUnwrap → httpError → retry → auth
 *   所以 abpUnwrap 最先拿到 response，解包后 httpError/retry/auth 看到的是解包后的。
 *   但 httpError 只看 status（不看 body），所以顺序无关。
 *   auth 看 status===401，abpUnwrap 看的是 200 body 里的 envelope code（ABP 业务鉴权码）。
 *
 * 注意：ABP 业务鉴权码（40001/40002/41001）是 HTTP 200 + envelope code，
 *   与 HTTP 401 不同。本 middleware 把它转成 RetryableError 触发 refresh。
 */

import { RetryableError } from "@xapiforge/core";
import type { Middleware } from "@xapiforge/core";

/** ABP envelope 形状 */
interface AbpEnvelope<T = unknown> {
  code: number;
  data: T;
  message?: string;
}

/** ABP 业务鉴权码（触发 refresh） */
const ABP_AUTH_CODES = new Set([40001, 40002, 41001]);

/** ABP 业务错误（业务侧自定义错误类型，不在库里） */
export class AbpBizError extends Error {
  readonly code: number;
  override readonly message: string;
  constructor(code: number, message: string) {
    super(`ABP biz error ${code}: ${message}`);
    this.name = "AbpBizError";
    this.code = code;
    this.message = message;
  }
}

/**
 * 创建 ABP envelope 解包 middleware。
 *
 * @param authCodes 触发 refresh 的业务鉴权码，默认 [40001, 40002, 41001]
 */
export function createAbpUnwrapMw(authCodes: number[] = [...ABP_AUTH_CODES]): Middleware {
  const authCodeSet = new Set(authCodes);

  return {
    async onResponse({ response }) {
      // 非 2xx → HTTP 错误，交给 auth-mw（401）/ http-error-mw（5xx）处理
      // （openapi-fetch onResponse 是逆序，abpUnwrap 最先拿到 response；
      //   若不跳过，401 body 恰好是 {code:401,...} 会被误当业务错误抛 AbpBizError）
      if (!response.ok) return response;

      // 只处理有 body 的 JSON 响应
      const contentType = response.headers.get("Content-Type") ?? "";
      if (!contentType.includes("application/json")) {
        return response;
      }

      // 读 body（clone 后读，避免消费原 body）
      const text = await response.clone().text();
      if (!text) return response;

      let envelope: AbpEnvelope;
      try {
        envelope = JSON.parse(text) as AbpEnvelope;
      } catch {
        // 非 JSON（如纯文本错误页）→ 不处理
        return response;
      }

      // 不是 ABP envelope（无 code 字段）→ 不处理（可能是第三方格式）
      if (typeof envelope.code !== "number") {
        return response;
      }

      // code=0 → 成功，解包 data
      if (envelope.code === 0) {
        // 替换 response body 为 data（业务侧拿到 data 而非 envelope）
        const dataJson = JSON.stringify(envelope.data);
        const newRes = new Response(dataJson, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        return newRes;
      }

      // code!=0 且是鉴权码 → 抛 RetryableError({ needsRefresh: true })
      // createNet retry loop catch 后调 authService.refreshIfNeeded()，再重发
      if (authCodeSet.has(envelope.code)) {
        throw new RetryableError(`abp auth code ${envelope.code}: ${envelope.message ?? ""}`, {
          needsRefresh: true,
        });
      }

      // code!=0 且非鉴权码 → 抛 AbpBizError（业务错误）
      throw new AbpBizError(envelope.code, envelope.message ?? "unknown");
    },
  };
}
