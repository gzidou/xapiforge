# v0.3 Stream 支持设计

> **状态：暂不实装**（2026-07-31）
>
> 当前暂无明确流式业务场景。
> 本文档作为设计储备，等真实业务场景出现再按本文档实装（YAGNI）。
>
> 本文档只做**设计**，不动代码。
>
> 错误处理部分若与当前实现冲突，以 [错误处理指南](../guides/error-handling.md) 为准。

---

## 0. 什么场景需要 Stream？

3 种流式形态，对应不同业务需求：

| 形态                        | 什么时候需要                         | 典型场景                            |
| --------------------------- | ------------------------------------ | ----------------------------------- |
| **NDJSON**（每行一个 JSON） | 后端一次性吐大量数据，前端边收边渲染 | 导出 10 万条记录、日志流、ETL       |
| **SSE**（服务器推事件）     | 后端主动推，前端只听                 | 站内通知、实时股价、AI 对话流式输出 |
| **WebSocket**（双向）       | 双向实时通信                         | 聊天、协同编辑                      |

**判断你的项目要不要**：

1. 有「后端推数据给前端」场景吗？（通知/仪表盘）→ 可能需要 SSE
2. 有「一次性传大量数据」场景吗？（导出几万条）→ 可能需要 NDJSON
3. 有「双向通信」场景吗？（聊天）→ 用 WebSocket（库不支持，业务侧自己写）

**当前结论**：暂无典型业务场景驱动，v0.3 暂不实装。

---

> 关闭 SCENARIOS.md 中 B13 / B14 / B17 / B25 四个未支持场景。
> 本文档只做**设计**，不动代码。评审通过后进入实装。

---

## 1. 现状与差距

| 场景                | 含义                                                    | v0.2 现状 | 原因                                                                                           |
| ------------------- | ------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| **B13 NDJSON**      | 响应 body 是 `{"a":1}\n{"a":2}\n...` 流式               | ❌ 不支持 | [http-client.ts](../../packages/core/src/http-client.ts) 用 `res.text()` 一次性读全 body       |
| **B14 SSE**         | `Content-Type: text/event-stream`，`data: ...\n\n` 分块 | ❌ 不支持 | 同上；且 openapi-fetch schema 不覆盖流式                                                       |
| **B17 stream body** | 请求 body 是 `ReadableStream`（大文件上传）             | ❌ 不支持 | [types.ts](../../packages/core/src/types.ts) `body?: unknown` 仅接受 string/FormData/Blob/对象 |
| **B25 WebSocket**   | `Upgrade: websocket` 协议升级                           | ❌ 不支持 | 协议不同（不是 HTTP）                                                                          |

**v0.2 读 body 的位置**（[http-client.ts:82-92](../../packages/core/src/http-client.ts)）：

```typescript
if (responseType === "blob") {
  blob = await res.blob();
} else {
  bodyText = await res.text(); // ← 一次性读完，流式场景失效
}
```

---

## 2. 设计原则（不能违背 v0.2 边界）

| 原则                                              | 说明                                                        |
| ------------------------------------------------- | ----------------------------------------------------------- |
| **1. HttpClient 保持纯 HTTP**                     | stream 是新的 `responseType`，不引入协议层概念              |
| **2. envelope middleware 不碰 stream**            | 流式响应无完整 JSON body，业务 middleware `onResponse` 跳过 |
| **3. auth / retry / httpError middleware 仍生效** | 它们只看 HTTP status（不看 body），stream 兼容              |
| **4. 工厂模式不变**                               | 不引入全局 stream registry                                  |
| **5. WebSocket 不进库**                           | 协议不同，业务侧用原生 `WebSocket` API + 自管 auth          |
| **6. 向后兼容**                                   | 现有 `responseType: "text"                                  | "json" | "blob"` 行为不变 |

---

## 3. API 形状

### 3.1 B13 NDJSON — `responseType: "ndjson"`

**设计**：HttpClient 返回 `ReadableStream<Uint8Array>` + 业务侧自己 split；库提供 helper 但不强制。

