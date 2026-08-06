# @xapiforge/core — 行为合同表（Behavior Contract）

> **这份表是库设计的 single source of truth**。所有改动必须先看这张表：
>
> - 如果新增情形 → 补到表里，标注**当前状态** = 待设计
> - 如果修改行为 → 先改表，再改代码
> - 如果发现 bug → 加到"已知问题"段，标 issue

> **版本**：当前实现（2026-08-04）—— data-or-throw + 结构化 `ApiError` + 可配置 `validateStatus`

---

## 当前架构总览

```text
┌─────────────────────────────────────────────────────────┐
│  业务代码                                                │
│  api.base.GET("/path")  ← 成功 { data, response }       │
└──────────────────────┬──────────────────────────────────┘
                       │ middleware 链（onRequest / onResponse）
┌──────────────────────▼──────────────────────────────────┐
│  createNet（工厂）                                       │
│  ├─ auth-mw      注入 token / 401 → refresh → retry     │
│  ├─ retry-mw     429 → RetryableError → 退避重试        │
│  ├─ http-error-mw 最终状态校验 → ApiError(kind="http")  │
│  └─ 业务 mw      envelope 解包 / 业务错误（业务侧写）    │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  AuthService（独立状态机）                               │
│  ├─ getToken()       读 tokenStore                       │
│  ├─ refreshIfNeeded() 单飞 + 窗口保护 + 超时             │
│  └─ onAuthFailed     refresh 失败 → 跳登录               │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│  HttpClient（纯 HTTP）                                   │
│  └─ request()  fetch + timeout + abort + blob            │
└─────────────────────────────────────────────────────────┘
```

**核心设计原则**：

1. **库只管 HTTP + 鉴权状态机 + 错误传播**
2. **envelope 解包 / 业务错误判定归业务侧 middleware**
3. **无全局单例**（工厂模式，支持多 client）
4. **无 BizError**（业务侧自定义错误类型）
5. **单请求路径**（openapi-fetch 统一，无 raw/request 双路径）
6. **单一失败通道**（成功返回 `{ data, response }`；请求生命周期失败统一 throw）

---

## Layer 1：HttpClient 层（库管 — 纯 HTTP）

| #     | 情形                              | 期待行为                              | 当前实现                                   | 状态 | 备注                  |
| ----- | --------------------------------- | ------------------------------------- | ------------------------------------------ | ---- | --------------------- |
| L1.1  | 200 + JSON body                   | 返回 bodyText                         | http-client.ts:request `res.text()`        | ✅   | 业务侧自己 JSON.parse |
| L1.2  | 200 + 非 JSON (text/plain, image) | 返回 bodyText 或 blob                 | responseType: "blob" → `res.blob()`        | ✅   | 文件下载场景          |
| L1.3  | 204 No Content                    | bodyText = ""                         | http-client.ts `res.text()` 返空串         | ✅   |                       |
| L1.4  | 4xx / 5xx                         | 返回 response（不抛错）               | http-client.ts 返回 `{ok:false, status}`   | ✅   | 错误判定归 middleware |
| L1.5  | network failure (fetch rejected)  | 抛 NetworkError                       | http-client.ts catch → NetworkError        | ✅   |                       |
| L1.6  | timeout (AbortController timeout) | 抛 NetworkError                       | http-client.ts AbortError → NetworkError   | ✅   |                       |
| L1.7  | 用户主动 abort (opts.signal)      | 抛 NetworkError                       | http-client.ts signal.abort → NetworkError | ✅   |                       |
| L1.8  | CORS preflight failure            | 抛 NetworkError                       | fetch 抛错 → NetworkError                  | ✅   |                       |
| L1.9  | DNS resolution failure            | 抛 NetworkError                       | fetch 抛错 → NetworkError                  | ✅   |                       |
| L1.10 | body = object → JSON.stringify    | 自动设 Content-Type: application/json | http-client.ts `JSON.stringify(body)`      | ✅   |                       |
| L1.11 | body = FormData / Blob            | 原样传，不设 Content-Type             | http-client.ts 直接传 body                 | ✅   | 让浏览器加 boundary   |
| L1.12 | body = string                     | 原样传                                | http-client.ts 直接传 body                 | ✅   | urlencoded 等         |

---

## Layer 2：AuthService 层（库管 — 鉴权状态机）

