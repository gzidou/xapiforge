# @xapiforge/core 三层架构与 fetch 注入

> **状态**：补充文档（2026-08-01）
> **关系**：本文是 [architecture-v0.2.md](./architecture-v0.2.md) 的补充，专注讲清楚"三层分工"和"fetch 可注入"两个核心设计。
> **维护者必读**：改 fetch / 改 openapi-fetch 接入方式 / 加新运行时（Capacitor/RN/Electron）前，先读本文。

---

## 1. 为什么需要三层

前端网络栈的复杂性来自三个正交维度：

| 维度       | 问题                                         | 例子                                                 |
| ---------- | -------------------------------------------- | ---------------------------------------------------- |
| **协议层** | 请求怎么序列化、响应怎么解析、类型怎么保证   | URL 拼接、body JSON.stringify、OpenAPI schema 强类型 |
| **治理层** | 鉴权、重试、超时、错误类型化、业务 envelope  | 401 refresh、429 退避、5xx 抛错、ABP envelope 解包   |
| **网络层** | TCP/HTTP 怎么发、证书怎么处理、cookie 怎么管 | 浏览器 fetch、Node undici、Capacitor 原生 HTTP       |

把三者混在一起写（v0.1 的做法）会有几个问题：

1. **换运行时就要重写治理层**：v0.1 把 fetch 调用和 envelope 解包耦合在一起，换 Capacitor 就要重写整个请求函数
2. **协议层类型丢失**：手写 URL 字符串拼参，路径/参数拼错编译期不报错
3. **治理逻辑分散**：refresh 散落在多个调用点，并发 401 无法单飞

三层架构的核心思想：**每个维度独立演进，通过明确的接口衔接**。

- 协议层换 schema（swagger.json）→ 不影响治理层和网络层
- 治理层加新 middleware（如新后端 envelope）→ 不影响协议层和网络层
- 网络层换运行时（浏览器 → Capacitor）→ 不影响协议层和治理层

---

## 2. 三层分工

