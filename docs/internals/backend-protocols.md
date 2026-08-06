# 后端协议 JSON 示例库（Backend Protocols）

> **这份文档是 `@xapiforge/core` 设计的协议基线**。
>
> **历史说明**：本文创建于 v0.1，其中的 `NetConfig.guard`、`unwrapResponse` 和 `BizError`
> 是旧设计术语。当前实现通过业务 `middleware` 识别/解包 envelope，并以
> `ApiError` + `validateStatus` 提供统一的 data-or-throw 契约；现行用法以
> [错误处理指南](../guides/error-handling.md) 和 [行为合同](./behavior-contract.md) 为准。
>
> 设计哲学：**库不预设 envelope 形状**。后端专有协议由业务 middleware 适配；内核负责
> HTTP 状态归一化、超时/取消/网络失败、单飞 refresh、限流重试和统一 `ApiError`。
>
> **如何使用本表**：
>
> 1. **接新后端**：从表里找最接近的协议，把历史 guard 模板翻译成业务 middleware
> 2. **改库 API**：先确认目标协议能否被当前 API 表达；不能 → 改 API
> 3. **写测试**：每个协议的成功 / 鉴权失败 / 业务错误三态都该有用例
>
> **覆盖范围**：ABP (.NET)+ 通用后端 17 种 + envelope 变体 10 种 = 27 类。
>
> **版本**：v0.1（2026-07-31 创建，配合 net 库 v0.2 架构重构）

---

## 协议清单

### Layer A：通用后端协议（22 类）

| 编号 | 协议                                         | envelope 形状                                            | 鉴权码位置                                 | 业务错误码位置                     | HTTP 状态          |
| ---- | -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ | ---------------------------------- | ------------------ |
| A1   | **ABP (.NET)** — ABP (.NET) projects         | `{code, data, message}`                                  | HTTP 401 / `code=40001`                    | `code !== 0`                       | 200 / 401 / 403    |
| A2   | **Spring Boot / Spring Security**            | `{code, message, data}` 或 `{status, message}`           | HTTP 401 / 403                             | `code !== 0` / `status != "ok"`    | 200 / 401 / 403    |
| A3   | **OAuth2 / OIDC**（RFC 6749 token endpoint） | `{error, error_description, error_uri}`                  | `error="invalid_token"`                    | N/A（token endpoint 不分业务错误） | 400 / 401          |
| A4   | **RFC 7807 Problem Details**                 | `{type, title, status, detail, instance}`                | `status=401`                               | `status >= 400`                    | 4xx / 5xx          |
| A5   | **企业微信 / 钉钉 / 飞书 API**               | `{errcode, errmsg}` 或 `{code, message, data}`           | `errcode=40014` / `code=401`               | `errcode !== 0` / `code !== 0`     | 200                |
| A6   | **微信小程序**                               | `{errcode, errmsg}` HTTP **200**                         | `errcode=40001`                            | `errcode !== 0`                    | 200                |
| A7   | **支付宝 / 银联**                            | `{code, msg, sub_code, sub_msg}`                         | `code=20000`（系统错误）                   | `code !== 10000`                   | 200                |
| A8   | **GraphQL** (Apollo / Yoga)                  | `{data, errors[]}`                                       | `errors[].extensions.code=UNAUTHENTICATED` | `errors[]` 存在                    | 200                |
| A9   | **gRPC-Web**                                 | `{}` 成功 + `{code, message}` 失败                       | gRPC status=16 UNAUTHENTICATED             | gRPC status != 0                   | 200                |
| A10  | **JSON-RPC 2.0**                             | `{jsonrpc, result}` 或 `{jsonrpc, error:{code,message}}` | `error.code=-32001`                        | `error` 存在                       | 200                |
| A11  | **HAL / JSON:API**                           | `{data, links, meta}` 或 `{data, included}`              | HTTP 401                                   | HTTP 4xx                           | 4xx                |
| A12  | **嵌套 envelope**                            | `{status, result:{code, data}}`                          | `result.code=40001`                        | `result.code !== 0`                | 200                |
| A13  | **array root**（无 envelope）                | `[{...}, {...}]` 或裸 `{...}`                            | HTTP 401                                   | HTTP 4xx                           | 4xx                |
| A14  | **业务 200 + 鉴权码**（国内中台）            | `{code: 40001, msg: "token expired"}` HTTP 200           | `code=40001 / 40002 / 41001`               | `code !== 0`                       | 200                |
| A15  | **业务 200 + success bool**                  | `{success: true, data}` 或 `{ok: true, data}`            | HTTP 401                                   | `success !== true`                 | 200                |
| A16  | **HTTP 鉴权状态码**                          | 空 body 或 envelope                                      | HTTP 401 / 403 / 419 / 440 / 498 / 499     | N/A                                | 401 / 403 / 419 等 |
| A17  | **HTTP 429 + Retry-After**                   | envelope + header                                        | N/A                                        | N/A（限流）                        | 429                |
| A18  | **HTTP 5xx + HTML**                          | `<html>...</html>`                                       | N/A                                        | N/A                                | 5xx                |
| A19  | **HTTP 5xx + JSON envelope**                 | `{code: 500, msg: "..."}`                                | N/A                                        | `code !== 0`                       | 5xx                |
| A20  | **HTTP 503 + JSON**（k8s 维护）              | `{message: "Service Unavailable"}`                       | N/A                                        | N/A                                | 503                |
| A21  | **204 No Content**                           | `""`                                                     | N/A                                        | N/A                                | 204                |
| A22  | **200 + 空 body**                            | `""`                                                     | N/A                                        | N/A                                | 200                |