```typescript
// types.ts 新增
export type ResponseType = "text" | "json" | "blob" | "stream";

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly blob?: Blob;
  /** responseType="stream" 时有值（NDJSON / SSE / 任意流式） */
  readonly stream?: ReadableStream<Uint8Array>;
}

// 业务侧用法
const res = await http.request({
  method: "GET",
  path: "/api/logs/stream",
  responseType: "stream"
});

// 库提供 ndjson helper（@xapiforge/core 导出）
import { readNdjson } from "@xapiforge/core";

for await (const line of readNdjson<{ ts: number; msg: string }>(res.stream!)) {
  console.log(line.ts, line.msg); // 逐行解析，不等全部读完
}
```

**为什么 `readNdjson` 是 helper 而不是 responseType**：

- NDJSON 的「业务语义」（每行 JSON 的形状）归业务侧
- 库只负责「按 `\n` split + JSON.parse 每行」这个通用操作
- 业务侧可完全不用 helper，自己 `res.stream.pipeThrough(new TextDecoderStream())` 也行

### 3.2 B14 SSE — `createSseClient`

**设计**：SSE 协议有标准结构（`event:` / `data:` / `id:` / `retry:`），值得库提供专用 helper，但**不**做成 responseType（避免 HttpClient 知道协议）。

```typescript
// @xapiforge/core 导出
export interface SseEvent {
  event?: string; // event: 字段
  data: string; // data: 字段（多行用 \n 连接）
  id?: string; // id: 字段
  retry?: number; // retry: 字段（毫秒）
}

export async function* createSseClient(source: ReadableStream<Uint8Array> | Response, signal?: AbortSignal): AsyncIterable<SseEvent> {
  // 内部：TextDecoderStream + 按 \n\n split event + 解析字段
  // 处理 Last-Event-ID 重连由业务侧管（库不自动重连，避免状态机复杂化）
}

// 业务侧用法
const res = await http.request({
  method: "GET",
  path: "/api/notifications/sse",
  responseType: "stream",
  headers: { Accept: "text/event-stream" }
});

for await (const ev of createSseClient(res.stream!, controller.signal)) {
  if (ev.event === "message") {
    const payload = JSON.parse(ev.data);
    console.log(payload);
  }
}
```

**为什么单独导出而不放 responseType**：

- SSE 是协议（事件结构），不是 HTTP body 类型
- HttpClient 不应知道「event/data/id 字段」
- 业务侧可能有自定义 SSE 变体（如 Cloudflare Workers 的 `: heartbeat`），helper 让业务侧绕开

**Last-Event-ID 重连**：库**不**自动重连。理由：

- 重连需要保留 `Last-Event-ID` 状态，与AuthService单飞一样会引入状态机
- 业务侧场景差异大（有些不要重连，有些要指数退避）
- v0.3 先不实现，v0.4 再加 `createResilientSseClient`（带重连 + 退避）

### 3.3 B17 stream body — `body: ReadableStream`

**设计**：HttpRequestOptions.body 接受 `ReadableStream<Uint8Array>`，原样传给 fetch。

```typescript
// types.ts HttpRequestOptions.body 类型扩展
export interface HttpRequestOptions {
  // ...
  body?:
    | unknown // 对象 → JSON.stringify
    | string
    | FormData
    | Blob
    | URLSearchParams
    | ArrayBuffer
    | ReadableStream<Uint8Array>; // ← 新增
}

// 业务侧用法（大文件上传）
const fileStream = (await navigator.storage.getDirectory())
  .getFileHandle("big.bin")
  .then(h => h.getFile())
  .then(f => f.stream());

await http.request({
  method: "POST",
  path: "/api/upload/stream",
  body: fileStream,
  headers: { "Content-Type": "application/octet-stream" }
  // 注意：stream body 不能设 Content-Length（chunked transfer）
  // 超时语义：连接建立后的流式传输不受 timeoutMs 管（只管首字节超时）
});
```

**buildBodyAndHeaders 改动**（[http-client.ts:154-180](../../packages/core/src/http-client.ts)）：

```typescript
if (
  typeof body === "string" ||
  body instanceof FormData ||
  body instanceof Blob ||
  body instanceof URLSearchParams ||
  body instanceof ArrayBuffer ||
  // ← 新增
  (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
) {
  return { body: body as BodyInit, headers: h };
}
```

**Node 兼容**：Node 18+ 的 `stream.Readable` 不是 `ReadableStream`，需要 `Readable.toWeb()` 转换。**不在库内做**，业务侧自己转（避免 Node stream 依赖进库）。