| #     | 情形                                        | 期待行为                 | 当前实现                                                            | 状态 | 备注                          |
| ----- | ------------------------------------------- | ------------------------ | ------------------------------------------------------------------- | ---- | ----------------------------- |
| L2.1  | token 有效                                  | 直接返回 token           | auth-service.ts `tokenStore.get()`                                  | ✅   |                               |
| L2.2  | token 为 null                               | 触发 refresh             | auth-service.ts `refresh()`                                         | ✅   | 首次登录前 / token 被清       |
| L2.3  | 10 个并发请求同时 401                       | 单飞 refresh（只 1 次）  | auth-service.ts `inflight` Promise                                  | ✅   | v0.1 的 TokenRefresher 已替代 |
| L2.4  | refresh 成功 → 返回新 token                 | 存 tokenStore + 返回     | auth-service.ts `tokenStore.set()`                                  | ✅   |                               |
| L2.5  | refresh 失败 → 抛 AuthError                 | 调 onAuthFailed + reject | auth-service.ts `onAuthFailed()` + throw AuthError                  | ✅   |                               |
| L2.6  | refresh 进行中 + 新请求进来                 | 共享 inflight Promise    | auth-service.ts `return inflight`                                   | ✅   |                               |
| L2.7  | refresh 超时                                | 抛 AuthError，不挂死     | auth-service.ts `refreshTimeoutMs` → AbortController                | ✅   | v0.1 B6 已修                  |
| L2.8  | refresh 端点永久 pending                    | 超时保护                 | 同上                                                                | ✅   |                               |
| L2.9  | refresh 成功 → 重发仍 401                   | 窗口保护 → 不再 refresh  | auth-service.ts `refreshWindowMs` → 返回上次 token                  | ✅   | v0.1 B8/B16 死循环已修        |
| L2.10 | refresh 窗口内重发仍 401                    | 调 onAuthFailed          | auth-service.ts 窗口内返旧 token → 仍 401 → auth-mw 调 onAuthFailed | ✅   | token 被服务端撤销            |
| L2.11 | tokenStore.set 抛错                         | refresh 失败             | auth-service.ts catch → AuthError                                   | ✅   |                               |
| L2.12 | token 过期时间 race（refresh 完瞬间有请求） | 用新 token               | tokenStore 已更新 + 新请求读新 token                                | ✅   |                               |

---

## Layer 3：createNet + Middleware 层（库管 — 请求管道）

| #     | 情形                             | 期待行为                                                                       | 当前实现                                             | 状态                                    | 备注                         |
| ----- | -------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------- | ---------------------------- |
| L3.1  | 正常请求 → 注入 token            | Authorization: Bearer {token}                                                  | auth-mw.ts onRequest                                 | ✅                                      |                              |
| L3.2  | 401 → refresh → 重试             | 用新 token 重发                                                                | auth-mw.ts onResponse 401 → AuthService.refresh      | ✅                                      | A16 Node 单测通过            |
| L3.3  | 401 → refresh 失败               | 抛 AuthError + onAuthFailed                                                    | auth-mw.ts catch AuthError → throw                   | ✅                                      | D2 Node 单测通过             |
| L3.4  | 429 Too Many Requests            | 读 Retry-After → 退避重试                                                      | retry-mw.ts onResponse 429 → RetryableError          | ✅                                      | A17 Node 单测通过            |
| L3.5  | 429 无 Retry-After               | 默认退避（指数）                                                               | retry-mw.ts `retryDelayMs` 默认 1000/2000/4000       | ✅                                      | Node 单测通过                |
| L3.6  | validateStatus 判定为失败的状态  | 抛 `ApiError(kind="http")`，保留解析后的 body 与原始 Response                  | http-error-mw.ts 最终状态校验                        | ✅                                      | 默认采用 `response.ok`       |
| L3.7  | RetryableError → retry loop 重发 | createNet catch RetryableError → 重发；`needsRefresh:true` → 先 refresh 再重发 | create-net.ts retry loop（含 `e.needsRefresh` 分支） | ✅                                      | A14 Node 单测通过            |
| L3.8  | 超过 maxRetries → 抛错           | 抛结构化 `ApiError(kind="auth"                                                 | "rate-limit")`                                       | create-net.ts 归一化内部 RetryableError | ✅                           | 内部重试信号不暴露给业务层 |
| L3.9  | middleware 响应顺序              | 业务 → retry → auth → 最终状态校验                                             | create-net.ts 注册顺序配合 onResponse 反序执行       | ✅                                      | 先给重试逻辑处理，再统一抛错 |
| L3.10 | 业务 middleware 解包 envelope    | 返回解包后的 data                                                              | 业务侧 middleware（如 createAbpUnwrapMw）            | ✅                                      | C1-C10 Node 单测通过         |
| L3.11 | 业务 middleware 抛业务错误       | 向上传播给业务代码                                                             | 业务侧 middleware throw（如 AbpBizError）            | ✅                                      | 库不拦截                     |
| L3.12 | createNet 工厂模式 — 多 client   | 各自独立 authService / middleware                                              | create-net.ts 每次调用创建新 Client                  | ✅                                      | E1 Node 单测通过             |
| L3.13 | rawJson — 第三方 API 不走 schema | 直接 fetch + unwrap                                                            | create-net.ts `rawJson<T>(path, opts)`               | ✅                                      | v0.1 raw() 已替代为 rawJson  |
| L3.14 | 全局/单请求 validateStatus       | 单请求配置优先于全局配置；未配置时使用 `response.ok`                           | http-error-mw.ts 读取请求与全局判定器                | ✅                                      | 可将 404 等状态声明为成功    |
| L3.15 | fetch/超时/abort/解析/未知错误   | 分别归一化为 `network` / `timeout` / `abort` / `parse` / `unexpected` kind     | create-net.ts 最外层错误归一化                       | ✅                                      | 原异常保存在 `cause`         |