### Layer C：业务 envelope 变体（10 类，与 Layer A 正交）

| 编号 | 形态                          | 例子                                               |
| ---- | ----------------------------- | -------------------------------------------------- |
| C1   | `data` 字段是 string          | `{code: 0, data: "https://file.url"}`              |
| C2   | `data` 字段是 array root      | `{code: 0, data: [{...}, {...}]}`                  |
| C3   | `data` 字段是分页             | `{code: 0, data: {items: [...], totalCount: 100}}` |
| C4   | `data` 字段是 null            | `{code: 0, data: null}`                            |
| C5   | `msg` 字段缺失                | `{code: 0, data: ...}`                             |
| C6   | `code` 字段类型是 string      | `{code: "0", data: ...}`                           |
| C7   | `code` 字段是 boolean         | `{success: true, data: ...}`                       |
| C8   | 响应同时含 `code` 和 `status` | `{code: 0, status: "ok", data: ...}`               |
| C9   | envelope 是数组而非 object    | `[{...}, {...}]`                                   |
| C10  | envelope 嵌套 2 层以上        | `{result: {inner: {code, data}}}`                  |

---

## 协议详解（按 Layer A 顺序）

### A1. ABP (.NET) ⭐核心

**适用场景**：ABP Framework 后端项目

**成功响应**：

```json
{
  "code": 0,
  "data": {
    "id": "u-001",
    "userName": "admin",
    "email": "admin@demo.local"
  },
  "message": null
}
```

**业务错误**（HTTP 200）：

```json
{
  "code": 500,
  "data": null,
  "message": "用户名已存在"
}
```

**鉴权失败 — HTTP 401**：

```json
{
  "code": 401,
  "data": null,
  "message": "Unauthorized"
}
```

**鉴权失败 — 业务 200 鉴权码**（Demo 特有）：

```json
HTTP 200
{
  "code": 40001,
  "data": null,
  "msg": "token expired"
}
```

> ⚠️ 注意：Demo 错误响应里 message 字段有时叫 `msg`，需要 guard 兼容。

**分页响应**（ABP `PagedResultDto<T>`）：

```json
{
  "code": 0,
  "data": {
    "items": [
      { "id": "u-001", "userName": "admin" },
      { "id": "u-002", "userName": "operator" }
    ],
    "totalCount": 100
  },
  "message": null
}
```

**字段语义**：

- `code`：0 = 成功；非 0 = 业务错误；40001/40002/41001 = 鉴权失败（Demo 特有）
- `data`：业务数据（成功时）；null（失败时）
- `message` / `msg`：人类可读错误信息（字段名不统一）

**guard 模板**：

```ts
net.setup({
  unwrapResponse: p => ((p as { code: number }).code === 0 ? (p as { data: unknown }).data : p),
  guard: {
    inspect(i) {
      if (i.status === 401) return "auth";
      if (i.status === 403) return "fatal"; // 用户被禁用，不是 token 过期
      const u = i.unwrapped as { code?: number } | null;
      if (u && typeof u.code === "number") {
        if (u.code === 40001 || u.code === 40002 || u.code === 41001) return "auth";
        if (u.code !== 0) return "biz";
      }
      return "ok";
    }
  }
  // ...
});
```

**OAuth2 token endpoint**（`/connect/token`，独立于业务 envelope）：

```json
// 成功
{
  "access_token": "eyJ...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 3599
}

// 失败（OAuth2 标准）
{
  "error": "invalid_grant",
  "error_description": "Invalid username or password!",
  "error_uri": "https://documentation.openiddict.com/errors/ID2024"
}
```

> token endpoint 不走 `net.request()` 拦截链（业务侧 `AuthApi` 自己 fetch）。原因：login 不能带 Authorization header，refresh 不能再触发 refresh。

---

### A2. Spring Boot / Spring Security

**成功响应**（变体 1 — `{code, message, data}`）：

```json
{
  "code": 200,
  "message": "success",
  "data": { "id": 1, "name": "foo" }
}
```

**成功响应**（变体 2 — `{status, message}`）：

