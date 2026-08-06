# 错误处理

`createNet` 对业务代码提供单一契约：

```text
validateStatus 接受最终响应
  → resolve { data, response }

请求生命周期内的任何最终失败
  → reject ApiError
```

业务调用者不需要同时检查 `result.error` 和捕获异常。

## 基本用法

```typescript
import { ApiError } from "@xapiforge/core";

try {
  const { data, response } = await api.base.GET("/api/tasks");

  renderTasks(data);
  console.log("request id:", response.headers.get("X-Request-Id"));
} catch (error: unknown) {
  if (error instanceof ApiError) {
    showToast(error.message);
    console.error({
      kind: error.kind,
      status: error.status,
      body: error.body,
      response: error.response,
      cause: error.cause
    });
    return;
  }

  // 同一个 try 中的业务计算、Vue 渲染等代码仍可能抛原生错误。
  console.error("unexpected application error:", error);
}
```

成功分支中的 `response` 是原始 Fetch `Response`。body 通常已经被解析，但仍可读取
`status`、`url` 和 `headers`。

## ApiError 字段

| 字段       | 语义                                                        |
| ---------- | ----------------------------------------------------------- |
| `message`  | 保证非空的归一化文案，可作为用户提示的兜底                  |
| `kind`     | 稳定的请求错误分类                                          |
| `status`   | HTTP 状态码；没有收到响应时为空                             |
| `response` | 原始 Fetch `Response`；断网、DNS、超时等场景为空            |
| `body`     | JSON 为解析后的对象，非 JSON 为字符串，空响应为 `undefined` |
| `code`     | 可选业务错误码                                              |
| `cause`    | 底层原始异常，用于日志、堆栈和错误链                        |

`body` 和 `cause` 可能包含敏感信息，不应直接展示给用户，也不应无条件上传日志。

## kind 分类

```typescript
type ApiErrorKind = "http" | "auth" | "rate-limit" | "network" | "timeout" | "abort" | "parse" | "business" | "unexpected";
```

| kind         | 触发场景                                           | response |
| ------------ | -------------------------------------------------- | -------- |
| `http`       | 最终响应未通过 `validateStatus`                    | 有       |
| `auth`       | refresh 失败、刷新后仍 401、鉴权重试耗尽           | 可能有   |
| `rate-limit` | 429 重试耗尽                                       | 有       |
| `network`    | DNS、CORS、断网、TCP 等 fetch 失败                 | 无       |
| `timeout`    | 请求超过 `defaultTimeoutMs`                        | 无       |
| `abort`      | 调用者主动取消                                     | 无       |
| `parse`      | 已接受响应的 body 解析失败，原异常保存在 `cause`   | 当前无   |
| `business`   | HTTP 成功，但业务 middleware 判断 envelope 失败    | 由业务定 |
| `unexpected` | 请求链内部未识别的运行时错误，原错误保留在 `cause` | 可能有   |

`ApiError` 只描述 `createNet` 请求生命周期。页面其他代码抛出的 `TypeError` 等不会被伪装成
接口错误，因此 `catch` 参数仍应写成 `unknown` 并先做 `instanceof ApiError` 判断。

## HTTP 成功状态

默认使用浏览器标准 `response.ok`，也就是 2xx：

```typescript
const api = createNet<AppPaths>({
  baseURL: "https://api.example.com",
  authService
});
```

`401` 和 `429` 是内核治理状态：它们会先触发 refresh/retry，而不是直接交给
`validateStatus`。刷新或重试仍失败时，分别抛 `auth` / `rate-limit` 错误。

### 单次请求接受 404

```typescript
const { data, response } = await api.GET("/api/tasks/{id}", {
  params: { path: { id } },
  validateStatus: response => response.ok || response.status === 404
});

if (response.status === 404) {
  return null;
}
return data;
```

一旦提供自定义 `validateStatus`，TypeScript 会保守地把 OpenAPI error response 加入该次
调用的 `data` 类型。调用者应根据 `response.status` 映射成明确的领域结果。

### client 全局状态策略

只有某个 client 的所有接口都共享同一语义时，才建议全局配置：

```typescript
const api = createNet<AppPaths>({
  baseURL: "https://api.example.com",
  authService,
  validateStatus: response => response.ok || response.status === 404
});
```

全局自定义后，该 client 所有方法的 `data` 都会保守地包含 OpenAPI error response 类型。
一般项目更适合默认 2xx，并只为确实需要的接口单独配置。

## 错误文案解析

内核默认尝试以下通用字段：

```text
message
detail
title
error_description
error（字符串）
error.message / error.detail / error.title
```

找不到时回退到：

```text
请求失败（HTTP 400）
```

`xapiforge` 不硬编码 ABP、Spring Boot 等框架格式。业务项目通过解析器扩展：

```typescript
const api = createNet<AppPaths>({
  baseURL,
  authService,
  resolveErrorMessage({ body }) {
    if (!body || typeof body !== "object") return undefined;
    const envelope = body as { error?: { message?: string } };
    return envelope.error?.message;
  }
});
```

单次请求也可以覆盖：

```typescript
await api.GET("/third-party/resource", {
  resolveErrorMessage({ body }) {
    if (!body || typeof body !== "object") return undefined;
    const payload = body as { errmsg?: string };
    return payload.errmsg;
  }
});
```

## 特殊错误类型

`AuthError` 和 `NetworkError` 都继承 `ApiError`，便于需要时做更精确判断：

```typescript
import { ApiError, AuthError, NetworkError } from "@xapiforge/core";

try {
  await api.GET("/api/protected");
} catch (error: unknown) {
  if (error instanceof AuthError) {
    // AuthService.onAuthFailed 通常已经触发跳转。
    return;
  }
  if (error instanceof NetworkError && error.kind === "timeout") {
    showToast("请求超时，请重试");
    return;
  }
  if (error instanceof ApiError) {
    showToast(error.message);
  }
}
```

`RetryableError` 是 middleware 与 createNet retry loop 之间的内部控制信号。业务调用者
不会收到它；重试耗尽后会转换成 `ApiError(kind="auth" | "rate-limit")`。

## 业务 middleware

业务 envelope 判断失败时，应抛 `ApiError(kind="business")`，而不是普通 `Error`：

```typescript
throw new ApiError({
  kind: "business",
  message: envelope.message || "业务处理失败",
  body: envelope,
  code: envelope.code
});
```

普通 `Error` 或 `TypeError` 会被视为请求链内部代码异常，对外转换成
`ApiError(kind="unexpected")`，并保留在 `cause`。

## 生成客户端迁移

这是破坏式契约变更。升级 `@xapiforge/core` 后，需要用同一版本的 genapi 重新生成
业务客户端。旧产物仍把 service 声明为 `openapi-fetch Client`，既不能给出正确的
data-or-throw 类型，也可能与新的 `NetClient` 发生类型不兼容。

业务侧若有绕过 schema 的手写类型，也应同步移除 `error`：

```typescript
type RawRequest = (method: string, path: string, options: Record<string, unknown>) => Promise<{ data: unknown; response: Response }>;
```

## 超时配置

```typescript
const api = createNet<AppPaths>({
  baseURL: "https://api.example.com",
  authService,
  defaultTimeoutMs: 30_000
});
```

超时和主动取消都没有 HTTP `Response`：

```typescript
if (error instanceof ApiError) {
  if (error.kind === "timeout") showToast("请求超时");
  if (error.kind === "abort") return; // 用户主动取消通常不提示
}
```

## 下一步

- [鉴权详解](./auth.md) — refresh、单飞和窗口保护
- [自定义 middleware](./middleware.md) — envelope 解包与业务 ApiError