---

## Layer 4：业务 Middleware 层（业务侧管，库提供类型）

| #    | envelope 形状                      | 期待行为                                                                  | 当前实现                                                   | 状态 | 备注                                |
| ---- | ---------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | ---- | ----------------------------------- |
| L4.1 | `{code, data, message}` (ABP)      | code=0 → return data; else → throw                                        | demo-app createAbpUnwrapMw                                 | ✅   | Demo 项目示例                       |
| L4.2 | `{ok, data}` (第三方)              | ok=true → return data                                                     | 业务侧 rawJson + unwrap                                    | ✅   | weather API                         |
| L4.3 | `{status, result}` (嵌套)          | 业务侧自己写 middleware                                                   | —                                                          | ✅   | 库支持，业务侧实现                  |
| L4.4 | `{data, errors}` (GraphQL)         | 检查 errors → throw                                                       | 业务侧自己写                                               | ✅   |                                     |
| L4.5 | `array` (无 envelope)              | identity (p => p)                                                         | 业务侧自己写                                               | ✅   |                                     |
| L4.6 | 业务 200 + envelope {code: 40001}  | 检测鉴权码 → 抛 `RetryableError({needsRefresh:true})` → 库 refresh + 重试 | demo-app createAbpUnwrapMw ABP_AUTH_CODES → RetryableError | ✅   | A14 Node 单测 + Playwright 实测通过 |
| L4.7 | envelope 解包抛错                  | 向上传播                                                                  | middleware throw → 业务代码 catch                          | ✅   | v0.1 L2.7 已修（不再吞错）          |
| L4.8 | 非业务鉴权码的 code (如 code: 500) | 抛业务错误                                                                | createAbpUnwrapMw → AbpBizError                            | ✅   | 业务侧自定义错误类型                |

---

## Layer 5：并发 / 生命周期（库管）

| #    | 情形                                       | 期待行为                | 当前实现                                               | 状态 | 备注                    |
| ---- | ------------------------------------------ | ----------------------- | ------------------------------------------------------ | ---- | ----------------------- |
| L5.1 | 10 个并发请求同时 401                      | 单飞 refresh（只 1 次） | AuthService inflight Promise                           | ✅   |                         |
| L5.2 | 10 个并发 + refresh 失败                   | 全部 reject AuthError   | AuthService inflight reject → 所有 await 的请求 reject | ✅   |                         |
| L5.3 | 10 个并发 + refresh 成功 + 用新 token 重试 | 全部成功                | auth-mw 用新 token 重发                                | ✅   |                         |
| L5.4 | 10 个并发 + 部分 biz 错误                  | 个别 biz，其余 ok       | 各自 middleware 独立判定                               | ✅   |                         |
| L5.5 | refresh 进行中 + 新请求进来                | 共享 inflight           | AuthService inflight                                   | ✅   |                         |
| L5.6 | refresh 超时 → 全部 reject                 | 不挂死                  | AuthService refreshTimeoutMs                           | ✅   |                         |
| L5.7 | 无全局单例 — createNet 多次调用            | 各自独立                | createNet 工厂模式                                     | ✅   | v0.1 setup() 单例已移除 |
| L5.8 | token 过期时间 race                        | 用新 token              | tokenStore 已更新 + 新请求读新 token                   | ✅   |                         |
| L5.9 | createNet retry loop 资源管理              | AbortController 清理    | http-client.ts finally clearTimeout                    | ✅   |                         |