```json
{
  "status": "ok",
  "message": "success",
  "result": { "id": 1, "name": "foo" }
}
```

**鉴权失败**（HTTP 401 + envelope）：

```json
HTTP 401
{
  "timestamp": "2026-07-31T10:00:00Z",
  "status": 401,
  "error": "Unauthorized",
  "message": "JWT expired",
  "path": "/api/users"
}
```

**业务错误**（HTTP 200 + envelope）：

```json
HTTP 200
{
  "code": 500,
  "message": "user not found",
  "data": null
}
```

**guard 模板**：

```ts
guard: {
  inspect(i) {
    if (i.status === 401) return "auth";
    if (i.status === 403) return "fatal";
    const u = i.unwrapped as { code?: number; status?: string } | null;
    if (u) {
      if (typeof u.code === "number" && u.code !== 200) return "biz";
      if (typeof u.status === "string" && u.status !== "ok") return "biz";
    }
    return "ok";
  },
}
```

---

### A3. OAuth2 / OIDC（RFC 6749）— token endpoint

**适用场景**：`/connect/token`、`/oauth/token`、`/oauth2/v4/token`

**password grant 成功**：

```json
HTTP 200
{
  "access_token": "eyJ...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 3599,
  "scope": "offline_access Infrastructure"
}
```

**错误响应**（OAuth2 标准 — HTTP 400/401，**永远 4xx 不是 5xx**）：

```json
HTTP 400
{
  "error": "invalid_grant",
  "error_description": "Invalid username or password!",
  "error_uri": "https://tools.ietf.org/html/rfc6749#section-5.2"
}
```

**OAuth2 error 取值**（RFC 6749 §5.2）：

| error                    | HTTP | 含义                        |
| ------------------------ | ---- | --------------------------- |
| `invalid_request`        | 400  | 缺参数 / 参数重复           |
| `invalid_client`         | 401  | client 认证失败             |
| `invalid_grant`          | 400  | 授权码 / refresh token 无效 |
| `unauthorized_client`    | 400  | client 无此 grant 权限      |
| `unsupported_grant_type` | 400  | grant_type 不支持           |
| `invalid_scope`          | 400  | scope 不合法                |

**库行为**：token endpoint 不走 `net.request()` 拦截链（业务侧 `AuthApi` 自己 fetch），原因见 A1 末尾。`authRefresher.refresh()` 内部抛错 → 库 catch → 转 AuthError + 调 `onAuthFailed()`。

---

### A4. RFC 7807 Problem Details

**适用场景**：Spring 5+ / .NET 8+ / 新项目

**所有错误响应统一形态**：

```json
HTTP 404
{
  "type": "https://example.com/errors/user-not-found",
  "title": "User Not Found",
  "status": 404,
  "detail": "User with id 123 does not exist",
  "instance": "/api/users/123"
}
```

**鉴权失败**：

```json
HTTP 401
{
  "type": "https://example.com/errors/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "JWT expired at 2026-07-31T10:00:00Z"
}
```

**成功响应**：无 envelope，直接返回业务数据：

```json
HTTP 200
{
  "id": 123,
  "name": "foo"
}
```

**guard 模板**：

```ts
guard: {
  inspect(i) {
    if (i.status === 401) return "auth";
    if (i.status === 403) return "fatal";
    if (i.status >= 400) {
      // RFC 7807 错误响应用 envelope.status，不用 envelope.code
      const env = i.envelope as { status?: number; type?: string } | null;
      if (env?.status === 401) return "auth";
      return "biz"; // 其他错误统一归 biz
    }
    return "ok";
  },
}
// unwrapResponse: identity (p => p) — RFC 7807 没有 envelope 包装
```

---

### A5. 企业微信 / 钉钉 / 飞书 API

**企业微信成功**：

```json
HTTP 200
{
  "errcode": 0,
  "errmsg": "ok",
  "userid": "zhangsan",
  "name": "张三"
}
```

**企业微信鉴权失败**（HTTP 200！）：

```json
HTTP 200
{
  "errcode": 40014,
  "errmsg": "invalid access_token"
}
```

**企业微信错误码**：

| errcode | 含义              | 库行为            |
| ------- | ----------------- | ----------------- |
| 0       | 成功              | ok                |
| 40014   | access_token 无效 | auth → refresh    |
| 42001   | access_token 过期 | auth → refresh    |
| 48002   | API 没权限        | biz               |
| 40029   | invalid code      | biz               |
| -1      | 系统繁忙          | biz（业务侧重试） |

**钉钉响应**（变体）：

```json
{
  "code": 0,
  "message": "success",
  "data": { "userid": "..." }
}
```

**飞书响应**：

```json
{
  "code": 0,
  "msg": "success",
  "data": { "user_id": "..." }
}
```

**guard 模板**（企业微信）：

