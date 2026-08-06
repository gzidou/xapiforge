/**
 * @xapiforge/core — 官方 middleware 汇总
 *
 * createNet 自动按固定顺序注入 3 个内核 middleware：
 *   - createAuthMiddleware     401 → refresh → 重发
 *   - createRetryMiddleware    429 → 退避重发
 *   - createHttpErrorMiddleware validateStatus 失败 → ApiError
 *
 * 业务侧自定义 middleware（envelope 解包 / 业务错误判定）写在业务代码里，
 * 不在库里。例如 demo-app 的 createAbpUnwrapMw / createWechatErrcodeMw。
 */

export { createAuthMiddleware } from "./auth-mw.js";
export type { RetryMiddlewareConfig } from "./retry-mw.js";
export { createRetryMiddleware } from "./retry-mw.js";
export type { HttpErrorMiddlewareConfig } from "./http-error-mw.js";
export { createHttpErrorMiddleware } from "./http-error-mw.js";
