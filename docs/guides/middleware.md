# 自定义 middleware

> 本文档详解 `@xapiforge/core` 的 middleware 机制：执行顺序、内核 middleware、业务 middleware 写法。

## middleware 架构

```text
请求 → auth → 业务 middleware → fetch
响应 ← validateStatus ← auth ← retry ← 业务 middleware ← fetch
```

**执行顺序**：

| 阶段       | 顺序            | 说明                                                |
| ---------- | --------------- | --------------------------------------------------- |
| onRequest  | 正序（auth 先） | auth 注入 token，业务 middleware 改 body/headers    |
| onResponse | 反序（业务先）  | 业务解包 → 429 retry → 401 refresh → 最终状态归一化 |

**内核 middleware（createNet 自动注入，无需配置）**：

| middleware      | 职责                                                           |
| --------------- | -------------------------------------------------------------- |
| `auth-mw`       | 注入 Authorization header，401 → refresh → 通知 createNet 重发 |
| `retry-mw`      | 429 → RetryableError，createNet 退避并重发                     |
| `http-error-mw` | 最终响应未通过 validateStatus → ApiError                       |

**业务 middleware（在 `NetConfig.middleware` 显式配置）**：

- envelope 解包：常见的 `{ code, data, msg }` 一族用官方 [`createEnvelopeMiddleware`](#官方信封中间件-createenvelopemiddleware) 配字段名；嵌套、数组根、要接刷新链的鉴权码等特殊形状业务侧自写（见下面示例）
- 请求/响应日志
- 请求改写（加 header / 改 path）
- 响应转换（日期格式化 / 字段映射）

## middleware 类型

```typescript
import type { Middleware } from "@xapiforge/core";

const myMiddleware: Middleware = {
  // 请求前（可选）
  async onRequest({ schemaPath, params }) {
    // 改请求
    params.headers = { ...params.headers, "X-Custom": "value" };
    return params; // 返回修改后的 params
  },

  // 响应后（可选）
  async onResponse({ response, schemaPath }) {
    // 改响应
    if (response.ok) {
      const data = await response.clone().json();
      // ...
    }
    return response; // 返回修改后的 response
  }
};
```

## 官方信封中间件 createEnvelopeMiddleware

国内后端大多把业务数据包在一层信封里（[后端协议库](../internals/backend-protocols.md) A2 / A5 / A14 这一族）。
这类「按字段名解包 + 业务码判失败」不必每个工程抄一遍示例，用官方中间件按字段名配置即可：

```typescript
import { createEnvelopeMiddleware, createNet } from "@xapiforge/core";

// 后端：成功 { code: 200, data: {...}, msg: "ok" }；失败 { code: 500, data: null, msg: "库存不足" }
const api = createNet<Paths>({
  baseURL,
  authService,
  middleware: [createEnvelopeMiddleware({ code: "code", data: "data", message: "msg", ok: 200 })]
});

const { data } = await api.GET("/orders/{id}", { params: { path: { id: "1" } } }); // data 已是解包后的业务数据
// 业务失败 → reject ApiError { kind: "business", code: 500, message: "库存不足", body: 完整信封 }
```

| 配置      | 含义                                                      | 例                                 |
| --------- | --------------------------------------------------------- | ---------------------------------- |
| `code`    | 业务码字段名                                              | `"code"`、`"errcode"`、`"success"` |
| `data`    | 业务数据字段名；成功时用它的值替换响应体                  | `"data"`、`"result"`               |
| `message` | 错误文案字段名（可选）；业务失败时作为 `ApiError.message` | `"msg"`、`"message"`、`"errmsg"`   |
| `ok`      | 成功码，一个或多个，**严格相等**，不做类型转换            | `0`、`200`、`true`、`[0, "0"]`     |

行为规则：

- 是不是信封按内容判，不看 Content-Type 是不是 json：有的后端把 JSON 标成 `text/html`，照样解包 / 判业务失败。明确声明为二进制（图片、音视频、`octet-stream`、`pdf`、`zip`）的不读。
- 非 2xx、二进制、空 body、解析不了的（纯文本、非法 JSON）：原样放行。401 交给 `auth-mw` 刷新，429 交给 `retry-mw`，其余交给 `http-error-mw`；非法 JSON 由 createNet 归一为 `ApiError(kind="parse")`。
- 2xx JSON 但不是对象或没有 `code` 字段：抛 `ApiError(kind="parse")`。既然声明了信封协议，拿到不是信封的东西就是后端或配置错了，当场报错比静默透传容易发现。
- `data` 字段缺失：响应体置空、`Content-Length: 0`，openapi-fetch 返回 `data: undefined`。
- 业务失败：`ApiError.code` 是业务码（布尔成功位失败时为 `"false"`），`message` 取配置的文案字段（没有则「请求失败（业务码 N）」），`body` 是完整信封，`status` 仍是 HTTP 状态。

它**不处理**「业务 200 + 鉴权码」（A14）：那是会话层的事，要接刷新链的由调用方在更底层的 fetch 包装里判定，或像示例 1 那样自写 middleware 抛 `RetryableError`。信封嵌套两层（C10）、数组根（C9）等特殊形状也自写。

## 示例 1：ABP envelope 解包（含业务 200 鉴权码，自写版）

```typescript
import { ApiError, RetryableError } from "@xapiforge/core";
import type { Middleware } from "@xapiforge/core";

interface AbpEnvelope<T = unknown> {
  code: number;
  data: T;
  message?: string;
}

export class AbpBizError extends ApiError<AbpEnvelope> {
  readonly code: number;
  constructor(code: number, message: string, body: AbpEnvelope) {
    super({ kind: "business", message, code, body });
    this.name = "AbpBizError";
    this.code = code;
  }
}

export function createAbpUnwrapMw(authCodes = [40001, 40002, 41001]): Middleware {
  const authCodeSet = new Set(authCodes);
  return {
    async onResponse({ response }) {
      if (!response.ok) return response; // 非 2xx 交给内核
      const ct = response.headers.get("Content-Type") ?? "";
      if (!ct.includes("application/json")) return response;

      const text = await response.clone().text();
      if (!text) return response;

      let envelope: AbpEnvelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        return response;
      }
      if (typeof envelope.code !== "number") return response;

      if (envelope.code === 0) {
        // 成功：解包 data
        return new Response(JSON.stringify(envelope.data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }

      if (authCodeSet.has(envelope.code)) {
        // 鉴权码：触发 refresh
        throw new RetryableError(`abp auth code ${envelope.code}`, {
          needsRefresh: true,
          reason: "business-auth"
        });
      }

      // 业务错误
      throw new AbpBizError(envelope.code, envelope.message ?? "业务处理失败", envelope);
    }
  };
}
```

## 示例 2：微信 errcode 协议

```typescript
import { ApiError, RetryableError } from "@xapiforge/core";
import type { Middleware } from "@xapiforge/core";

interface WechatEnvelope<T = unknown> {
  errcode: number;
  errmsg?: string;
  result?: T;
}

export class WechatBizError extends ApiError<WechatEnvelope> {
  readonly errcode: number;
  constructor(errcode: number, errmsg: string, body: WechatEnvelope) {
    super({ kind: "business", message: errmsg, code: errcode, body });
    this.name = "WechatBizError";
    this.errcode = errcode;
  }
}

export function createWechatUnwrapMw(): Middleware {
  return {
    async onResponse({ response }) {
      if (!response.ok) return response;
      const text = await response.clone().text();
      if (!text) return response;

      let envelope: WechatEnvelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        return response;
      }
      if (typeof envelope.errcode !== "number") return response;

      if (envelope.errcode === 0) {
        // 成功：解包 result（微信用 result 字段，不是 data）
        return new Response(JSON.stringify(envelope.result), {
          status: response.status,
          headers: response.headers
        });
      }

      // 40001 = access_token 过期
      if (envelope.errcode === 40001) {
        throw new RetryableError(`wechat token expired`, {
          needsRefresh: true,
          reason: "business-auth"
        });
      }

      throw new WechatBizError(envelope.errcode, envelope.errmsg ?? "微信接口调用失败", envelope);
    }
  };
}
```

## 示例 3：请求日志

```typescript
import type { Middleware } from "@xapiforge/core";

export function createLogMw(logger: { log: (...a: unknown[]) => void } = console): Middleware {
  return {
    async onRequest({ schemaPath, params }) {
      logger.log(`→ ${params.method} ${schemaPath}`);
      return params;
    },
    async onResponse({ response, schemaPath }) {
      logger.log(`← ${response.status} ${schemaPath}`);
      return response;
    }
  };
}
```

## 示例 4：请求改写（加 header）

```typescript
import type { Middleware } from "@xapiforge/core";

export function createTenantMw(tenantId: string): Middleware {
  return {
    async onRequest({ params }) {
      params.headers = { ...params.headers, __tenant: tenantId };
      return params;
    }
  };
}
```

## 多 client 共存

不同后端协议用不同 client，middleware 独立配置：

```typescript
// 两个 OpenAPI 项目分别生成 createMainClient 和 createWechatClient。
const mainApi = createMainClient({
  baseURL: "https://api.example.com",
  authService,
  middleware: [createAbpUnwrapMw()]
});

const wechatApi = createWechatClient({
  baseURL: "https://api.weixin.qq.com",
  authService,
  middleware: [createWechatUnwrapMw()]
});

// 业务代码
await mainApi.base.GET("/api/users");
await wechatApi.base.GET("/cgi-bin/user/info");
```

## 下一步

- [后端协议库](../internals/backend-protocols.md) — 27 类后端协议的 envelope 形状
- [行为合同表](../internals/behavior-contract.md) — 每个场景的期望行为