```text
┌──────────────────────────────────────────────────────────────┐
│  业务侧（demo-app / ionic-app / ...）                          │
│  api.user.getOne("123")           ← 强类型调用                 │
│                                                                │
│  ┌─ 业务 middleware（envelope 解包、业务错误判定）             │
│  │  例：createAbpUnwrapMw（ABP {code, data} 解包）             │
│  │  例：createWechatErrcodeMw（微信 errcode 判定）             │
│  └─ 业务错误类型（AbpBizError / WechatError / ...）            │
└────────────────────────┬─────────────────────────────────────┘
                         │ 调用
┌────────────────────────▼─────────────────────────────────────┐
│  @xapiforge/core（治理层 + 协议层接入）                          │
│                                                                │
│  ┌─ 治理层（我们补的能力）──────────────────────────────────┐  │
│  │  1. AuthService（鉴权状态机）                              │  │
│  │     - token 注入 / 401 refresh / 单飞 / 窗口保护           │  │
│  │     - onAuthFailed 跳登录                                  │  │
│  │  2. 内核 middleware（自动注入）                            │  │
│  │     - authMiddleware：401 → refresh → RetryableError      │  │
│  │     - httpErrorMiddleware：最终状态校验 → ApiError        │  │
│  │  3. retry loop（catch RetryableError → 重发，走完整链）   │  │
│  │  4. 超时（createTimeoutFetch 包装 AbortController）       │  │
│  │  5. 错误类型（ApiError + kind / cause / body / response）│  │
│  │  6. 文件下载/上传（download / upload / uploadBatch）      │  │
│  │     - 流式进度、文件名提取、断点续传、并发控制              │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌─ 协议层接入（委托给 openapi-fetch）─────────────────────┐  │
│  │  createNet<paths>() 内部：                                │  │
│  │    createClient<paths>({ baseUrl, fetch })  ← openapi-fetch│ │
│  │    client.use(authMw); client.use(httpErrorMw)            │  │
│  │    client.use(业务 middleware...)                          │  │
│  │    wrapWithRetry(client.GET/POST/...)                     │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────────────┬─────────────────────────────────────┘
                         │ 调用 fetch(input, init)
┌────────────────────────▼─────────────────────────────────────┐
│  openapi-fetch（协议层）                                       │
│                                                                │
│  client.GET("/users/{id}", { params: { path: { id } } })      │
│    1. URL 拼接（baseUrl + path params 替换）                   │
│    2. Query / Body / Headers 序列化                            │
│    3. middleware 链执行                                        │
│  ┌────────────────────────────────────────────────┐           │
│  │  onRequest: authMw（注入 token） → 业务 mw       │           │
│  │      ↓                                          │           │
│  │  fetch(url, init)  ← 真正发 HTTP                │           │
│  │      ↓                                          │           │
│  │  onResponse: 业务 mw → retryMw → authMw → httpErrorMw │      │
│  └────────────────────────────────────────────────┘           │
│    4. 响应解析（json / blob / stream / text）                  │
│    5. 内部返回 {data,response} | {error,response}（强类型）    │
│       createNet 对外归一化为成功 {data,response} / 失败 throw  │
└────────────────────────┬─────────────────────────────────────┘
                         │ 调用 fetch
┌────────────────────────▼─────────────────────────────────────┐
│  fetch（网络层）—— 可注入，默认 globalThis.fetch                │
│                                                                │
│  ┌─ 浏览器：XMLHR / Fetch API                                  │
│  ├─ Node 18+：undici                                           │
│  ├─ Capacitor：CapacitorHttp（原生 NSURLSession / OkHttp）     │
│  ├─ React Native：fetch polyfill                               │
│  └─ Electron：Node fs + net                                    │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 协议层：openapi-fetch

**职责**：基于 OpenAPI schema 的类型安全 HTTP 客户端。

**它封装了**：

| 能力           | 说明                                                         |
| -------------- | ------------------------------------------------------------ |
| URL 拼接       | `baseUrl` + path params 替换（`/users/{id}` → `/users/123`） |
| Query 序列化   | `{ params: { query: { page: 1 } } }` → `?page=1`             |
| Body 序列化    | 对象 → JSON / FormData 原样 / Blob 原样                      |
| Headers 合并   | baseHeaders + request headers + content-type                 |
| 响应解析       | `parseAs: "json" / "blob" / "stream" / "text"`               |
| 强类型推导     | `paths` schema → 路径 / 参数 / 响应类型全部强类型            |
| middleware 链  | onRequest / onResponse 钩子（我们靠这个接入治理层）          |
| **fetch 注入** | `createClient({ fetch })` 可换底层 fetch                     |

**它不管**：鉴权状态机、401 重试、429 退避、5xx 抛错、超时、业务 envelope、错误类型化。

**为什么不自己写协议层**：

1. OpenAPI schema → TypeScript 类型的代码生成是繁琐工程，openapi-typescript + openapi-fetch 已经成熟
2. openapi-fetch 的 middleware 钩子是天然的治理层接入点
3. 它的 `fetch` 可注入，不锁定网络层

### 2.2 治理层：@xapiforge/core

**职责**：鉴权状态机、重试、超时、错误类型化、文件下载/上传。

**我们补的能力**（openapi-fetch 不管的）：

| 能力                | 实现位置                                        | 说明                                                          |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| AuthService         | `packages/core/src/auth-service.ts`             | token 存取 + 单飞 refresh + 窗口保护 + 超时 + onAuthFailed    |
| authMiddleware      | `packages/core/src/middleware/auth-mw.ts`       | 401 → refresh → 抛 RetryableError 让 retry loop 重发          |
| httpErrorMiddleware | `packages/core/src/middleware/http-error-mw.ts` | 最终执行 `validateStatus`；失败抛带 body/Response 的 ApiError |
| retry loop          | `packages/core/src/create-net.ts`               | catch RetryableError → 重发（走完整 middleware 链）           |
| 超时                | `createTimeoutFetch`（create-net.ts 内）        | 包装 AbortController，合并用户 signal                         |
| 错误类型            | `packages/core/src/errors.ts`                   | ApiError / AuthError / NetworkError / 内部 RetryableError     |
| 文件下载            | `api.download`（业务侧 init.ts）                | 流式进度、文件名提取、断点续传、onChunk 流式写盘              |
| 文件上传            | `api.upload / api.uploadBatch`                  | FormData 上传、并发控制                                       |

**关键设计**：治理层通过 middleware 钩子接入 openapi-fetch，不修改 openapi-fetch 源码。

### 2.3 网络层：fetch（可注入）

**职责**：真正发 HTTP 请求。

**默认实现**：`globalThis.fetch`（浏览器 / Node 18+ / React Native polyfill）。

**可替换为**：

| 运行时       | fetch 实现                             | 为什么换                            |
| ------------ | -------------------------------------- | ----------------------------------- |
| 浏览器       | `globalThis.fetch`                     | 默认，不用换                        |
| Capacitor    | `capacitorFetch`（适配 CapacitorHttp） | 绕过 CORS、信任自签证书、原生网络栈 |
| Electron     | Node `undici.fetch`                    | 主进程网络，绕过渲染进程限制        |
| React Native | 默认 polyfill 即可                     | RN 自带 fetch polyfill              |

---

## 3. fetch 注入链路（贯通三层）

业务侧切换运行时（如 Capacitor），只需在最底层换 fetch，上面两层自动透传：

```text
业务侧：createNet({ fetch: capacitorFetch })
    │
    ▼
