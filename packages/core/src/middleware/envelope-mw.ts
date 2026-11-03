/**
 * @xapiforge/core — createEnvelopeMiddleware（通用信封解包）
 *
 * 为什么有这个文件：
 *   国内后端大多把业务数据包在一层信封里（协议库 A2 / A5 / A14 这一族）：
 *     { "code": 0, "data": {...}, "msg": "ok" }
 *     { "code": 200, "data": {...}, "message": "success" }
 *     { "success": true, "data": {...} }
 *   以前每个工程都要照 docs/guides/middleware.md 的示例抄一遍解包 middleware，
 *   字段名、成功码、错误类型各抄各的。这里把「按字段名解包 + 业务码判失败」做成一个可配置的官方 middleware。
 *
 * 做了什么（onResponse，在内核 auth / retry / httpError 之前执行）：
 *   1. 非 2xx、明确是二进制的（图片 / 音视频 / octet-stream / pdf / zip）、空 body → 原样放行，交给内核
 *      （401 → auth、429 → retry、其余 → httpError）。
 *   2. 是不是信封按内容判，不按 Content-Type 判：有的后端把 JSON 标成 `text/html`、`text/plain`，
 *      只认 json 类型就会把这种信封（包括业务失败、鉴权码）原样漏给业务。解析不了 JSON → 原样放行，
 *      openapi-fetch 解析时会再失败，由 createNet 归一为 ApiError(kind="parse")；纯文本接口同理不受影响。
 *   3. body 不是对象或没有 `code` 字段 → 抛 ApiError(kind="parse")：既然工程声明了这是信封协议，
 *      拿到不是信封的东西就是后端或配置写错，当场报错比静默透传更容易发现。
 *   4. `code` 等于 `ok` 之一 → 成功：用 `data` 字段替换响应体，业务拿到的 data 就是解包后的数据。
 *   5. 否则 → 业务失败：抛 ApiError(kind="business")，message 取 `message` 字段（没有就用兜底文案），
 *      code 取业务码，body 是完整信封，供页面做精细分支。
 *
 * 不做什么：
 *   - 不自动探测字段名、不内置任何后端的预置（ABP / 微信 / Spring 都要显式写字段名）。
 *   - 不处理「业务 200 + 鉴权码」（A14）：那是会话层的事——由调用方在更底层的 fetch 包装里判定并接刷新链，
 *     或像 docs/guides/middleware.md 示例那样自写 middleware 抛 RetryableError。两处都做会把同一件事分散两层。
 *   - 不做 code 的类型转换：`ok: 0` 不会匹配 `"0"`，后端返字符串码就写 `ok: "0"`（或 `ok: [0, "0"]`）。
 *
 * 用法：
 *   const api = createNet<Paths>({
 *     baseURL,
 *     authService,
 *     middleware: [createEnvelopeMiddleware({ code: "code", data: "data", message: "msg", ok: 200 })],
 *   });
 *   // 后端返 { code: 200, data: { id: 1 }, msg: "ok" } → api.GET(...) 的 data 是 { id: 1 }
 *   // 后端返 { code: 500, data: null, msg: "库存不足" } → reject ApiError{ kind: "business", code: 500, message: "库存不足" }
 */

import { ApiError } from "../errors.js";
import type { Middleware } from "../types.js";

/** 信封里业务码字段可能的取值类型；布尔是给 `{ success: true }` 这种形状用的。 */
export type EnvelopeCode = number | string | boolean;

export interface EnvelopeMiddlewareConfig {
  /** 业务码字段名，如 `"code"`、`"errcode"`、`"success"`。 */
  code: string;
  /** 业务数据字段名，如 `"data"`、`"result"`。成功时用这个字段的值替换响应体。 */
  data: string;
  /** 错误文案字段名，如 `"msg"`、`"message"`、`"errmsg"`。不写则业务失败时只有兜底文案。 */
  message?: string;
  /**
   * 表示成功的业务码，一个或多个，严格相等比较。
   * 例：ABP 风格 `0`；Spring 风格 `200`；`{ success: true }` 写 `true`；后端混用时写 `[0, "0"]`。
   */
  ok: EnvelopeCode | readonly EnvelopeCode[];
}

/** 明确声明为二进制的 Content-Type：不读成文本（文件可能很大，也不可能是信封）。 */
const BINARY_CONTENT_TYPE = /^(image|audio|video)\/|^application\/(octet-stream|pdf|zip)/;

/**
 * 响应是不是明确的二进制。例：`image/png` → true；`text/html;charset=UTF-8`、`application/json`、没有 Content-Type → false。
 */
function isBinary(response: Response): boolean {
  return BINARY_CONTENT_TYPE.test(response.headers.get("content-type")?.toLowerCase().trim() ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从信封里取可展示的错误文案：字段存在、是字符串、去空白后非空才算。
 * 例：({ msg: " 库存不足 " }, "msg") → "库存不足"；({ msg: "" }, "msg") → undefined；(body, undefined) → undefined。
 */
function readMessage(body: Record<string, unknown>, field: string | undefined): string | undefined {
  if (!field) return undefined;
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 用解包后的数据构造新的 Response，状态和响应头沿用原响应。
 *
 * 原响应头里的 Content-Length 是信封的长度，与新 body 不符，去掉；
 * `data` 字段缺失（undefined）时给空 body 并显式 Content-Length: 0——openapi-fetch 看到 Content-Length 为 0
 * 直接返回 `data: undefined`，不会去 JSON.parse 空字符串而报 parse 错。
 */
function replaceBody(response: Response, data: unknown): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (data === undefined) {
    headers.set("content-length", "0");
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return new Response(JSON.stringify(data), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 创建通用信封解包 middleware。字段名与成功码全部显式配置，见文件头。
 *
 * @example Spring `{ code, msg, data }`，200 为成功
 *   createEnvelopeMiddleware({ code: "code", data: "data", message: "msg", ok: 200 })
 * @example `{ success, result, message }`，布尔成功位
 *   createEnvelopeMiddleware({ code: "success", data: "result", message: "message", ok: true })
 */
export function createEnvelopeMiddleware(config: EnvelopeMiddlewareConfig): Middleware {
  const okCodes = new Set<EnvelopeCode>(Array.isArray(config.ok) ? config.ok : [config.ok]);

  return {
    async onResponse({ response }) {
      // 非 2xx 交给内核：401 要走 auth refresh，429 要退避，其余由 httpError 归一化。
      // 这里若去读 401 的 body（常常恰好也是 {code:401,...}）会把会话失效误报成业务错误。
      if (!response.ok) return response;

      if (isBinary(response)) return response;

      // clone 后读，原 response 的 body 留给 openapi-fetch。
      const text = await response.clone().text();
      if (!text) return response;

      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // 下游 openapi-fetch 解析同样会失败，由 createNet 统一归一为 parse 错，这里不重复判定。
        return response;
      }

      if (!isRecord(body) || !(config.code in body)) {
        throw new ApiError({
          kind: "parse",
          message: `响应不是预期的信封格式（缺少 ${config.code} 字段）`,
          response,
          body,
        });
      }

      const code = body[config.code] as EnvelopeCode;
      if (okCodes.has(code)) {
        return replaceBody(response, body[config.data]);
      }

      throw new ApiError({
        kind: "business",
        message: readMessage(body, config.message) ?? `请求失败（业务码 ${String(code)}）`,
        code: typeof code === "boolean" ? String(code) : code,
        response,
        body,
      });
    },
  };
}
