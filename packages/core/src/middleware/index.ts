/**
 * @xapiforge/core — 官方 middleware 汇总
 *
 * createNet 自动按固定顺序注入 3 个内核 middleware：
 *   - createAuthMiddleware     401 → refresh → 重发
 *   - createRetryMiddleware    429 → 退避重发
 *   - createHttpErrorMiddleware validateStatus 失败 → ApiError
 *
 * 可选的官方业务 middleware（要在 NetConfig.middleware 里显式挂）：
 *   - createEnvelopeMiddleware  `{ code, data, msg }` 一族信封：按字段名解包 + 业务码 → ApiError(kind="business")
 *
 * 信封形状特殊、上面这个覆盖不了的（嵌套两层、数组根、业务 200 鉴权码要接刷新），仍由业务侧自写 middleware，
 * 例如 demo-app 的 createAbpUnwrapMw / createWechatErrcodeMw 和 docs/guides/middleware.md 的示例。
 */

export { createAuthMiddleware } from "./auth-mw.js";
export type { RetryMiddlewareConfig } from "./retry-mw.js";
export { createRetryMiddleware } from "./retry-mw.js";
export type { HttpErrorMiddlewareConfig } from "./http-error-mw.js";
export { createHttpErrorMiddleware } from "./http-error-mw.js";
export type { EnvelopeCode, EnvelopeMiddlewareConfig } from "./envelope-mw.js";
export { createEnvelopeMiddleware } from "./envelope-mw.js";
