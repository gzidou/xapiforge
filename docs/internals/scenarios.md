# @xapiforge/core — 场景清单（Scenarios）

> **这份文档是库设计/测试/文档的 single source of truth**。
>
> 设计哲学：**库设计应该覆盖所有这些场景**。如果某个场景库没处理，标记 ⚠️ 或 ❌ 并在 BEHAVIOR-CONTRACT.md 同步。
>
> **v0.2 架构**：库 = HttpClient + AuthService + createNet + middleware 链。
> envelope 解包 / 业务错误判定归**业务侧 middleware**（如 `createAbpUnwrapMw`）。
> 库提供 `Middleware` 类型 + 内置 `auth-mw` / `retry-mw` / `http-error-mw`。

> **如何使用本表**：
>
> 1. **设计新特性**：从表里找相关场景，加期待行为
> 2. **写测试**：每个场景一个 case
> 3. **改行为**：先改本表，再改代码
> 4. **发现新场景**：加到表里

> **覆盖范围**：不限于ABP (.NET) projects。要枚举**通用后端** + **典型边角** + **未来可能**。

> **版本**：当前实现（2026-08-04，data-or-throw + 结构化 ApiError）

---

## 分类索引

| Layer    | 范围                          | 场景数  | v0.2 覆盖               |
| -------- | ----------------------------- | ------- | ----------------------- |
| **A**    | 通用后端协议（典型 + 已遇到） | 22      | ✅ 22/22                |
| **B**    | 网络层 / 边角情形             | 28      | ✅ 24/28（4 流式 v0.3） |
| **C**    | 业务 envelope 变体            | 10      | ✅ 10/10                |
| **D**    | 鉴权 / token 场景             | 18      | ✅ 18/18                |
| **E**    | 生命周期 / 资源管理           | 11      | ✅ 11/11                |
| **F**    | 错误传播 / Promise 行为       | 8       | ✅ 8/8                  |
| **总计** |                               | **~97** | **✅ 93/97（96%）**     |

> **场景编号规则**：`{Layer}{序号}` — 例如 `A1` = Layer A 第 1 个场景

---

## Layer A：通用后端协议

> **关键场景**：ABP + Spring Boot + OAuth2 + RFC 7807 + GraphQL + 微信/钉钉 + 支付宝
>
> **v0.2 库的承诺**：库**不预设** envelope 形状。业务侧写 **middleware**（如 `createAbpUnwrapMw`）声明。
> 库内置 `auth-mw`（401 → refresh → retry）+ `retry-mw`（429 退避）+ `http-error-mw`（最终 `validateStatus` 校验 → `ApiError`）。