@xapiforge/core：createNet
    │  const fetchFn = config.fetch ?? globalThis.fetch
    │  const client = createClient<paths>({
    │    baseUrl: config.baseURL,
    │    fetch: createTimeoutFetch(timeoutMs, fetchFn, logger),  ← 包一层超时
    │  })
    ▼
openapi-fetch：createClient
    │  let { fetch: baseFetch = globalThis.fetch } = clientOptions
    │  内部：await baseFetch(request, requestInit)
    ▼
middleware 链：
    │  onRequest: authMw（注入 token） → 业务 mw
    │      ↓
    │  wrappedCapacitorFetch(url, init)  ← 真正发请求
    │      ↓
    │  onResponse: 业务 mw → httpErrorMw → authMw
    ▼
capacitorFetch（业务侧实现）
    │  把 fetch(input, init) 转成 CapacitorHttp.request({ url, method, headers, data })
    │  把 Capacitor 响应转成 new Response(body, { status, headers })
    ▼
CapacitorHttp（原生）
    │  iOS: NSURLSession
    │  Android: OkHttp
    ▼
网络
```

**关键点**：

1. `NetConfig.fetch` 是注入点（默认 `globalThis.fetch`）
2. `createTimeoutFetch` 透传 fetchFn（只加超时，不改变行为）
3. openapi-fetch 的 `createClient({ fetch })` 原生支持（[官方 API](https://openapi-fetch.js.org/)）
4. `capacitorFetch` 适配器由业务侧实现，约 30 行代码

---

## 4. 完整请求流程图

以 `api.user.getOne("123")` 为例，展示一个请求从业务调用到网络返回的完整流程：

```text
业务侧                          @xapiforge/core                    openapi-fetch              fetch
─────────────────────────────────────────────────────────────────────────────────────────────────
api.user.getOne("123")
    │
    ├─→ createNet 包装的 GET（带 retry loop）
    │       │
    │       ├─ for attempt in 0..maxRetries:
    │       │     │
    │       │     ├─→ client.GET("/users/{id}", {params:{path:{id:"123"}}})
    │       │     │       │
    │       │     │       ├─ URL 拼接：baseUrl + "/users/123"
    │       │     │       ├─ Headers 序列化
    │       │     │       │
    │       │     │       ├─ onRequest middleware 链（按注册顺序）:
    │       │     │       │     ├─ authMw.onRequest:
    │       │     │       │     │     authService.getToken() → set Authorization
    │       │     │       │     ├─ 业务 mw.onRequest（如有）:
    │       │     │       │     │     （例：加自定义 header）
    │       │     │       │     ↓
    │       │     │       ├─ fetch(url, { headers, body, signal })
    │       │     │       │       │
    │       │     │       │       ├─ createTimeoutFetch 包装:
    │       │     │       │       │     AbortController + setTimeout
    │       │     │       │       │     合并用户 signal
    │       │     │       │       │     ↓
    │       │     │       │       ├─ fetchFn(url, init)  ← globalThis.fetch / capacitorFetch
    │       │     │       │       │       │
    │       │     │       │       │       ├─ [浏览器] XHR/Fetch API
    │       │     │       │       │       ├─ [Capacitor] CapacitorHttp.request → 原生
    │       │     │       │       │       └─→ Response
    │       │     │       │       ↓
    │       │     │       ├─ onResponse middleware 链（反序）:
    │       │     │       │     ├─ 业务 mw.onResponse:
    │       │     │       │     │     if !response.ok: return response（让 httpError 处理）
    │       │     │       │     │     if response.ok: 解包 envelope → 返回解包后的 response
    │       │     │       │     │       （例：ABP {code:0, data:{...}} → data）
    │       │     │       │     ├─ retryMw.onResponse:
    │       │     │       │     │     if status === 429: throw RetryableError
    │       │     │       │     ├─ authMw.onResponse:
    │       │     │       │     │     if status === 401:
    │       │     │       │     │       比较 reqToken vs lastToken
    │       │     │       │     │       ├─ 并发 401（旧 token）→ refreshIfNeeded → throw RetryableError
    │       │     │       │     │       ├─ 重发 401（新 token 被拒）+ 窗口内 → AuthError + onAuthFailed
    │       │     │       │     │       └─ 窗口外 → refreshIfNeeded → throw RetryableError
    │       │     │       │     ├─ httpErrorMw.onResponse（最后执行）:
    │       │     │       │     │     request validator > global validator > response.ok
    │       │     │       │     │     不可接受：clone response → 解析 body → throw ApiError
    │       │     │       │     ↓
    │       │     │       ├─ 响应解析（parseAs: "json" → response.json()）
    │       │     │       ↓
    │       │     │       openapi-fetch 返回 { data, response } 或 { error, response }
    │       │     ↓
    │       │     ├─ catch RetryableError:
    │       │     │     if attempt < maxRetries:
    │       │     │       if needsRefresh: await authService.refreshIfNeeded()
    │       │     │       if retryAfterMs: await sleep(retryDelayMs(attempt, retryAfterMs))
    │       │     │       continue  ← 重发（走完整 middleware 链）
    │       │     │     else: 归一化为 ApiError(kind="auth" | "rate-limit")
    │       │     ├─ catch 其他错误:
    │       │     │     已是 ApiError 则原样抛；否则归一化为 parse / unexpected
    │       │     ↓
    │       └─ 返回 { data, response }
    ↓