```ts
guard: {
  inspect(i) {
    if (i.status === 401) return "auth"; // 罕见，企业微信一般 HTTP 200
    const env = i.envelope as { errcode?: number } | null;
    if (env && typeof env.errcode === "number") {
      if (env.errcode === 40014 || env.errcode === 42001) return "auth";
      if (env.errcode !== 0) return "biz";
    }
    return "ok";
  },
}
// unwrapResponse: identity — 企业微信不分离 data 字段，字段直接在根
```

> ⚠️ 注意：企业微信用 `i.envelope` 而不是 `i.unwrapped`，因为 `unwrapResponse` 这里是 identity，但业务侧可能想看 `errcode` 而不是 unwrap 后的数据。

---

### A6. 微信小程序 — 业务 200 鉴权码典型场景

**所有响应 HTTP 200**（包括错误）：

```json
HTTP 200
// 成功
{ "errcode": 0, "errmsg": "ok", "openid": "..." }

// 鉴权失败
{ "errcode": 40001, "errmsg": "invalid credential" }

// 业务错误
{ "errcode": 40029, "errmsg": "invalid code" }
```

**关键**：HTTP 永远 200，**鉴权判定只能看 envelope**。这是 Layer A 中**库必须支持业务 200 鉴权码**的核心场景。

**guard 模板**：

```ts
guard: {
  inspect(i) {
    // HTTP 状态完全不可靠，只能看 envelope
    const env = i.envelope as { errcode?: number } | null;
    if (env && typeof env.errcode === "number") {
      if (env.errcode === 40001 || env.errcode === 42001) return "auth";
      if (env.errcode !== 0) return "biz";
    }
    return "ok";
  },
}
```

---

### A7. 支付宝 / 银联

**成功响应**：

```json
HTTP 200
{
  "code": "10000",
  "msg": "Success",
  "out_trade_no": "...",
  "trade_no": "...",
  "total_amount": "9.00"
}
```

**业务错误**：

```json
{
  "code": "20000",
  "msg": "Service Not Available",
  "sub_code": "ACQ.SYSTEM_ERROR",
  "sub_msg": "系统错误"
}
```

**鉴权失败**：

```json
{
  "code": "20002",
  "msg": "Invalid Token"
}
```

**字段语义**：

- `code` 是 **string** 类型（不是 number）："10000" = 成功；"20000" = 系统错误；"20001" = 鉴权失败
- `sub_code` / `sub_msg`：子错误码（业务侧细分）

**guard 模板**：

```ts
guard: {
  inspect(i) {
    const env = i.envelope as { code?: string } | null;
    if (env && typeof env.code === "string") {
      if (env.code === "20001" || env.code === "20002") return "auth";
      if (env.code !== "10000") return "biz";
    }
    return "ok";
  },
}
```

> ⚠️ 注意 `code` 是 string 类型 — 这是 C6 envelope 变体的真实生产案例。

---

### A8. GraphQL (Apollo / Yoga)

**成功响应**：

```json
HTTP 200
{
  "data": {
    "user": { "id": "1", "name": "foo" }
  }
}
```

**鉴权失败**（HTTP 200，错误在 `errors[]`）：

```json
HTTP 200
{
  "data": null,
  "errors": [
    {
      "message": "You must be logged in",
      "extensions": { "code": "UNAUTHENTICATED" }
    }
  ]
}
```

**业务错误**（HTTP 200，部分 data 返回）：

```json
HTTP 200
{
  "data": { "user": null },
  "errors": [
    {
      "message": "User not found",
      "extensions": { "code": "NOT_FOUND" }
    }
  ]
}
```

**guard 模板**：

```ts
guard: {
  inspect(i) {
    const env = i.envelope as { errors?: { extensions?: { code?: string } }[] } | null;
    if (env?.errors?.length) {
      const codes = env.errors.map(e => e.extensions?.code);
      if (codes.includes("UNAUTHENTICATED")) return "auth";
      if (codes.includes("FORBIDDEN")) return "fatal"; // 权限不足，不 refresh
      return "biz";
    }
    return "ok";
  },
}
// unwrapResponse: (p) => (p as { data: unknown }).data — 拿到 data 字段
```

---

### A9. gRPC-Web

**成功响应**（HTTP 200，二进制 protobuf）：

```text
HTTP 200
Content-Type: application/grpc-web+proto
<binary>
```

**失败响应**（trailers 含错误码）：

```text
HTTP 200
Content-Type: application/grpc-web+proto
grpc-status: 16
grpc-message: UNAUTHENTICATED
```

**gRPC status codes**：

| code | 含义              | 库行为              |
| ---- | ----------------- | ------------------- |
| 0    | OK                | ok                  |
| 16   | UNAUTHENTICATED   | auth                |
| 7    | PERMISSION_DENIED | fatal               |
| 13   | INTERNAL          | biz / fatal         |
| 14   | UNAVAILABLE       | fatal（业务侧重试） |