| #   | 后端 / 协议                                  | 典型场景                  | 响应形态                                                          | 库行为                                                                                           |
| --- | -------------------------------------------- | ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A1  | **ABP** (.NET)                               | ABP (.NET) projects       | `{code, data, msg}` 三段                                          | 库默认不感知，业务侧 guard                                                                       |
| A2  | **Spring Boot / Spring Security**            | 银行 / 大型国企           | `{code, message, data}` 或 `{status, message}`                    | 业务侧 guard                                                                                     |
| A3  | **OAuth2 / OIDC 标准错误** (RFC 6749)        | 任何标准 OAuth server     | `{error, error_description, error_uri}`                           | 业务侧 guard；token endpoint 用 `AuthApi` 自己 fetch                                             |
| A4  | **REST 标准错误** (RFC 7807 Problem Details) | Spring 5+ / 新项目        | `{type, title, status, detail, instance}`                         | 业务侧 guard                                                                                     |
| A5  | **企业微信 / 钉钉 / 飞书 API**               | 国内中台 / OA             | `{errcode, errmsg}` 或 `{code, message, data}`                    | 业务侧 guard                                                                                     |
| A6  | **微信小程序 errcode**                       | 微信生态                  | `{errcode, errmsg}` HTTP **200**                                  | **业务 200 鉴权码场景**（已在 mock 演示）                                                        |
| A7  | **支付宝 / 银联**                            | 支付                      | `{code, msg, sub_code, sub_msg}`                                  | 业务侧 guard                                                                                     |
| A8  | **GraphQL** (Apollo / Yoga)                  | 新项目 / BFF              | `{data, errors[]}` HTTP 200                                       | 业务侧 guard（鉴权可能在 `errors[].extensions.code`）                                            |
| A9  | **gRPC-Web**                                 | 新微服务                  | `{}` 成功 + `{code, message}` 失败                                | 业务侧 guard                                                                                     |
| A10 | **JSON-RPC 2.0**                             | 区块链 / RPC              | `{jsonrpc: "2.0", result}` 或 `{jsonrpc, error: {code, message}}` | 业务侧 guard                                                                                     |
| A11 | **HAL / JSON:API**                           | REST 严格规范             | `{data, links, meta}` 或 `{data, included}`                       | 业务侧 guard                                                                                     |
| A12 | **嵌套 envelope** `{status, result}`         | 自研 API                  | `{status: "ok", result: {...}}`                                   | 业务侧 guard（鉴权码可能在 `result.code`）                                                       |
| A13 | **array root** (无 envelope)                 | 简单 REST                 | `[{...}, {...}]` 或裸 `{...}`                                     | 业务侧 guard                                                                                     |
| A14 | **业务 200 + 鉴权码**                        | 国内中台                  | `{code: 40001, msg: "token expired"}` HTTP 200                    | **关键**：业务侧 middleware 抛 `RetryableError({needsRefresh:true})` → 库 refresh + 重试 ✅ 实测 |
| A15 | **业务 200 + success bool**                  | 旧 PHP / 国内老项目       | `{success: true, data}` 或 `{ok: true, data}`                     | 业务侧 guard                                                                                     |
| A16 | **HTTP 401 / 403 / 419 / 440 / 498 / 499**   | 各种鉴权失败              | 空 body 或 envelope                                               | 401 先 refresh；最终失败及其他状态默认抛 `ApiError`，可用 `validateStatus` 覆盖                  |
| A17 | **HTTP 429 + Retry-After header**            | 限流                      | envelope + `Retry-After: 60`                                      | 自动退避重试；耗尽后抛 `ApiError(kind="rate-limit")`                                             |
| A18 | **HTTP 5xx + HTML**                          | Nginx / Tomcat 默认错误页 | `<html>...`                                                       | 抛 `ApiError(kind="http")`，字符串 body 与原始 Response 均保留                                   |
| A19 | **HTTP 5xx + JSON envelope**                 | 现代 .NET / Java          | `{code: 500, msg: "..."}`                                         | 抛 `ApiError(kind="http")`，body 为解析后的 JSON                                                 |
| A20 | **HTTP 503 + JSON body** (k8s 维护中)        | 微服务                    | `{message: "Service Unavailable"}`                                | 同 A19；可由全局/单请求 `validateStatus` 改为成功                                                |
| A21 | **空响应 204 No Content**                    | ABP / 部分 endpoint       | `""`                                                              | envelope=null，bodyText=""；guard 决定                                                           |
| A22 | **空响应 200 + 空 body**                     | 部分 GET                  | `""`                                                              | 同上                                                                                             |

---

## Layer B：网络层 / 边角情形

> **当前库的承诺**：fetch 失败、超时和主动取消抛 `NetworkError`，并分别使用 `network` / `timeout` / `abort` kind。
> HTTP 状态失败与网络失败分开：前者抛 `ApiError(kind="http")`；429 内部重试耗尽后抛 `ApiError(kind="rate-limit")`。