业务侧拿到 data（强类型 UserDto）
```

---

## 5. 三层分工矩阵

| 能力                         | 协议层（openapi-fetch） | 治理层（@xapiforge/core）          | 网络层（fetch） |
| ---------------------------- | ----------------------- | ---------------------------------- | --------------- |
| URL 拼接                     | ✅                      |                                    |                 |
| Query/Body/Headers 序列化    | ✅                      |                                    |                 |
| 响应解析（json/blob/stream） | ✅                      |                                    |                 |
| 强类型（schema → TS）        | ✅                      |                                    |                 |
| middleware 链                | ✅（提供钩子）          | ✅（实现 auth/httpError）          |                 |
| 鉴权状态机                   |                         | ✅（AuthService）                  |                 |
| 401 refresh + 重发           |                         | ✅（authMw + retry loop）          |                 |
| 429 退避重试                 |                         | ✅（retry loop）                   |                 |
| 不可接受的 HTTP 状态抛错     |                         | ✅（httpErrorMw + validateStatus） |                 |
| 超时                         |                         | ✅（createTimeoutFetch）           |                 |
| 错误类型化                   |                         | ✅（ApiError.kind + cause）        |                 |
| 业务 envelope 解包           |                         | ✅（业务侧 middleware）            |                 |
| 文件下载/上传                |                         | ✅（download/upload/uploadBatch）  |                 |
| 真正发 HTTP                  |                         |                                    | ✅              |
| 证书处理                     |                         |                                    | ✅              |
| CORS                         |                         |                                    | ✅              |
| Cookie 管理                  |                         |                                    | ✅              |

---

## 6. 切换运行时示例

### 6.1 浏览器（默认，无需配置）

```typescript
import { createNet } from "@xapiforge/core";