**库行为**：当前架构**不支持** gRPC-Web（trailers 解析需要 grpc-web 库）。业务侧自己用 grpc-web client，不走 `net.request()`。

---

### A10. JSON-RPC 2.0

**成功响应**：

```json
HTTP 200
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { "name": "foo" }
}
```

**错误响应**：

```json
HTTP 200
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid Request"
  }
}
```

**JSON-RPC error codes**：

| code   | 含义               |
| ------ | ------------------ |
| -32700 | Parse error        |
| -32600 | Invalid Request    |
| -32601 | Method not found   |
| -32602 | Invalid params     |
| -32603 | Internal error     |
| -32001 | 鉴权失败（自定义） |

**guard 模板**：

```ts
guard: {
  inspect(i) {
    const env = i.envelope as { error?: { code?: number } } | null;
    if (env?.error) {
      if (env.error.code === -32001) return "auth";
      return "biz";
    }
    return "ok";
  },
}
// unwrapResponse: (p) => (p as { result: unknown }).result
```

---

### A11. HAL / JSON:API

**HAL 成功响应**：

```json
HTTP 200
{
  "id": 1,
  "name": "foo",
  "_links": {
    "self": { "href": "/users/1" }
  },
  "_embedded": {
    "posts": [...]
  }
}
```

**JSON:API 成功响应**：

```json
HTTP 200
{
  "data": {
    "type": "user",
    "id": "1",
    "attributes": { "name": "foo" }
  },
  "included": [...]
}
```

**JSON:API 错误响应**：

```json
HTTP 401
{
  "errors": [
    {
      "status": "401",
      "title": "Unauthorized",
      "detail": "JWT expired"
    }
  ]
}
```

**库行为**：错误响应完全靠 HTTP 状态码，envelope 不分业务错误码。`unwrapResponse: identity`。

---

### A12. 嵌套 envelope

**形态**：`{status, result: {code, data}}`

```json
HTTP 200
// 成功
{
  "status": "ok",
  "result": {
    "code": 0,
    "data": { "id": 1 }
  }
}

// 业务错误
{
  "status": "error",
  "result": {
    "code": 500,
    "data": null,
    "message": "duplicate"
  }
}

// 鉴权失败（业务 200 鉴权码嵌套）
{
  "status": "ok",
  "result": {
    "code": 40001,
    "data": null,
    "message": "token expired"
  }
}
```

**guard 模板**：

```ts
guard: {
  inspect(i) {
    if (i.status === 401) return "auth";
    const env = i.envelope as { result?: { code?: number } } | null;
    if (env?.result) {
      if (env.result.code === 40001) return "auth";
      if (env.result.code !== 0) return "biz";
    }
    return "ok";
  },
}
// unwrapResponse: (p) => {
//   const r = (p as { result?: { code?: number; data?: unknown } }).result;
//   return r && r.code === 0 ? r.data : p;
// }
```

> ⚠️ 注意：guard 用 `i.envelope.result.code`，不是 `i.unwrapped.code`。因为 unwrap 后是 `r.data`，看不到 `r.code`。

---

### A13. array root（无 envelope）

**形态**：直接返回数组或裸对象

```json
HTTP 200
// 数组
[
  { "id": 1, "name": "foo" },
  { "id": 2, "name": "bar" }
]

// 裸对象
{ "id": 1, "name": "foo" }
```

**错误响应**：完全靠 HTTP 状态码。

**guard 模板**：

```ts
guard: {
  inspect(i) {
    if (i.status === 401) return "auth";
    if (i.status >= 400) return "fatal";
    return "ok";
  },
}
// unwrapResponse: identity (p => p)
```

---

### A14. 业务 200 + 鉴权码（国内中台典型）

**所有响应 HTTP 200**（包括鉴权失败、业务错误）：

```json
HTTP 200
// 成功
{ "code": 0, "data": { "id": 1 }, "msg": "ok" }

// 鉴权失败
{ "code": 40001, "data": null, "msg": "token expired" }

// 业务错误
{ "code": 500, "data": null, "msg": "user not found" }
```

**关键**：HTTP 状态码完全没用，鉴权判定必须看 envelope.code。

**guard 模板**：见 A1（Demo 业务 200 鉴权码场景）。

**常见鉴权码**（不同后端不同）：

| 项目       | 鉴权码                | 备注                                        |
| ---------- | --------------------- | ------------------------------------------- |
| Demo (ABP) | 40001 / 40002 / 41001 | token 过期 / 无效 / 被撤销                  |
| 微信小程序 | 40001 / 42001         | invalid credential / access_token expired   |
| 企业微信   | 40014 / 42001         | invalid access_token / access_token expired |
| 支付宝     | 20001 / 20002         | Invalid Token                               |
| 钉钉       | -1 / 88               | （钉钉 errcode 多变，需查文档）             |