| #   | 情形                                       | 库行为                                                |
| --- | ------------------------------------------ | ----------------------------------------------------- |
| B1  | **CORS preflight 失败** (OPTIONS 返 4xx)   | fetch 抛错 → NetworkError                             |
| B2  | **HTTPS 证书过期**                         | 浏览器拒绝，NetworkError                              |
| B3  | **DNS 解析失败**                           | fetch 抛错 → NetworkError                             |
| B4  | **TCP 连接超时**                           | fetch AbortController 超时 → NetworkError             |
| B5  | **服务端主动 close** (ECONNRESET)          | fetch 抛错 → NetworkError                             |
| B6  | **服务端关闭 keep-alive**                  | fetch 抛错 → NetworkError                             |
| B7  | **响应 body 超大** (> 100MB)               | 浏览器 OOM / 业务侧超时                               |
| B8  | **gzip / br 解压失败**                     | fetch 内部错误 → NetworkError                         |
| B9  | **chunked transfer 编码异常**              | fetch 内部错误 → NetworkError                         |
| B10 | **响应 Content-Type 与 body 不匹配**       | `guard-helpers.ts:parseJson` 解析失败 → envelope=null |
| B11 | **响应含 BOM** (`\uFEFF`)                  | JSON.parse 通常容忍，业务侧可处理                     |
| B12 | **响应含 surrogate pair** (emoji)          | UTF-8 标准，业务侧处理                                |
| B13 | **响应 body 是 NDJSON** (流式)             | 库不支持，业务侧用 SSE/WebSocket                      |
| B14 | **响应是 Server-Sent Events**              | 库不支持                                              |
| B15 | **请求 body 含二进制** (file upload)       | **已支持**（FormData）                                |
| B16 | **请求 body 含 URL-encoded form**          | **已支持**（URLSearchParams）                         |
| B17 | **请求 body 是 stream**                    | 库不支持                                              |
| B18 | **请求含 cookie**                          | 业务侧手动塞 header                                   |
| B19 | **请求是 multipart 混合 text + file**      | **已支持**（FormData）                                |
| B20 | **CORS preflight OPTIONS**                 | 浏览器自动发，业务侧不管                              |
| B21 | **响应 Set-Cookie**                        | 业务侧 token store 处理                               |
| B22 | **SameSite cookie 跨域**                   | 业务侧配置                                            |
| B23 | **重定向 3xx**                             | fetch 默认 follow，库不管                             |
| B24 | **重定向循环**                             | fetch 默认最多 20 次 follow，错误向上                 |
| B25 | **响应 WebSocket Upgrade**                 | 库不支持                                              |
| B26 | **HTTP/2 push**                            | fetch 内部处理                                        |
| B27 | **代理 407 Proxy Authentication Required** | fetch 抛错                                            |
| B28 | **业务侧 guard 抛错**                      | 库向上传，⚠️ 待确认                                   |

---

## Layer C：业务 envelope 变体（unhappy path）

> **v0.2 库的承诺**：envelope 形状完全归业务侧 **middleware**（`onResponse` 阶段解包）。
> 库提供 `Middleware` 类型 + `HttpResponse`（含 `bodyText` / `envelope` / `data`）。

| #   | envelope 形态                           | 例子                                                                    | 业务侧实现                                                              |
| --- | --------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| C1  | `data` 字段是 string                    | `{code: 0, data: "https://file.url"}`                                   | unwrap: `p.code === 0 ? p.data : p`                                     |
| C2  | `data` 字段是 array root                | `{code: 0, data: [{...}, {...}]}`                                       | 同上                                                                    |
| C3  | `data` 字段是分页 `{items, totalCount}` | `{code: 0, data: {items: [...], totalCount: 100}}` (ABP PagedResultDto) | 同上 + 业务侧 `unwrapAbpPaged<T>`                                       |
| C4  | `data` 字段是 null                      | `{code: 0, data: null}` (DELETE)                                        | 同上                                                                    |
| C5  | `msg` 字段缺失                          | `{code: 0, data: ...}` 老项目                                           | 同上                                                                    |
| C6  | `code` 字段类型是 string                | `{code: "0", data: ...}` (PHP 老项目)                                   | `typeof p.code === "string"` 兼容                                       |
| C7  | `code` 字段是 boolean                   | `{success: true, data: ...}`                                            | `typeof p.success === "boolean"`                                        |
| C8  | 响应里同时含 `code` 和 `status`         | `{code: 0, status: "ok", data: ...}`                                    | 业务侧选一                                                              |
| C9  | envelope 是数组而非 object              | `[{...}, {...}]`                                                        | unwrap: `p => Array.isArray(p) ? p : []`                                |
| C10 | envelope 嵌套 2 层以上                  | `{result: {inner: {code, data}}}`                                       | unwrap 链式：`p => p.result.inner.code === 0 ? p.result.inner.data : p` |