const api = createNet<paths>({
  baseURL: "https://api.example.com",
  authService,
  middleware: [createAbpUnwrapMw()]
  // fetch 不传，默认 globalThis.fetch
});
```

### 6.2 Capacitor（原生 HTTP）

```typescript
// capacitor-fetch.ts —— 业务侧实现 fetch 适配器
import { CapacitorHttp, type HttpOptions } from "@capacitor/core";

export const capacitorFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  let data: unknown;
  if (req.body) {
    const ct = headers["Content-Type"] ?? "";
    data = ct.includes("application/json") ? await req.json() : await req.text();
  }

  const opts: HttpOptions = { url: req.url, method: req.method, headers, data };
  const res = await CapacitorHttp.request(opts);

  // 转 Web Response（openapi-fetch 需要 .json()/.text()/.blob()）
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? "");
  return new Response(body, { status: res.status, headers: res.headers });
};

// main.ts
import { capacitorFetch } from "./capacitor-fetch";
import { createNet } from "@xapiforge/core";

const api = createNet<paths>({
  baseURL: "https://api.example.com",
  authService,
  middleware: [createAbpUnwrapMw()],
  fetch: capacitorFetch // ← 注入原生 HTTP
});
```

**注意**：`CapacitorHttp` 返回的 `Response` 不支持 `response.body`（ReadableStream），流式下载需退化到 blob 模式或用 `Filesystem.downloadFile`。

### 6.3 Electron（Node 主进程）

```typescript
import { fetch as undiciFetch } from "undici";