---

### A15. 业务 200 + success bool（旧 PHP / 国内老项目）

```json
HTTP 200
// 成功
{ "success": true, "data": { "id": 1 } }

// 失败
{ "success": false, "data": null, "message": "user not found" }

// 另一种变体
{ "ok": true, "data": { "id": 1 } }
```

**guard 模板**：

```ts
guard: {
  inspect(i) {
    if (i.status === 401) return "auth";
    const env = i.envelope as { success?: boolean; ok?: boolean } | null;
    if (env) {
      if (env.success === false || env.ok === false) {
        // 鉴权码场景：业务侧自己定
        return "biz";
      }
    }
    return "ok";
  },
}
// unwrapResponse: (p) => (p as { data?: unknown }).data ?? p
```

---

### A16. HTTP 鉴权状态码（401 / 403 / 419 / 440 / 498 / 499）

| 状态码                         | 含义                  | 库默认行为 | 业务侧覆盖         |
| ------------------------------ | --------------------- | ---------- | ------------------ |
| **401** Unauthorized           | 标准鉴权失败          | refresh    | —                  |
| **403** Forbidden              | 权限不足 / 用户被禁用 | fatal      | 视协议可能 refresh |
| **419** Authentication Timeout | Laravel session 过期  | refresh    | —                  |
| **440** Login Timeout          | IIS session 过期      | refresh    | —                  |
| **498** Token Expired          | 阿里云 / 自定义       | refresh    | —                  |
| **499** Token Required         | 阿里云 / 自定义       | fatal      | 视协议可能 refresh |

**guard 模板**（覆盖 401/403/419/440/498 都视为鉴权失败）：

```ts
guard: {
  inspect(i) {
    if ([401, 419, 440, 498].includes(i.status)) return "auth";
    if (i.status === 403) return "fatal";
    // ...
  },
}
```

---

### A17. HTTP 429 Too Many Requests + Retry-After

**响应**：

```text
HTTP 429
Content-Type: application/json
Retry-After: 60

{
  "code": 429,
  "message": "Too Many Requests"
}
```

**`Retry-After` header 取值**：

- 数字（秒）：`Retry-After: 60` → 60 秒后重试
- HTTP 日期：`Retry-After: Wed, 31 Jul 2026 10:00:00 GMT` → 该时间点后重试

**当前库行为**：`createRetryMiddleware` 把 429 转为内部重试信号，`createNet` 按
`maxRetries` 重发完整请求。当前支持数字秒数格式；没有有效 `Retry-After` 时默认等待
1000ms，HTTP-date 格式尚未支持。重试耗尽后抛 `ApiError(kind="rate-limit")`。

---

### A18. HTTP 5xx + HTML

**响应**（Nginx / Tomcat 默认错误页）：

```text
HTTP 502
Content-Type: text/html

<html>
<head><title>502 Bad Gateway</title></head>
<body>
<center><h1>502 Bad Gateway</h1></center>
<hr><center>nginx/1.20.1</center>
</body>
</html>
```

**当前库行为**：最终 HTTP middleware 从 `response.clone()` 读取 body；JSON 解析失败时保留
HTML 原文，不会再次调用原始 `response.json()` / `response.text()`。HTML 不会直接作为面向
用户的错误文案。

**业务侧看到**：`ApiError(kind="http")`，`body` 为解析后的 HTML 字符串，`response` 保留原始状态和响应头。

---

### A19. HTTP 5xx + JSON envelope

**响应**（现代 .NET / Java 错误页）：

```json
HTTP 500
{
  "code": 500,
  "msg": "internal server error",
  "traceId": "abc-123"
}
```

**当前库行为**：默认抛 `ApiError(kind="http")`，`body` 保存解析后的对象，`response` 保存
原始状态和响应头。通用解析器不识别本例的 `msg`；业务侧可以配置错误文案解析器：

```ts
createNet({
  // ...
  resolveErrorMessage: ({ body }) => (typeof body === "object" && body !== null && "msg" in body && typeof body.msg === "string" ? body.msg : undefined)
});
```

---

### A20. HTTP 503 + JSON（k8s 维护中）

**响应**：

```json
HTTP 503
{
  "message": "Service Unavailable",
  "reason": "maintenance"
}
```

**当前库行为**：默认抛 `ApiError(kind="http")`，`message` 可从响应中的 `message` 提取；
`body` 与 `response` 均保留。内核默认只自动重试 429，503 是否重试应由业务策略明确决定。

---

### A21. 204 No Content

**响应**：

```text
HTTP 204
Content-Length: 0

(empty body)
```

**库行为**：

- `bodyText === ""`
- `parseJson("")` 返回 `null`
- `envelope = null`, `unwrapped = bodyText = ""`
- 默认 guard：`status === 204` → 2xx → `'ok'`
- 返回 `""` (string) 作为 unwrapped