---

## Layer D：鉴权 / token 场景

> **v0.2 库的承诺**：库提供 `AuthService`（单飞 + 窗口保护 + 超时）+ `auth-mw`（401 → refresh → retry）。
> 鉴权判定：HTTP 401 由 `auth-mw` 处理；业务 200 鉴权码由业务侧 middleware 抛 `AuthError` 触发 refresh。

| #   | 情形                                          | 库行为                                                                |
| --- | --------------------------------------------- | --------------------------------------------------------------------- |
| D1  | **token 即将过期** (业务主动提前 refresh)     | 库不感知；业务侧定时器触发                                            |
| D2  | **refresh token 也过期** (refresh 自己返 401) | refresh 抛错 → AuthError + onAuthFailed                               |
| D3  | **refresh 端点限流** (429)                    | refresh 抛错 → AuthError + onAuthFailed                               |
| D4  | **refresh 端点返 5xx**                        | refresh 抛错 → AuthError                                              |
| D5  | **refresh 端点返业务 envelope 鉴权码**        | refresh 抛错 → AuthError（业务侧 `authRefresher.refresh()` 自己解析） |
| D6  | **refresh 端点 body 非 JSON**                 | 业务侧 `authRefresher.refresh()` 自己处理                             |
| D7  | **refresh 端点 timeout**                      | withTimeout 抛 NetworkError → 转 AuthError                            |
| D8  | **token 含特殊字符** (`+` `/` `=`)            | 业务侧自己 encode；库透传 header                                      |
| D9  | **token 是 JWT 格式** (含 exp claim)          | 业务侧 `authRefresher.refresh()` 可解析 JWT 提前 refresh              |
| D10 | **token 是 opaque** (UUID)                    | 业务侧不管，库透传                                                    |
| D11 | **双 token 体系** (access + refresh)          | 业务侧 `authRefresher.refresh()` 返 access token；库只关心 access     |
| D12 | **单 token 体系** (长期不过期)                | 业务侧 refresh 自己实现                                               |
| D13 | **多 tenant** (ABP `__tenant` header)         | 业务侧 per-request header；库不管                                     |
| D14 | **OAuth2 PKCE 流程**                          | 业务侧自己处理 code_verifier；库不管                                  |
| D15 | **OAuth2 client_credentials**                 | 业务侧 `authRefresher.refresh()` 自己实现                             |
| D16 | **SAML 断言**                                 | 业务侧自己处理；库不管                                                |
| D17 | **API Key header**                            | 业务侧每个请求塞 `X-API-Key`；库不管                                  |
| D18 | **HMAC 签名** (AWS SigV4 / 阿里云)            | 业务侧每次请求签名；库不管                                            |

---

## Layer E：生命周期 / 资源管理

| #   | 情形                                          | 库行为                                          |
| --- | --------------------------------------------- | ----------------------------------------------- |
| E1  | **createNet 重复调用**                        | ✅ 工厂模式：每次返独立 client，无全局状态      |
| E2  | **createNet 后 tokenStore 引用变化**          | ✅ 工厂模式：client 持有 authService 引用，不变 |
| E3  | **createNet 后 baseURL 变化**                 | ✅ 工厂模式：client 独立，需重新 createNet      |
| E4  | **业务页面卸载时 fetch 未完成**               | 业务侧 `AbortController` 主动 abort             |
| E5  | **业务页面卸载后 fetch 完成** (late response) | 库不管；业务侧 catch 后判断是否更新 state       |
| E6  | **浏览器 tab 切换到后台 fetch 是否继续**      | 浏览器行为；库不管                              |
| E7  | **Service Worker 拦截 fetch**                 | 业务侧配置 SW；库不管                           |
| E8  | **浏览器离线 → 在线后重试**                   | 业务侧自己实现重试逻辑                          |
| E9  | **同一 endpoint 不同业务实例调用**            | 库不管；业务侧自己管理                          |
| E10 | **多 tab 共享 token** (localStorage)          | 库不管；业务侧用 `storage` event 同步           |
| E11 | **多 tab 互斥 logout**                        | 库不管；业务侧用 `storage` event                |