### 3.4 B25 WebSocket — **不进库**

**决策**：库定位 HTTP，不扩展 WebSocket。

**理由**：

1. WebSocket 是独立协议（RFC 6455），不是 HTTP 请求/响应模型
2. fetch 不能 upgrade 到 WebSocket（需要独立的 `WebSocket` API）
3. 鉴权模型不同（WS 通常在 URL query 或子协议里带 token，不是 Authorization header）
4. 重连/心跳/订阅状态机是 WS 客户端的职责，与 HTTP middleware 链不可复用
5. 浏览器 + Node 18+ 都有原生 `WebSocket`，业务侧直接用

**业务侧推荐模式**（demo-app 示例）：

```typescript
// 业务侧自己写 ws client，复用 AuthService 拿 token
import { AuthService } from "@xapiforge/core";

class WsClient {
  private ws: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly authService: AuthService
  ) {}

  async connect(): Promise<void> {
    const token = await this.authService.getToken();
    // token 在 query 或子协议里传（后端约定）
    this.ws = new WebSocket(`${this.url}?token=${encodeURIComponent(token)}`);

    this.ws.onclose = async e => {
      if (e.code === 4001) {
        // 401 等价：token 过期 → refresh → 重连
        await this.authService.refreshIfNeeded();
        await this.connect();
      }
    };
  }
}
```

**SCENARIOS.md B25 状态**：从「v0.3 计划」改为「不扩展（库定位 HTTP）」。

---

## 4. 架构影响

### 4.1 HttpClient 改动（[http-client.ts](../../packages/core/src/http-client.ts)）

```typescript
// 改动点 1：responseType 新增 "stream"
const responseType = opts.responseType ?? "text";
let bodyText = "";
let blob: Blob | undefined;
let stream: ReadableStream<Uint8Array> | undefined;

if (responseType === "blob") {
  blob = await res.blob();
} else if (responseType === "stream") {
  // ← 新增：不读 body，直接返 stream
  if (!res.body) throw new NetworkError("stream response has no body");
  stream = res.body;
} else {
  bodyText = await res.text();
}

// 改动点 2：stream 时超时语义不同
// 当前：timeoutMs 管整个请求（包括 body 读取）
// stream：timeoutMs 只管首字节（res 返回），res.body 的流式读取不被超时管
if (responseType === "stream" && timeoutMs > 0) {
  // 首字节超时：fetch 返回 res 即取消 timer
  // 流式读取超时由业务侧用 opts.signal 自己管
  clearTimeout(timeoutTimer!); // ← res 拿到就清，不等 body
}
```

### 4.2 buildBodyAndHeaders 改动

见 3.3，加 `ReadableStream` 分支。

### 4.3 middleware 链影响

| middleware                   | 对 stream 响应的行为               | 改动                 |
| ---------------------------- | ---------------------------------- | -------------------- |
| `auth-mw` onRequest          | 正常注入 token                     | 无                   |
| `auth-mw` onResponse 401     | 正常 refresh + retry（不看 body）  | 无                   |
| `retry-mw` onResponse 429    | 正常 RetryableError（不看 body）   | 无                   |
| `http-error-mw` 最终状态校验 | 正常 ApiError（保留解析后的 body） | 无                   |
| **业务 envelope middleware** | **跳过**（stream 不是 JSON）       | **业务侧自己加判断** |

**业务 envelope middleware 适配**（[abp-unwrap-mw.ts](../../examples/demo-app/src/middleware/abp-unwrap-mw.ts)）：

```typescript
async onResponse({ response }) {
  const ct = response.headers.get("Content-Type") ?? "";
  // ← 新增：stream / SSE 响应不解包
  if (ct.includes("event-stream") || ct.includes("x-ndjson")) {
    return response;
  }
  // 原有 JSON 逻辑...
}
```

### 4.4 createNet 影响

openapi-fetch 的 middleware `onResponse` 可以拿到 `response.body`（ReadableStream）。**关键问题**：如果业务 middleware 读 body，stream 会被消费。

**v0.2 现状**：abp-unwrap-mw 用 `response.clone().text()` 读 body，不消费原 body。
**stream 场景**：`response.clone()` 对 stream 不可靠（clone 后两个 stream 独立消费）。