**业务侧使用**：

```ts
await net.request("DELETE", "/api/users/{id}", { pathParams: { id } });
// 返回 "" (string)，业务侧忽略即可
```

---

### A22. 200 + 空 body

**响应**：

```text
HTTP 200
Content-Length: 0

(empty body)
```

**库行为**：同 A21，返回 `""` (string)。

---

## Layer C：业务 envelope 变体详解

> 这些变体与 Layer A 协议**正交**：任何 Layer A 协议都可能呈现 Layer C 的变体形态。

### C1. data 字段是 string

```json
{ "code": 0, "data": "https://file.url" }
```

**业务侧**：

```ts
unwrapResponse: p => ((p as { code: number }).code === 0 ? (p as { data: unknown }).data : p);
// → string URL
```

### C2. data 字段是 array root

```json
{ "code": 0, "data": [{ "id": 1 }, { "id": 2 }] }
```

**业务侧**：unwrap 同 C1。业务侧拿 array。

### C3. data 字段是分页（ABP `PagedResultDto<T>`）

```json
{
  "code": 0,
  "data": {
    "items": [{ "id": 1 }, { "id": 2 }],
    "totalCount": 100
  }
}
```

**业务侧 unwrap helper**（业务侧自己写，库不提供）：

```ts
// examples/demo-app/src/utils/paged.ts
export interface PagedResult<T> {
  items: T[];
  totalCount: number;
}
export function unwrapPaged<T>(p: unknown): PagedResult<T> {
  return p as PagedResult<T>;
}
```

### C4. data 字段是 null（DELETE 场景）

```json
{ "code": 0, "data": null }
```

**业务侧**：unwrap 返回 null。业务侧忽略返回值。

### C5. msg 字段缺失

```json
{ "code": 0, "data": { "id": 1 } }
```

**业务侧**：middleware 不依赖 msg 字段（仅看 code）。业务失败时把完整 envelope 放入
`ApiError.body`，错误文案缺失则由 `ApiError` 的非空兜底 message 保证可展示。

### C6. code 字段类型是 string

```json
{ "code": "0", "data": { "id": 1 } }
```

**业务侧 guard 必须兼容**：

```ts
guard: {
  inspect(i) {
    const u = i.unwrapped as { code?: string | number } | null;
    if (u?.code !== undefined) {
      const code = typeof u.code === "string" ? Number(u.code) : u.code;
      if (code === 40001) return "auth";
      if (code !== 0) return "biz";
    }
    return "ok";
  },
}
```

**真实场景**：支付宝（A7）、PHP 老项目。

### C7. code 字段是 boolean

```json
{ "success": true, "data": { "id": 1 } }
```

**业务侧**：guard 看 `success` 而不是 `code`。

### C8. 响应同时含 code 和 status

```json
{ "code": 0, "status": "ok", "data": { "id": 1 } }
```

**业务侧**：选一个字段判定（不要两个都看，避免冲突）。

### C9. envelope 是数组而非 object

```json
[{ "id": 1 }, { "id": 2 }]
```

**业务侧**：

```ts
unwrapResponse: (p) => Array.isArray(p) ? p : [];
guard: {
  inspect(i) {
    if (i.status === 401) return "auth";
    if (i.status >= 400) return "fatal";
    return "ok";
  },
}
```

### C10. envelope 嵌套 2 层以上

```json
{
  "result": {
    "inner": {
      "code": 0,
      "data": { "id": 1 }
    }
  }
}
```

**业务侧**：

```ts
unwrapResponse: (p) => {
  const r = (p as { result?: { inner?: { code?: number; data?: unknown } } }).result?.inner;
  return r && r.code === 0 ? r.data : p;
}
guard: {
  inspect(i) {
    const env = i.envelope as { result?: { inner?: { code?: number } } } | null;
    if (env?.result?.inner?.code === 40001) return "auth";
    // ...
  },
}
```

> ⚠️ 注意：guard 看 `i.envelope.result.inner.code`，不是 `i.unwrapped.code`（unwrap 后看不到 code）。

---

## 跨协议关注点

### 1. 鉴权码位置（5 种典型）

| 位置                              | 例子               | 库支持                                     |
| --------------------------------- | ------------------ | ------------------------------------------ |
| HTTP 状态码                       | 401                | ✅ 默认行为                                |
| envelope.code                     | `{code: 40001}`    | ✅ guard 业务覆盖                          |
| envelope.errcode                  | `{errcode: 40014}` | ✅ guard 业务覆盖                          |
| envelope.errors[].extensions.code | GraphQL            | ✅ guard 业务覆盖                          |
| envelope.result.code              | 嵌套 envelope      | ✅ guard 用 i.envelope（不是 i.unwrapped） |

### 2. unwrapResponse 与 guard 的边界

**关键设计原则**：

