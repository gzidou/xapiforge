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

**业务 middleware（业务侧写，在 `NetConfig.middleware` 配置）**：

- envelope 解包（ABP / 微信 / 自研协议）
- 请求/响应日志
- 请求改写（加 header / 改 path）
- 响应转换（日期格式化 / 字段映射）

## middleware 类型

```typescript
import type { Middleware } from "openapi-fetch";

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

## 示例 1：ABP envelope 解包

```typescript
import { ApiError, RetryableError } from "@xapiforge/core";
import type { Middleware } from "openapi-fetch";

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
import type { Middleware } from "openapi-fetch";

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
import type { Middleware } from "openapi-fetch";

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
import type { Middleware } from "openapi-fetch";

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
// 主 API（ABP 协议）
initApi("default", {
  baseURL: "https://api.example.com",
  authService,
  middleware: [createAbpUnwrapMw()]
});

// 第三方 API（微信协议）
initApi("wechat", {
  baseURL: "https://api.weixin.qq.com",
  authService,
  middleware: [createWechatUnwrapMw()]
});

// 业务代码
const api = useApi("default");
const wx = useApi("wechat");
```

## 下一步

- [后端协议库](../internals/backend-protocols.md) — 27 类后端协议的 envelope 形状
- [行为合同表](../internals/behavior-contract.md) — 每个场景的期望行为