**解法**：stream 场景下，业务 middleware 必须**不读 body**，直接放行。库提供 `isStreamResponse(response)` helper 给业务侧判断。

### 4.5 错误处理

| 场景                     | v0.2 行为               | stream 行为                                              |
| ------------------------ | ----------------------- | -------------------------------------------------------- |
| fetch reject（DNS/CORS） | NetworkError            | 同                                                       |
| 连接超时                 | NetworkError            | 同                                                       |
| 流式读取中途断开         | N/A                     | **新增**：stream 抛 `NetworkError("stream interrupted")` |
| 用户 abort               | NetworkError            | 同（opts.signal 仍生效）                                 |
| HTTP 4xx/5xx             | 不抛错（middleware 管） | 同（但 stream body 可能没意义）                          |

---

## 5. 测试计划

### 5.1 mock-server 端点扩展

| 端点                           | 场景            | 响应                                                                  |
| ------------------------------ | --------------- | --------------------------------------------------------------------- |
| `GET /api/test/ndjson`         | B13 NDJSON      | `Content-Type: application/x-ndjson` + 逐行写 `{"i":0}\n{"i":1}\n...` |
| `GET /api/test/sse`            | B14 SSE         | `Content-Type: text/event-stream` + 写 `data: {"ts":1}\n\n` 3 次      |
| `POST /api/test/stream-upload` | B17 stream body | 读请求 body 流，返回接收字节数                                        |
| `GET /api/test/sse-with-401`   | A16 + B14 混合  | 首次 401，refresh 后 200 + SSE 流                                     |

### 5.2 test-scenarios.ts 新增 Section 8

```typescript
async function testStreamScenarios(): Promise<void> {
  console.log("\n━━━ Section 8: Stream（B13/B14/B17）━━━");

  // B13 NDJSON
  {
    const res = await http.request({
      method: "GET",
      path: "/api/test/ndjson",
      responseType: "stream"
    });
    ok(res.stream !== undefined, "B13 stream 返回");
    const lines: unknown[] = [];
    for await (const item of readNdjson<{ i: number }>(res.stream!)) {
      lines.push(item);
    }
    eq(lines.length, 5, "B13 5 行 NDJSON");
    eq((lines[0] as { i: number }).i, 0, "B13 第一行 i=0");
  }

  // B14 SSE
  {
    const res = await http.request({
      method: "GET",
      path: "/api/test/sse",
      responseType: "stream",
      headers: { Accept: "text/event-stream" }
    });
    const events: SseEvent[] = [];
    for await (const ev of createSseClient(res.stream!)) {
      events.push(ev);
    }
    eq(events.length, 3, "B14 3 个 SSE 事件");
    ok(events[0].data.includes('"ts":1'), "B14 第一个事件 data");
  }

  // B17 stream body
  {
    const uploadStream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("hello".repeat(100)));
        ctrl.close();
      }
    });
    const res = await http.request({
      method: "POST",
      path: "/api/test/stream-upload",
      body: uploadStream,
      responseType: "text"
    });
    eq(res.status, 200, "B17 上传 200");
    ok(res.bodyText.includes('"bytes":600'), "B17 接收 600 字节");
  }

  // A16 + B14 混合：SSE 端点首次 401 → refresh → 200 stream
  {
    const store = makeMemoryStore("expired");
    const { refresher } = makeHttpRefresher({});
    const auth = new AuthService({ tokenStore: store, authRefresher: refresher });
    const api = createNet({ baseURL: BASE, authService: auth, maxRetries: 1 });
    const result = await (api as any).GET("/api/test/sse-with-401");
    ok(result.response.status === 200, "A16+B14 SSE 401 → refresh → 200");
  }
}
```

### 5.3 L2 手动验证

| #   | 场景                | 操作                                                                | 期望                  |
| --- | ------------------- | ------------------------------------------------------------------- | --------------------- |
| 10  | B13 NDJSON 流式日志 | console: `await (await fetch("/api/test/ndjson")).body.pipeTo(...)` | 逐行打印              |
| 11  | B14 SSE 实时通知    | demo-app 加 SSE demo 页面，订阅 `/api/test/sse`                     | 3 条事件实时显示      |
| 12  | B17 大文件上传      | console: 用 `file.stream()` 上传                                    | 上传进度 + 字节数确认 |