const api = createNet<paths>({
  baseURL: "https://api.example.com",
  authService,
  middleware: [createAbpUnwrapMw()],
  fetch: undiciFetch as unknown as typeof fetch
});
```

### 6.4 React Native（默认 polyfill 即可）

```typescript
// RN 自带 fetch polyfill，无需特殊配置
const api = createNet<paths>({
  baseURL: "https://api.example.com",
  authService,
  middleware: [createAbpUnwrapMw()]
});
```

---

## 7. 设计决策与权衡

### 7.1 为什么委托 openapi-fetch，不自己写协议层？

| 选项               | 优点                                  | 缺点                                          |
| ------------------ | ------------------------------------- | --------------------------------------------- |
| 自己写协议层       | 完全可控，无第三方依赖                | 要实现 URL 拼接、序列化、类型推导，工作量巨大 |
| 委托 openapi-fetch | 成熟、类型推导强、middleware 钩子够用 | 多一个依赖，但它是 peerDep（业务侧自己装）    |

**选择**：委托 openapi-fetch。理由：

1. OpenAPI schema → TypeScript 类型推导是繁琐工程，不值得重造
2. openapi-fetch 的 middleware 钩子（onRequest/onResponse）是天然的治理层接入点
3. 它的 `fetch` 可注入，不锁定网络层

### 7.2 为什么治理层用 middleware，不用拦截器？

v0.1 用拦截器（interceptor），v0.2 改用 middleware。区别：

| 拦截器（v0.1）                                            | middleware（v0.2）                                         |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| 自己实现请求/重发逻辑                                     | 复用 openapi-fetch 的 middleware 链                        |
| 拦截器自己 `fetch(request.clone())` 重发 → 绕过后续拦截器 | 抛 RetryableError 让 createNet 重发 → 走完整 middleware 链 |
| 拦截器之间无明确顺序                                      | 数组顺序 + onRequest 正序 / onResponse 反序                |
| 难以组合（多个拦截器互相干扰）                            | 可组合（auth / httpError / 业务互不干扰）                  |

**关键**：middleware 不自己重发请求，而是抛 RetryableError 信号，让 createNet 的 retry loop 统一重发。这保证重发走完整 middleware 链。

### 7.3 为什么 fetch 可注入，而不是写死 globalThis.fetch？

| 选项                    | 优点                         | 缺点                                         |
| ----------------------- | ---------------------------- | -------------------------------------------- |
| 写死 `globalThis.fetch` | 简单                         | Capacitor 无法用原生 HTTP，CORS/证书问题无解 |
| 可注入 `config.fetch`   | 支持多运行时，业务侧自主选择 | 业务侧要写适配器（约 30 行）                 |

**选择**：可注入。理由：

1. 符合 v0.2 原则"可扩展性，新运行时通过配置接入，不改库代码"
2. openapi-fetch 原生支持 `fetch` 参数，无额外工作
3. 适配器只有 30 行，业务侧一次编写永久使用

### 7.4 文件下载策略（浏览器 vs Capacitor）

`CapacitorHttp` 返回的 `Response` 不支持 `response.body`（ReadableStream），因为原生 HTTP 一次性返回完整响应体。

#### 两种下载 API 的分工

| API                          | 来源                                          | 场景                                   | 内存    | 走 middleware                    |
| ---------------------------- | --------------------------------------------- | -------------------------------------- | ------- | -------------------------------- |
| `api.download(url, onChunk)` | 业务侧封装（参考 `demo-app/src/api/init.ts`） | API 返回流（POST 下载，需 auth/retry） | 流式：0 | ✅                               |
| `downloadFileNative(url)`    | `@xapiforge/adapter-capacitor`                | 静态文件 URL（`http://xxx.pdf`）       | **0**   | ❌（但支持 getHeaders 动态鉴权） |

> **注意**：`api.download` 不在 `@xapiforge/core` 包里导出。它是业务侧基于 `createNet` 返回的 rawClient + `response.body.getReader()` 自己实现的封装（完整实现见 [demo-app/src/api/init.ts](../../examples/demo-app/src/api/init.ts) 的 `download` 函数）。`@xapiforge/core` 只提供 `HttpClient`（底层 fetch 封装）和 `createNet`（openapi-fetch + middleware），文件下载的流式/进度/写盘逻辑由业务侧组装。

#### 决策树

```text
下载文件
  ├─ 服务端给的是静态 URL（http://xxxxx/xxx.pdf）？
  │   ├─ 是 → downloadFileNative（原生直写磁盘，0 内存）
  │   │       ├─ 需要鉴权？用 getHeaders 回调（支持 token refresh）
  │   │       └─ 需要取消？传 signal（abort 后 JS 立即 reject）
  │   └─ 否（API 返回流，POST + body）
  │       └─ api.download(url, { onChunk })
  │           ├─ 浏览器：走 fetch + ReadableStream（完美）
  │           └─ Capacitor：response.body 为 null → 退化 blob 模式
  │               └─ 大文件（>100MB）会 OOM → 改用 downloadFileNative
```