---

## Layer F：错误传播 / Promise 行为

| #   | 情形                                                  | 库行为                                                   |
| --- | ----------------------------------------------------- | -------------------------------------------------------- |
| F1  | **业务侧 catch 后 throw 一个新错误**                  | 库不管；透传                                             |
| F2  | **业务侧 catch 后 await 其他 promise**                | 库不管                                                   |
| F3  | **业务侧 try/catch/finally 中 finally 抛错**          | 库不管                                                   |
| F4  | **业务侧 await Promise.all([net.request(...), ...])** | 任一 reject → 整个 reject                                |
| F5  | **业务侧 Promise.allSettled 中部分请求失败**          | 各自 catch；库不影响                                     |
| F6  | **业务侧 Promise.race 中第一个请求失败**              | race reject；其他继续                                    |
| F7  | **AbortController.abort() 在 fetch 中途触发**         | 库支持（`opts.signal`）；抛 `NetworkError(kind="abort")` |
| F8  | **用户主动取消请求**                                  | 同 F7                                                    |

---

## v0.2 架构覆盖性验证（2026-07-31）

> 系统性核对 97 个场景对 v0.2 架构（HttpClient + AuthService + createNet + middleware 链）的覆盖情况。

### ✅ 完全覆盖（93/97）

| Layer      | 覆盖  | 关键机制                                                                                                                               |
| ---------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **A** (22) | 22/22 | 业务侧 middleware 解 envelope；auth-mw 处理 401；retry-mw 处理 429；http-error-mw 统一校验最终状态                                     |
| **B** (28) | 24/28 | HttpClient catch fetch 错误 → NetworkError；AbortController 超时/取消；FormData/URLSearchParams 支持                                   |
| **C** (10) | 10/10 | 业务侧 middleware `onResponse` 解包（string/array/paged/null/nested 均可）                                                             |
| **D** (18) | 18/18 | AuthService 单飞 + 窗口保护 + 超时；auth-mw 401→refresh→retry；业务侧 middleware 抛 `RetryableError({needsRefresh:true})` 触发 refresh |
| **E** (11) | 11/11 | 工厂模式无全局状态；AbortController 取消；业务侧 storage event 多 tab 同步                                                             |
| **F** (8)  | 8/8   | 请求失败统一 throw；未知运行错误归一化为 `unexpected` 并保留 cause；Promise 组合保持标准行为                                           |

### ❌ 不支持（4/97）— 流式响应，暂不实装

> 详细设计见 [stream-design.md](./stream-design.md)（暂不实装，等真实业务场景驱动）

| 场景            | 原因                     | 计划                                                              |
| --------------- | ------------------------ | ----------------------------------------------------------------- |
| B13 NDJSON      | HttpClient 一次性读 body | 暂不实装；真要时 `responseType: "stream"` + `readNdjson` helper   |
| B14 SSE         | 同上                     | 暂不实装；真要时 `createSseClient(stream)` helper                 |
| B17 stream body | fetch 尚未广泛支持       | 暂不实装；真要时 `body: ReadableStream` 直接传 fetch              |
| B25 WebSocket   | 协议不同                 | **不扩展**（库定位 HTTP，业务侧用原生 `WebSocket` + AuthService） |

### ⚠️ 设计如此（库不管）