### 5.4 B25 验证

**不验证**（库不支持）。在 SCENARIOS.md 标注「业务侧用原生 WebSocket」+ 给推荐模式代码片段。

---

## 6. 向后兼容性

| 改动                                            | 兼容性            | 理由                                                |
| ----------------------------------------------- | ----------------- | --------------------------------------------------- |
| `ResponseType` 加 `"stream"`                    | ✅ 兼容           | 新增枚举值，旧代码不传则用默认 "text"               |
| `HttpResponse` 加 `stream?`                     | ✅ 兼容           | 可选字段                                            |
| `HttpRequestOptions.body` 接受 `ReadableStream` | ✅ 兼容           | 联合类型扩展                                        |
| `readNdjson` / `createSseClient` 导出           | ✅ 兼容           | 新增导出，不破坏现有                                |
| 业务 envelope middleware 需要适配 stream        | ⚠️ **业务侧改动** | 业务 middleware 要加 `Content-Type` 判断跳过 stream |

**结论**：v0.3 是**向后兼容的增量**，不需要 v0.2 → v0.3 的破坏性迁移。业务侧不主动用 stream API 则无感知。

---

## 7. 实装工作量预估

| 任务                                         | 文件                                                     | 复杂度             |
| -------------------------------------------- | -------------------------------------------------------- | ------------------ |
| HttpClient 加 `responseType: "stream"`       | [http-client.ts](../../packages/core/src/http-client.ts) | 低                 |
| HttpClient 加 `body: ReadableStream`         | 同上                                                     | 低                 |
| `readNdjson` helper                          | 新文件 `stream-helpers.ts`                               | 中                 |
| `createSseClient` helper                     | 同上                                                     | 中（SSE 协议解析） |
| mock-server 加 ndjson/sse/stream-upload 端点 | [mock-server.ts](../../scripts/mock-server.ts)           | 中                 |
| test-scenarios Section 8                     | [test/scenarios.ts](../../scripts/test/scenarios.ts)     | 中                 |
| demo-app 加 SSE demo 页面                    | `examples/demo-app/src/views/SseDemo.vue`                | 低                 |
| SCENARIOS / BEHAVIOR-CONTRACT 更新           | docs                                                     | 低                 |
| **B25 不实装**，只更新文档                   | SCENARIOS.md                                             | 低                 |

---

## 8. 未决问题（评审时定）

1. **SSE 重连**：v0.3 不做 `createResilientSseClient`，还是直接做？
   - 倾向：v0.3 不做，等真实业务场景驱动（YAGNI）
2. **NDJSON 解析错误**：某行 JSON.parse 失败，抛错还是跳过？
   - 倾向：抛错（`SyntaxError`），业务侧自己 try/catch 跳过
3. **stream body + 超时**：timeoutMs 只管首字节，还是管整个流？
   - 倾向：只管首字节（建立连接超时），流式读取超时由业务侧 `opts.signal` 管
4. **`isStreamResponse` helper**：导出还是业务侧自己判 `Content-Type`？
   - 倾向：不导出（业务侧自己判，避免库假设 stream 的 Content-Type）

---

## 9. 评审通过后的实装顺序

1. HttpClient 加 stream 支持（最小改动，先让流能进出）
2. `readNdjson` + `createSseClient` helper
3. mock-server 端点 + test-scenarios Section 8
4. demo-app SSE demo 页面
5. 业务 envelope middleware 适配（abp-unwrap-mw 加 CT 判断）
6. 更新 SCENARIOS / BEHAVIOR-CONTRACT / VALIDATION
7. 提交 + 跑 `pnpm test:scenarios` 验 97/97 → 100/100（B25 标「不扩展」）

---

## 10. 参考

- [scenarios.md](./scenarios.md) B13/B14/B17/B25 场景定义
- [behavior-contract.md](./behavior-contract.md) Layer 2 行为契约
- [validation.md](./validation.md) 验证指南
- [http-client.ts](../../packages/core/src/http-client.ts) v0.2 当前实现
- [whatwg/fetch streaming](https://fetch.spec.whatwg.org/#streaming) fetch body stream 规范
- [HTML SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html) SSE 协议规范