---

## Layer 6：资源管理（库管）

| #    | 资源                       | 期待行为              | 当前实现                                         | 状态 | 备注 |
| ---- | -------------------------- | --------------------- | ------------------------------------------------ | ---- | ---- |
| L6.1 | AbortController 超时 timer | finally clearTimeout  | http-client.ts `clearTimeout(timer)`             | ✅   |      |
| L6.2 | AuthService inflight       | finally 清            | auth-service.ts `finally(() => inflight = null)` | ✅   |      |
| L6.3 | AuthService refresh 超时   | AbortController abort | auth-service.ts `abortCtl.abort()`               | ✅   |      |
| L6.4 | tokenStore.set 抛错        | refresh 失败          | auth-service.ts catch → AuthError                | ✅   |      |
| L6.5 | createNet retry loop       | 超过 maxRetries 停止  | create-net.ts `attempt >= maxRetries`            | ✅   |      |

---

## 错误类型

| 错误类型         | 何时抛                                      | 谁处理                          | 备注                                       |
| ---------------- | ------------------------------------------- | ------------------------------- | ------------------------------------------ |
| `ApiError`       | HTTP / 鉴权 / 限流 / 解析 / 业务 / 未知失败 | 业务代码统一 catch              | `kind` 区分原因，`cause` 保留原异常        |
| `AuthError`      | refresh 失败 / token 不可恢复               | 业务代码 catch / onAuthFailed   | `ApiError` 子类，`kind="auth"`             |
| `NetworkError`   | fetch 失败 / timeout / abort                | 业务代码 catch                  | `ApiError` 子类；HTTP 状态错误不属于网络错 |
| `RetryableError` | 401 / 429 / 业务要求刷新等内部重试信号      | createNet retry loop 自动 catch | 仅供 middleware 与内核协作，不暴露给业务层 |
| 业务错误         | envelope code 非 0 / 非鉴权码               | 业务代码 catch                  | 建议抛 `ApiError(kind="business")`         |

**v0.1 → v0.2 变化**：

- ❌ `BizError` 已移除（业务侧自定义，如 `AbpBizError`）
- ❌ `guard` / `isAuthError` / `isBizError` / `unwrapResponse` 已移除（被 middleware 链替代）
- ❌ `TokenRefresher` 类已移除（被 `AuthService` 替代）
- ❌ `openapi-bridge.ts` 已移除（被 `createNet` + middleware 替代）
- ❌ `setup()` / `net` 全局单例已移除（工厂模式）

---

## 已知设计权衡（接受现状）

| 决策                                | 理由                                             |
| ----------------------------------- | ------------------------------------------------ |
| HttpClient 不自动 JSON.parse        | 保持纯粹；业务侧 middleware 或代码自己 parse     |
| AuthService 独立于 createNet        | AuthApi（登录端点）用 HttpClient 不走 middleware |
| 业务 middleware 写在业务侧          | 库不预设 envelope 格式；可扩展性                 |
| createNet 用 openapi-fetch 作为底层 | 强类型 path/method；社区维护                     |
| 无全局单例（工厂模式）              | 支持多 client（主 API + 第三方 API）             |
| 破坏性变更（v0.1 → v0.2）           | 架构正确性 > 向后兼容                            |

---

## 相关文档

- [backend-protocols.md](./backend-protocols.md) — 后端协议 JSON 示例库（27 类协议 + envelope 变体）
- [scenarios.md](./scenarios.md) — 场景清单
- [architecture-v0.2.md](./architecture-v0.2.md) — v0.2 架构设计文档

---

## 如何用本表

1. **写新代码前**：先查表，确认情形被覆盖
2. **改代码时**：行为变了先改表，再改代码
3. **发现 bug**：加到"已知问题"段，并 fix
4. **设计新特性**：表里加情形 + 期待行为 → 设计 → 实现 → 验证