| 场景              | 原因                                         |
| ----------------- | -------------------------------------------- |
| D1 token 即将过期 | 业务侧定时器主动 refresh（库不感知 JWT exp） |
| E6 tab 后台 fetch | 浏览器行为                                   |
| E7 Service Worker | 业务侧配置                                   |
| E8 离线→在线重试  | 业务侧自己实现                               |

### 关键验证点

1. **A14 业务 200 鉴权码**（最关键）：业务侧 middleware 检测 `code=40001` → 抛 `RetryableError({ needsRefresh: true })` → createNet retry loop catch → `authService.refreshIfNeeded()` → 重发（新 token 由 auth-mw onRequest 注入）。✅ 链路完整
2. **A17 429 + Retry-After**：retry-mw 抛 `RetryableError` → createNet retry loop 读取 `Retry-After` 退避。✅ 库内置
3. **A18 5xx + HTML**：最终状态校验抛 `ApiError(kind="http")`，解析后的字符串 body 和 Response 均保留。✅ 库内置
4. **D2 refresh token 也过期**：AuthService refresh 抛错 → `onAuthFailed()` 回调 → 业务侧跳登录。✅ 链路完整
5. **E1-E3 工厂模式**：`createNet()` 每次返独立 client，无全局状态污染。✅ v0.2 核心改进

### ✅ A14 实测（Playwright，2026-07-31）

测试脚本 `/tmp/test-a14.py`，链路完整通过：

```text
[OK] 登录成功
[OK] 基本 GET 列表正常 (status=200)
[INFO] token (正常): mock-token...
[INFO] 已设置 token=biz-code-expired
[INFO] A14 调用结果: {'ok': True, 'status': 200, 'data': {'ok': True, 'checked': 'biz-code-expired path'}}
[OK] A14 链路成功！token 已被 refresh 更新: refreshed-token...
[OK] 0 console errors
```

**完整链路**：

1. `localStorage.app_token = "biz-code-expired"` → 下次请求 auth-mw 注入 `Authorization: Bearer biz-code-expired`
2. mock-server `/api/auth/biz-code-expired` 返 `200 + {code: 40001, ...}`
3. `abp-unwrap-mw.ts` 检测 `code=40001` ∈ AUTH_CODES → 抛 `RetryableError({needsRefresh: true})`
4. `create-net.ts` retry loop catch → `authService.refreshIfNeeded()` → token 更新为 `refreshed-token`
5. auth-mw `onRequest` 用新 token 重发 → mock 返 `200 + {code: 0, data: {...}}`
6. `abp-unwrap-mw.ts` 解 envelope → 返 data → 业务代码拿到 `{ok: true, checked: "biz-code-expired path"}`

### ✅ Node 单测脚本实测（2026-07-31）

测试脚本 [scripts/test/scenarios.ts](../../scripts/test/scenarios.ts)，直接 import `@xapiforge/core`，覆盖 9 个 Section 共 **222 个断言**，全部通过：

```text
xapiforge 场景验证开始
target: http://localhost:8787

━━━ Section 1: HttpClient（HTTP 层）━━━           ← A18/A19/A20/A21/A22/B4/B10/B11/B23/B16/F7
━━━ Section 2: middleware 单元测试 ━━━             ← retry-mw/http-error-mw/auth-mw
━━━ Section 3: AuthService 单元测试 ━━━            ← E1/单飞/窗口/D2/D7
━━━ Section 4: 业务 envelope 变体（C1-C10）━━━     ← C1-C10 + L4.8
━━━ Section 5: middleware 链 + retry loop ━━━      ← 429 重试计数 / 5xx → ApiError
━━━ Section 6: A14 业务 200 鉴权码（库层）━━━      ← A14 needsRefresh 完整链路
━━━ Section 7: 端到端鉴权（A16/D2/D7）+ B19 ━━━   ← 真实 /connect/token + 文件下载
━━━ Section 8: client.request 走内核（无 schema）━━━ ← data-or-throw / validateStatus
━━━ Section 9: 文件下载走内核 ━━━                  ← progress / 文件名 / auth / HTTP 错误

✅ Passed: 222
❌ Failed: 0
```