#### downloadFileNative 实现

封装 `@capacitor/filesystem` 的 `downloadFile`，原生层（iOS NSURLSession / Android OkHttp）流式下载到磁盘。

```typescript
import { downloadFileNative } from "@xapiforge/adapter-capacitor";

const controller = new AbortController();

const result = await downloadFileNative({
  url: "http://xxxxx/xxx.pdf",
  path: "reports/xxx.pdf",
  directory: "DOCUMENTS",
  onProgress: (received, total) => setProgress(received / total),
  signal: controller.signal, // 取消：controller.abort()
  getHeaders: async () => {
    // 动态鉴权（token 过期时自动 refresh）
    await authService.refreshIfNeeded();
    return { Authorization: `Bearer ${authService.getToken()}` };
  }
});
// result.path = 本地文件路径
// 用 Capacitor.convertFileSrc(result.path) 转 WebView 可访问的 URL
```

**为什么放在 adapter 包而不是 `@xapiforge/core`**：
`@xapiforge/core` 是运行时无关的核心库，不能依赖任何 Capacitor API。
所有 Capacitor 相关的适配（TokenStore / fetch / 下载）都在 `adapter-capacitor`。

**特性**：

- signal 取消（abort 后 JS 立即 reject，原生后台继续，业务侧自行清理残留文件）
- getHeaders 动态鉴权（覆盖静态 headers 同名字段，支持 token refresh）
- 串行队列（多文件下载自动排队，progress listener 不串扰）
- 错误类型 `DownloadFileNativeError`（code: MODULE_NOT_FOUND / ABORTED / DOWNLOAD_FAILED，cause 保留原始错误）

**已知限制**：

- 不走 middleware 链（无 auth refresh / retry / envelope 解包）—— 用 getHeaders 部分弥补鉴权
- abort 后原生下载会继续（Capacitor Filesystem.downloadFile 不支持 cancel）
- Capacitor 7.1+ 弃用了 `Filesystem.downloadFile`，推荐 `@capacitor/file-transfer`（未来迁移）

---

## 8. 文件位置速查

| 层     | 文件                                            | 职责                                        |
| ------ | ----------------------------------------------- | ------------------------------------------- |
| 协议层 | `node_modules/openapi-fetch/src/index.js`       | URL/序列化/类型/middleware 链               |
| 治理层 | `packages/core/src/create-net.ts`               | createNet 工厂 + retry loop + 超时 fetch    |
| 治理层 | `packages/core/src/auth-service.ts`             | 鉴权状态机                                  |
| 治理层 | `packages/core/src/middleware/auth-mw.ts`       | 401 → refresh → RetryableError              |
| 治理层 | `packages/core/src/middleware/http-error-mw.ts` | 最终状态校验 → ApiError                     |
| 治理层 | `packages/core/src/errors.ts`                   | ApiError 体系 + 内部 RetryableError         |
| 治理层 | `packages/core/src/http-client.ts`              | 纯 HTTP（无 middleware，给 AuthApi/下载用） |
| 治理层 | `examples/demo-app/src/api/init.ts`             | download / upload / uploadBatch 业务实现    |
| 网络层 | `globalThis.fetch`                              | 默认浏览器/Node fetch                       |
| 网络层 | 业务侧 `capacitorFetch`                         | Capacitor 原生 HTTP 适配器                  |

---

## 9. 相关文档

- [architecture-v0.2.md](./architecture-v0.2.md) — v0.2 完整架构设计（组件 API、决策、场景矩阵）
- [behavior-contract.md](./behavior-contract.md) — 行为契约（边界条件、错误传播规则）
- [backend-protocols.md](./backend-protocols.md) — 后端协议示例（ABP / 微信 / RFC7807）
- [scenarios.md](./scenarios.md) — 场景覆盖矩阵
- [stream-design.md](./stream-design.md) — v0.3 流式支持设计（NDJSON/SSE）