- `unwrapResponse` 是**纯函数**，只解 envelope，不判定错误
- `guard.inspect` 用 `i.envelope`（原始）或 `i.unwrapped`（解包后）任一判定
- **判定错误码用 `i.envelope`**（看到完整结构）
- **判定成功数据用 `i.unwrapped`**（看到解包结果）

**坑**：Demo guard 写 `i.unwrapped.code === 40001` 能工作，是因为 Demo 的 unwrap 在 code !== 0 时返回原 envelope（`p.code === 0 ? p.data : p`）。但其他协议（如 A12 嵌套 envelope）guard 必须用 `i.envelope`。

### 3. Content-Type 与 body 类型

| 场景             | Content-Type                      | body 类型       | 库行为                               |
| ---------------- | --------------------------------- | --------------- | ------------------------------------ |
| JSON 请求        | application/json                  | object          | JSON.stringify（默认）               |
| FormData 上传    | multipart/form-data               | FormData        | 原样传，浏览器加 boundary            |
| URL-encoded      | application/x-www-form-urlencoded | URLSearchParams | 原样传，库设 Content-Type            |
| OAuth2 login     | application/x-www-form-urlencoded | string（手拼）  | AuthApi 自己 fetch，不走 net.request |
| 文件下载（响应） | application/octet-stream          | binary          | ⚠️ 当前库 `res.text()` 会破坏二进制  |
| 文件下载（响应） | image/png                         | binary          | ⚠️ 同上                              |

### 4. HTTP 状态码语义对照

| 状态码          | 库默认          | 业务侧覆盖                                  |
| --------------- | --------------- | ------------------------------------------- |
| 2xx             | ok              | 一般不覆盖                                  |
| 401             | auth（refresh） | 视协议可能 fatal（403 视为禁用）            |
| 403             | fatal           | 视协议可能 auth（部分后端把鉴权失败塞 403） |
| 404 / 405 / 410 | fatal           | 视协议可能 biz                              |
| 409 Conflict    | fatal           | 视协议可能 biz（业务冲突）                  |
| 419 / 440 / 498 | fatal           | 视协议可能 auth                             |
| 429             | fatal           | 业务侧实现 retry                            |
| 5xx             | fatal           | 视协议可能 biz（A19）                       |

### 5. 错误响应 envelope 优先级（HTTP vs envelope）

**核心问题**：当 HTTP 状态码与 envelope.code 矛盾时，谁优先？

| 协议             | HTTP 优先 | envelope 优先        | 库行为                   |
| ---------------- | --------- | -------------------- | ------------------------ |
| ABP (A1)         | ✗         | ✓（业务 200 鉴权码） | guard 看 envelope        |
| Spring Boot (A2) | ✓         | ✗                    | guard 看 HTTP            |
| RFC 7807 (A4)    | ✓         | ✗                    | guard 看 HTTP            |
| 企业微信 (A5)    | ✗         | ✓（HTTP 永远 200）   | guard 看 envelope        |
| GraphQL (A8)     | ✗         | ✓（HTTP 永远 200）   | guard 看 envelope.errors |

**结论**：库**不能预设**优先级。`ResponseGuard.inspect` 的设计正源于此 —— 业务侧在一个函数里决定。

---

---

## 协议测试矩阵（建议）

> 每个协议都该有 mock 测试覆盖。当前 [mock-server.ts](file://scripts/mock-server.ts) 只覆盖 A1（ABP）。

| 协议                  | mock 端点建议                             | 优先级                           |
| --------------------- | ----------------------------------------- | -------------------------------- |
| A1 ABP                | ✅ 已覆盖（mock-server.ts）               | —                                |
| A6 微信小程序         | `/api/wechat/errcode`                     | 高（业务 200 鉴权码典型）        |
| A12 嵌套 envelope     | `/api/nested/result`                      | 高（验证 envelope vs unwrapped） |
| A14 业务 200 鉴权码   | ✅ 已覆盖（`/api/auth/biz-code-expired`） | —                                |
| A17 429 + Retry-After | `/api/rate-limited`                       | 中（待 retry 能力落地）          |
| A18 5xx + HTML        | `/api/nginx-error`                        | 中（验证非 JSON 处理）           |
| A19 5xx + JSON        | `/api/server-error-json`                  | 中                               |

---

## 相关文档

- [scenarios.md](./scenarios.md) — 场景清单（97 个情形）
- [behavior-contract.md](./behavior-contract.md) — 行为合同表（情形 × 当前实现 × 状态）

---

## 文档维护规则

1. **接新后端协议**：先加到 Layer A 表，再写详细段落（含 JSON 示例 + guard 模板）
2. **发现 envelope 变体**：加到 Layer C
3. **改库 API**：先确认目标协议能否被当前 API 表达，再改代码
4. **加测试**：每个新协议在 mock-server 加端点 + 在 demo-app 加 demo