**覆盖的关键场景**：

| 场景      | 验证方式                                    | 结果                                                    |
| --------- | ------------------------------------------- | ------------------------------------------------------- |
| A14       | createNet + abpUnwrapMw + 真实 mock-server  | needsRefresh → refresh → retry → 200 ✅                 |
| A16       | createNet + auth-mw + token=expired → 401   | refresh → refreshed-token → retry → 200 ✅              |
| A17       | retry-mw 429 + Retry-After → RetryableError | createNet retry 3 次 → `ApiError(kind="rate-limit")` ✅ |
| A18       | HttpClient 5xx + HTML                       | body 原样保留，不抛错（middleware 决定）✅              |
| A21/A22   | HttpClient 204 / 200+empty                  | bodyText="" ✅                                          |
| B4        | HttpClient timeoutMs=500, mock slow 2000ms  | NetworkError("timeout") ✅                              |
| B11       | HttpClient BOM 响应                         | JSON.parse 容忍 BOM ✅                                  |
| B16       | HttpClient URLSearchParams body             | /connect/token 拿到 access_token ✅                     |
| B19       | HttpClient responseType:"blob"              | blob.size=1024 + Content-Disposition ✅                 |
| B23       | HttpClient 302 重定向                       | fetch follow → 最终 401 ✅                              |
| C1-C10    | 10 种 envelope 变体 unwrap 函数             | 全部正确解包 ✅                                         |
| D2        | createNet + auth-mw + refresh-401 scenario  | AuthError + onAuthFailed(1) ✅                          |
| D7        | createNet + auth-mw + refresh-slow scenario | refreshTimeoutMs=500 → AuthError ✅                     |
| E1        | 两个 AuthService 独立                       | token 互不干扰 ✅                                       |
| F7        | HttpClient signal.abort()                   | NetworkError("aborted") ✅                              |
| HTTP 错误 | createNet 默认请求 404                      | `ApiError(kind="http")`，body / Response 保留 ✅        |
| 状态覆盖  | 全局与单请求 `validateStatus` 接受 404      | 返回 `{ data, response }`，响应头可读 ✅                |
| 解析错误  | 2xx + 非法 JSON                             | `ApiError(kind="parse")` + cause ✅                     |
| 未知错误  | middleware 抛普通运行错误                   | `ApiError(kind="unexpected")` + cause ✅                |
| 单飞      | 10 并发 refreshIfNeeded                     | refresher 调 1 次 ✅                                    |
| 窗口      | 30s 内重复 refreshIfNeeded                  | refresher 调 1 次（窗口内不重复）✅                     |

---

## 库行为未覆盖场景（设计层面）

> 这些场景当前**库不直接处理**，业务侧需要自己实现。如有必要，库可扩展。

| 场景                       | 当前行为                                                                       | 建议                          |
| -------------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| A14 业务 200 鉴权码        | 业务侧 middleware 抛 `RetryableError({needsRefresh:true})` → 库 refresh + 重试 | ✅ 实测通过（Playwright）     |
| A17 限流 429 + Retry-After | retry-mw 内置                                                                  | ✅ 已支持                     |
| D1 token 即将过期          | 业务侧定时器                                                                   | 可加 `createProactiveRefresh` |
| B13/B14 流式响应           | 库不支持                                                                       | v0.3 加 stream                |
| F8 用户主动取消            | HttpClient `opts.signal`                                                       | ✅ 已支持                     |

---

## 相关文档

- [backend-protocols.md](./backend-protocols.md) — 每个后端 envelope 形态的 JSON 示例
- [behavior-contract.md](./behavior-contract.md) — 情形 × 期待行为 × 当前状态 实现级别表

---

## 如何加新场景

1. 在合适的 Layer 段尾加一行表格
2. 在 BEHAVIOR-CONTRACT.md 加对应编号
3. 在 BACKEND-PROTOCOLS.md 加对应 JSON 示例（如果有新 envelope 形态）
4. 评估库要不要支持；如果支持，加到 NetConfig 或库 API
