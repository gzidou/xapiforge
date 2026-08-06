/**
 * v0.2 系统场景验证脚本
 *
 * 直接 import @xapiforge/core，不依赖浏览器，覆盖库核心逻辑。
 * 对应 SCENARIOS.md 97 个场景中库代码必须保证正确的部分。
 *
 * 运行（推荐）：pnpm test:scenarios
 *   → 自动起停 mock-server，跑完即退
 *
 * 手动运行：pnpm tsx scripts/test-scenarios.ts
 *   → 若 mock-server 未启动，会自动拉起子进程；跑完自动 kill
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  HttpClient,
  AuthService,
  ApiError,
  AuthError,
  NetworkError,
  RetryableError,
  createRetryMiddleware,
  createHttpErrorMiddleware,
  createAuthMiddleware,
  createNet,
} from "@xapiforge/core";
import type { TokenStore, AuthRefresher, Middleware } from "@xapiforge/core";

const BASE = "http://localhost:8787";
const MOCK_PID_FILE = "/tmp/demo-mock.pid";

// ─── 简易断言工具 ───
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.log(`  ❌ FAIL: ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  ok(equal, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function expectThrows<T extends Error>(
  fn: () => Promise<unknown>,
  ErrorClass: new (...args: never[]) => T,
  msg: string,
  msgContains?: string,
): Promise<T | undefined> {
  try {
    await fn();
    ok(false, `${msg} — expected throw ${ErrorClass.name}`);
    return undefined;
  } catch (e) {
    if (!(e instanceof ErrorClass)) {
      ok(false, `${msg} — expected ${ErrorClass.name}, got ${(e as Error).constructor.name}`);
      return undefined;
    }
    if (msgContains && !e.message.includes(msgContains)) {
      ok(false, `${msg} — message "${e.message}" does not contain "${msgContains}"`);
    }
    passed++;
    return e;
  }
}

// ─── 内存 TokenStore（测试用）───
function makeMemoryStore(initial: string | null = null): TokenStore & {
  _value: string | null;
} {
  const state = { value: initial };
  return {
    get: () => state.value,
    set: (t) => {
      state.value = t;
    },
    clear: () => {
      state.value = null;
    },
    get _value() {
      return state.value;
    },
    set _value(value: string | null) {
      state.value = value;
    },
  };
}

// ─── 计数 refresh 调用次数的 AuthRefresher ───
// 返回 state 对象，调用方读 state.calls（避免 getter 解构失效）
function makeRefresher(opts: { token?: string; fail?: boolean; delayMs?: number }): {
  refresher: AuthRefresher;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const refresher: AuthRefresher = {
    refresh: async () => {
      state.calls++;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error("refresh failed (mock)");
      return opts.token ?? "refreshed-token";
    },
  };
  return { refresher, state };
}

// ═══════════════════════════════════════════════════════════════════════
// Section 1: HttpClient（HTTP 层）—— A17/A18/A19/A21/A22/B4/B10/B11/B23
// ═══════════════════════════════════════════════════════════════════════

async function testHttpClient(): Promise<void> {
  console.log("\n━━━ Section 1: HttpClient（HTTP 层）━━━");
  const http = new HttpClient({ baseURL: BASE });

  // ── A18: 5xx + HTML → HttpClient 不抛错（HTTP 错误由 middleware 决定）──
  {
    const res = await http.request({ method: "GET", path: "/api/test/500-html" });
    eq(res.status, 500, "A18 5xx+HTML status");
    ok(res.bodyText.includes("<html>"), "A18 5xx HTML body preserved");
    ok(!res.ok, "A18 5xx not ok");
  }

  // ── A19: 5xx + JSON envelope ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/500-json" });
    eq(res.status, 500, "A19 5xx+JSON status");
    const body = JSON.parse(res.bodyText);
    eq(body.code, 500, "A19 5xx envelope code");
  }

  // ── A20: 503 + JSON ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/503" });
    eq(res.status, 503, "A20 503 status");
    const body = JSON.parse(res.bodyText);
    eq(body.message, "Service Unavailable", "A20 503 body");
  }

  // ── A21: 204 No Content ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/204" });
    eq(res.status, 204, "A21 204 status");
    eq(res.bodyText, "", "A21 204 empty body");
  }

  // ── A22: 200 + 空 body ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/200-empty" });
    eq(res.status, 200, "A22 200 empty status");
    eq(res.bodyText, "", "A22 200 empty body");
  }

  // ── B4: 超时 → NetworkError ──
  await expectThrows(
    () => http.request({ method: "GET", path: "/api/test/slow?ms=2000", timeoutMs: 500 }),
    NetworkError,
    "B4 超时 → NetworkError",
    "timeout",
  );

  // ── B10: Content-Type 与 body 不匹配 ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/200-non-json-text" });
    eq(res.status, 200, "B10 status");
    ok(res.bodyText.includes("this is not json"), "B10 body text preserved");
  }

  // ── B11: 响应含 BOM（JSON.parse 容忍）──
  {
    const res = await http.request({ method: "GET", path: "/api/test/bom" });
    eq(res.status, 200, "B11 BOM status");
    const body = JSON.parse(res.bodyText);
    eq(body.code, 0, "B11 BOM JSON parse ok");
  }

  // ── B23: 3xx 重定向 → fetch 默认 follow ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/redirect-to-users" });
    // follow 后到 /api/identity/users（401，因为没 token）
    eq(res.status, 401, "B23 redirect followed (final 401)");
  }

  // ── B16: URLSearchParams body ──
  {
    const params = new URLSearchParams();
    params.set("grant_type", "password");
    params.set("username", "admin");
    params.set("password", "p");
    const res = await http.request({ method: "POST", path: "/connect/token", body: params });
    eq(res.status, 200, "B16 URLSearchParams body status");
    const body = JSON.parse(res.bodyText);
    ok(!!body.access_token, "B16 URLSearchParams body got token");
  }

  // ── F7: AbortController → NetworkError ──
  {
    const ac = new AbortController();
    const p = http.request({
      method: "GET",
      path: "/api/test/slow?ms=2000",
      signal: ac.signal,
      timeoutMs: 0,
    });
    setTimeout(() => ac.abort(), 100);
    await expectThrows(() => p, NetworkError, "F7 user abort → NetworkError", "aborted");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 2: middleware 单元测试 —— retry-mw / http-error-mw / auth-mw
// ═══════════════════════════════════════════════════════════════════════

async function testMiddlewares(): Promise<void> {
  console.log("\n━━━ Section 2: middleware 单元测试 ━━━");

  // ── retry-mw: 429 + Retry-After → RetryableError ──
  {
    const mw = createRetryMiddleware();
    const headers = new Headers({ "Retry-After": "2" });
    const res = new Response("{}", { status: 429, headers });
    await expectThrows(
      () => Promise.resolve(mw.onResponse?.({ request: new Request("http://x"), response: res })),
      RetryableError,
      "retry-mw 429 → RetryableError",
    );
  }

  // ── retry-mw: 429 无 Retry-After → RetryableError(defaultRetryMs) ──
  {
    const mw = createRetryMiddleware({ defaultRetryMs: 500 });
    const res = new Response("{}", { status: 429 });
    try {
      await mw.onResponse?.({ request: new Request("http://x"), response: res });
      ok(false, "retry-mw 429 no-retry-after should throw");
    } catch (e) {
      ok(e instanceof RetryableError, "retry-mw 429 no-retry-after → RetryableError");
      ok((e as RetryableError).retryAfterMs === 500, "retry-mw default retryMs=500");
    }
  }

  // ── retry-mw: 非 429 不抛 ──
  {
    const mw = createRetryMiddleware();
    const res = new Response("{}", { status: 200 });
    const result = await mw.onResponse?.({
      request: new Request("http://x"),
      response: res,
    });
    ok(result === res, "retry-mw 200 passthrough");
  }

  // ── http-error-mw: 默认所有非 2xx → ApiError，并保留解析 body/Response ──
  {
    const mw = createHttpErrorMiddleware();
    for (const status of [500, 502, 503, 504]) {
      const res = new Response("err", { status });
      const error = await expectThrows(
        () => Promise.resolve(mw.onResponse?.({ request: new Request("http://x"), response: res })),
        ApiError,
        `http-error-mw ${status} → ApiError`,
      );
      ok(error?.kind === "http", `http-error-mw ${status} kind=http`);
      ok(error?.status === status, `http-error-mw ${status} status preserved`);
      ok(error?.body === "err", `http-error-mw ${status} body preserved`);
    }

    const htmlResponse = new Response("<html><body>proxy failed</body></html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
    const htmlError = await expectThrows(
      () =>
        Promise.resolve(
          mw.onResponse?.({ request: new Request("http://x"), response: htmlResponse }),
        ),
      ApiError,
      "http-error-mw HTML error page → ApiError",
    );
    ok(htmlError?.message === "请求失败（HTTP 502）", "HTML body is not exposed as UI message");
    ok(typeof htmlError?.body === "string", "HTML diagnostic body preserved");

    const fallback = new ApiError({ kind: "unexpected", message: "   " });
    ok(fallback.message === "请求失败", "ApiError guarantees a non-empty message");
  }

  // ── http-error-mw: 单次 validateStatus 可以接受 404 ──
  {
    const mw = createHttpErrorMiddleware();
    const request = new Request("http://x") as Request & {
      validateStatus?: (response: Response) => boolean;
    };
    request.validateStatus = (response) => response.ok || response.status === 404;
    const res = new Response('{"message":"not found"}', { status: 404 });
    const result = await mw.onResponse?.({ request, response: res });
    ok(result === res, "http-error-mw request validateStatus accepts 404");
  }

  // ── auth-mw: onRequest 注入 token ──
  {
    const store = makeMemoryStore("test-token-123");
    const { refresher } = makeRefresher({ token: "new-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const mw = createAuthMiddleware(auth);
    const req = new Request("http://x");
    const result = await mw.onRequest?.({ request: req });
    ok(
      result!.headers.get("Authorization") === "Bearer test-token-123",
      "auth-mw onRequest inject token",
    );
  }

  // ── auth-mw: onRequest 无 token 不设 header ──
  {
    const store = makeMemoryStore(null);
    const { refresher } = makeRefresher({ token: "new-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const mw = createAuthMiddleware(auth);
    const req = new Request("http://x");
    const result = await mw.onRequest?.({ request: req });
    ok(result!.headers.get("Authorization") === null, "auth-mw onRequest no token → no header");
  }

  // ── auth-mw: onResponse 401 → refresh 成功 → RetryableError ──
  {
    const store = makeMemoryStore("expired");
    const { refresher, state } = makeRefresher({ token: "refreshed-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const mw = createAuthMiddleware(auth);
    const res = new Response("{}", { status: 401 });
    await expectThrows(
      () => Promise.resolve(mw.onResponse?.({ request: new Request("http://x"), response: res })),
      RetryableError,
      "auth-mw 401 → refresh success → RetryableError",
    );
    ok(state.calls === 1, `auth-mw 401 triggered 1 refresh (got ${state.calls})`);
    ok(store._value === "refreshed-token", "auth-mw 401 refreshed token stored");
  }

  // ── auth-mw: onResponse 非 401 不处理 ──
  {
    const store = makeMemoryStore("ok");
    const { refresher } = makeRefresher({ token: "x" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const mw = createAuthMiddleware(auth);
    const res = new Response("{}", { status: 200 });
    const result = await mw.onResponse?.({
      request: new Request("http://x"),
      response: res,
    });
    ok(result === res, "auth-mw 200 passthrough");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 3: AuthService 单元测试 —— D2/D3/D4/D7/单飞/窗口保护/E1-E3
// ═══════════════════════════════════════════════════════════════════════

async function testAuthService(): Promise<void> {
  console.log("\n━━━ Section 3: AuthService 单元测试 ━━━");

  // ── E1: 工厂模式 — 两个 AuthService 独立 ──
  {
    const store1 = makeMemoryStore("t1");
    const store2 = makeMemoryStore("t2");
    const auth1 = new AuthService({
      tokenStore: store1,
      authRefresher: { refresh: async () => "r1" },
      onAuthFailed: () => {},
    });
    const auth2 = new AuthService({
      tokenStore: store2,
      authRefresher: { refresh: async () => "r2" },
      onAuthFailed: () => {},
    });
    ok((await auth1.getToken()) === "t1", "E1 auth1 token");
    ok((await auth2.getToken()) === "t2", "E1 auth2 token");
    await auth1.refreshIfNeeded();
    ok(store1._value === "r1", "E1 auth1 refreshed");
    ok(store2._value === "t2", "E1 auth2 not affected");
  }

  // ── 单飞：并发 10 个 refresh 只触发 1 次 ──
  {
    const store = makeMemoryStore(null);
    const { refresher, state } = makeRefresher({ token: "new", delayMs: 100 });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const promises = Array.from({ length: 10 }, () => auth.refreshIfNeeded());
    const tokens = await Promise.all(promises);
    ok(state.calls === 1, `单飞: 10 concurrent → 1 refresh call (got ${state.calls})`);
    ok(
      tokens.every((t) => t === "new"),
      "单飞: all get same token",
    );
  }

  // ── 窗口保护：30s 内重复 refresh 直接返回上次 token ──
  {
    const store = makeMemoryStore(null);
    const { refresher, state } = makeRefresher({ token: "first" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
      refreshWindowMs: 30_000,
    });
    await auth.refreshIfNeeded();
    ok(state.calls === 1, "窗口: first refresh called once");
    const t = await auth.refreshIfNeeded();
    ok(state.calls === 1, "窗口: second refreshIfNeeded within window → no call");
    ok(t === "first", "窗口: returned last token");
  }

  // ── 窗口保护：tokenStore 被外部清空后不得用 lastToken 复活会话 ──
  {
    const store = makeMemoryStore("expired");
    const { refresher } = makeRefresher({ token: "refreshed" });
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
      refreshWindowMs: 30_000,
    });

    await auth.refreshIfNeeded();
    ok(store._value === "refreshed", "窗口清理: refresh 后 token 已写入 store");

    // 模拟业务代码、另一个标签页或开发者工具直接清除持久化 token。
    store._value = null;
    await expectThrows(
      () => auth.refreshIfNeeded(),
      AuthError,
      "窗口清理: missing token → AuthError",
    );

    ok(store._value === null, "窗口清理: missing token 未被 lastToken 写回");
    ok(auth.getLastRefreshedToken() === null, "窗口清理: lastToken 已清除");
    ok(!auth.isWithinRefreshWindow(), "窗口清理: refresh window 已重置");
    ok(onAuthFailedCalls === 1, "窗口清理: onAuthFailed called once");
  }

  // ── D2: refresh 失败 → AuthError + onAuthFailed ──
  {
    const store = makeMemoryStore("expired");
    const { refresher } = makeRefresher({ fail: true });
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
    });
    await expectThrows(() => auth.refreshIfNeeded(), AuthError, "D2 refresh fail → AuthError");
    ok(onAuthFailedCalls === 1, `D2 onAuthFailed called once (got ${onAuthFailedCalls})`);
  }

  // ── D7: refresh 超时 → AuthError ──
  {
    const store = makeMemoryStore("expired");
    const { refresher } = makeRefresher({ delayMs: 3000 });
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
      refreshTimeoutMs: 500,
    });
    await expectThrows(() => auth.refreshIfNeeded(), AuthError, "D7 refresh timeout → AuthError");
    ok(onAuthFailedCalls === 1, "D7 onAuthFailed called on timeout");
  }

  // ── 单飞 + 失败：并发 5 个 refresh 失败 → onAuthFailed 只调 1 次 ──
  {
    const store = makeMemoryStore(null);
    const { refresher } = makeRefresher({ fail: true, delayMs: 100 });
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
    });
    const promises = Array.from({ length: 5 }, () => auth.refreshIfNeeded().catch(() => null));
    await Promise.all(promises);
    ok(onAuthFailedCalls === 1, `单飞+失败: onAuthFailed called once (got ${onAuthFailedCalls})`);
  }

  // ── clearToken: 清除 token + 重置窗口 ──
  {
    const store = makeMemoryStore("x");
    const { refresher, state } = makeRefresher({ token: "y" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    await auth.refreshIfNeeded();
    ok(state.calls === 1, "clearToken: before clear, refresh called");
    await auth.clearToken();
    ok(store._value === null, "clearToken: store cleared");
    await auth.refreshIfNeeded();
    ok(state.calls === 2, "clearToken: after clear, refresh called again (window reset)");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 4: 业务 envelope 变体 —— C1-C10 + L4.8
// ═══════════════════════════════════════════════════════════════════════

async function testEnvelopeVariants(): Promise<void> {
  console.log("\n━━━ Section 4: 业务 envelope 变体（C1-C10）━━━");
  const http = new HttpClient({ baseURL: BASE });

  // ── C1: data 字段是 string ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c1-data-string" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { code: number; data: unknown }) => (p.code === 0 ? p.data : p);
    eq(data(payload as never), "https://file.url", "C1 unwrap string data");
  }

  // ── C2: data 字段是 array ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c2-data-array" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { code: number; data: unknown }) => (p.code === 0 ? p.data : p);
    ok(Array.isArray(data(payload as never)), "C2 unwrap array data");
  }

  // ── C3: data 字段是分页 ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c3-data-paged" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { code: number; data: { items: unknown[]; totalCount: number } }) =>
      p.code === 0 ? p.data : p;
    const result = data(payload as never);
    eq(result.totalCount, 2, "C3 paged totalCount");
    ok(Array.isArray(result.items), "C3 paged items array");
  }

  // ── C4: data 字段是 null ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c4-data-null" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { code: number; data: unknown }) => (p.code === 0 ? p.data : p);
    eq(data(payload as never), null, "C4 unwrap null data");
  }

  // ── C5: msg 字段缺失 ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c5-no-msg" });
    const payload = JSON.parse(res.bodyText);
    ok(!("message" in payload), "C5 no message field");
    ok(payload.code === 0, "C5 code=0");
  }

  // ── C6: code 字段是 string ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c6-code-string" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { code: string | number; data: unknown }) =>
      String(p.code) === "0" ? p.data : p;
    eq(data(payload as never), { id: 1, name: "x" }, "C6 code as string");
  }

  // ── C7: code 字段是 boolean (success) ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c7-code-bool" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { success: boolean; data: unknown }) => (p.success ? p.data : p);
    eq(data(payload as never), { id: 1, name: "x" }, "C7 success bool");
  }

  // ── C8: 同时含 code 和 status ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c8-both-code-status" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { code: number; status: string; data: unknown }) =>
      p.code === 0 ? p.data : p;
    eq(data(payload as never), { id: 1, name: "x" }, "C8 both code+status");
  }

  // ── C9: envelope 是数组 ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c9-array-root" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: unknown) => (Array.isArray(p) ? p : []);
    eq(data(payload), [{ id: 1 }, { id: 2 }], "C9 array root");
  }

  // ── C10: envelope 嵌套 2 层 ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/c10-nested" });
    const payload = JSON.parse(res.bodyText);
    const data = (p: { result: { inner: { code: number; data: unknown } } }) =>
      p.result.inner.code === 0 ? p.result.inner.data : p;
    eq(data(payload as never), { id: 1, name: "x" }, "C10 nested envelope");
  }

  // ── L4.8: 业务 code 非 0 非 auth code → 业务错误 ──
  {
    const res = await http.request({ method: "GET", path: "/api/test/biz-code-500" });
    const payload = JSON.parse(res.bodyText);
    ok(payload.code === 500, "L4.8 biz code=500");
    ok(!!payload.message, "L4.8 biz error message");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 5: middleware 链 + createNet retry loop
// ═══════════════════════════════════════════════════════════════════════

async function testMiddlewareChainAndRetry(): Promise<void> {
  console.log("\n━━━ Section 5: middleware 链 + retry loop ━━━");

  // ── retry-mw + createNet: 429 → 重试 ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    let requestCount = 0;
    const counterMw: Middleware = {
      onRequest: async ({ request }) => {
        requestCount++;
        return request;
      },
    };

    // 429 端点始终返 429（重试 2 次仍 429 → 最终转换为 ApiError）
    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [counterMw, createRetryMiddleware({ defaultRetryMs: 10 })],
      maxRetries: 2,
    });

    try {
      await (
        api as unknown as {
          GET: (p: string, o?: unknown) => Promise<{ response: Response }>;
        }
      ).GET("/api/test/429-no-retry-after");
      ok(false, "429 retry exhausted should throw");
    } catch (e) {
      ok(e instanceof ApiError, "429 retry exhausted → ApiError");
      ok(e instanceof ApiError && e.kind === "rate-limit", "429 exhausted kind=rate-limit");
      ok(e instanceof ApiError && e.status === 429, "429 exhausted status preserved");
      ok(
        e instanceof ApiError && typeof e.body === "object" && e.body !== null,
        "429 exhausted parsed body preserved",
      );
    }
    ok(requestCount === 3, `429 retry: 3 total requests (got ${requestCount})`);
  }

  // ── HTTP error 自动注入：5xx → ApiError（无需手动配置）──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      // 不手动注入 httpError —— 验证 createNet 自动注入
      middleware: [],
      maxRetries: 1,
    });

    const error = await expectThrows(
      () =>
        (
          api as unknown as {
            GET: (p: string, o?: unknown) => Promise<unknown>;
          }
        ).GET("/api/test/500-json"),
      ApiError,
      "createNet 自动注入 HTTP error：5xx → ApiError",
    );
    ok(error?.kind === "http", "createNet 5xx kind=http");
    ok(error?.status === 500, "createNet 5xx status preserved");
    ok(
      typeof error?.body === "object" && error.body !== null,
      "createNet 5xx parsed body preserved",
    );
  }

  // ── data-or-throw：普通 404 统一抛 ApiError，message/body/response 可直接使用 ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
    });

    const error = await expectThrows(
      () =>
        (
          api as unknown as {
            GET: (p: string, o?: unknown) => Promise<unknown>;
          }
        ).GET("/api/test/404-not-found"),
      ApiError,
      "default 404 → ApiError",
    );
    ok(error?.kind === "http", "default 404 kind=http");
    ok(error?.status === 404, "default 404 status preserved");
    ok(error?.message === "Resource not found", "default 404 common message extracted");
    ok(error?.response?.status === 404, "default 404 Response preserved");
    ok(typeof error?.body === "object" && error.body !== null, "default 404 parsed body preserved");
  }

  // ── 单次 validateStatus：显式接受 404 → resolve { data, response } ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const api = createNet<Record<string, never>>({ baseURL: BASE, authService: auth });
    const result = await (
      api as unknown as {
        GET: (
          p: string,
          o: { validateStatus: (response: Response) => boolean },
        ) => Promise<{ data: unknown; response: Response }>;
      }
    ).GET("/api/test/404-not-found", {
      validateStatus: (response) => response.ok || response.status === 404,
    });

    ok(result.response.status === 404, "request validateStatus preserves 404 response");
    ok(result.response.headers.has("Content-Type"), "accepted 404 response headers readable");
    ok(
      typeof result.data === "object" && result.data !== null,
      "accepted 404 error body moved into data",
    );
  }

  // ── client 级 validateStatus：同样支持全局状态策略 ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      validateStatus: (response) => response.ok || response.status === 404,
    });
    const result = await (
      api as unknown as {
        GET: (p: string) => Promise<{ data: unknown; response: Response }>;
      }
    ).GET("/api/test/404-not-found");
    ok(result.response.status === 404, "global validateStatus accepts 404");
  }

  // ── middleware 运行时错误：对外归一化 unexpected，原错误保留在 cause ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const brokenMiddleware: Middleware = {
      onResponse() {
        throw new TypeError("middleware bug");
      },
    };
    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [brokenMiddleware],
    });
    const error = await expectThrows(
      () =>
        (
          api as unknown as {
            GET: (p: string) => Promise<unknown>;
          }
        ).GET("/api/test/204"),
      ApiError,
      "middleware runtime error → ApiError",
    );
    ok(error?.kind === "unexpected", "middleware runtime error kind=unexpected");
    ok(error?.cause instanceof TypeError, "middleware runtime error cause preserved");
  }

  // ── 2xx JSON 解析失败：与未知代码错误分开归类为 parse ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });
    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      fetch: async () =>
        new Response("{", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const error = await expectThrows(
      () =>
        (
          api as unknown as {
            GET: (p: string) => Promise<unknown>;
          }
        ).GET("/api/test/invalid-json"),
      ApiError,
      "invalid success JSON → ApiError",
    );
    ok(error?.kind === "parse", "invalid success JSON kind=parse");
    ok(error?.cause instanceof SyntaxError, "invalid success JSON cause preserved");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 6: A14 业务 200 鉴权码（库层验证）
// ═══════════════════════════════════════════════════════════════════════

async function testA14AtLibLevel(): Promise<void> {
  console.log("\n━━━ Section 6: A14 业务 200 鉴权码（库层）━━━");

  // 模拟 ABP envelope middleware（简化版）
  const AUTH_CODES = new Set([40001, 40002, 41001]);
  const abpUnwrapMw: Middleware = {
    async onResponse({ response }) {
      const ct = response.headers.get("Content-Type") ?? "";
      if (!ct.includes("application/json")) return response;
      const text = await response.clone().text();
      if (!text) return response;
      try {
        const env = JSON.parse(text) as { code: number; data: unknown; message?: string };
        if (typeof env.code !== "number") return response;
        if (env.code === 0) {
          return new Response(JSON.stringify(env.data), {
            status: response.status,
            headers: response.headers,
          });
        }
        if (AUTH_CODES.has(env.code)) {
          throw new RetryableError(`abp auth code ${env.code}`, { needsRefresh: true });
        }
        throw new Error(`abp biz error ${env.code}: ${env.message ?? ""}`);
      } catch (e) {
        if (e instanceof RetryableError) throw e;
        return response;
      }
    },
  };

  // 初始 token=biz-code-expired → 200+code=40001 → RetryableError(needsRefresh)
  // → createNet catch → refresh → token=refreshed-token → 重发 → 200+code=0 → data
  const store = makeMemoryStore("biz-code-expired");
  const { refresher, state } = makeRefresher({ token: "refreshed-token" });
  let onAuthFailedCalls = 0;
  const auth = new AuthService({
    tokenStore: store,
    authRefresher: refresher,
    onAuthFailed: () => onAuthFailedCalls++,
  });

  const api = createNet<Record<string, never>>({
    baseURL: BASE,
    authService: auth,
    middleware: [abpUnwrapMw],
    maxRetries: 1,
  });

  const result = await (
    api as unknown as {
      GET: (p: string, o?: unknown) => Promise<{ data: unknown; response: Response }>;
    }
  ).GET("/api/auth/biz-code-expired");

  ok(state.calls === 1, `A14 库层: 1 refresh call (got ${state.calls})`);
  ok(store._value === "refreshed-token", "A14 库层: token updated");
  ok(onAuthFailedCalls === 0, "A14 库层: onAuthFailed NOT called (success)");
  ok(!!result.data, "A14 库层: got data after retry");
  console.log("  → A14 库层完整链路通过 ✅");
}

// ═══════════════════════════════════════════════════════════════════════
// Section 7: 端到端鉴权场景（A16/D2/D7）+ B19 文件下载
// ═══════════════════════════════════════════════════════════════════════

/**
 * 真实 authRefresher：调 /connect/token(refresh_token)。
 * 支持 scenario 参数模拟 refresh 失败（D2/D3/D4/D7）。
 */
function makeHttpRefresher(opts: {
  scenario?: string; // ?scenario=refresh-401 等
}): { refresher: AuthRefresher; state: { calls: number } } {
  const state = { calls: 0 };
  const refresher: AuthRefresher = {
    refresh: async () => {
      state.calls++;
      const url = opts.scenario
        ? `${BASE}/connect/token?scenario=${opts.scenario}`
        : `${BASE}/connect/token`;
      const params = new URLSearchParams();
      params.set("grant_type", "refresh_token");
      params.set("refresh_token", "mock-refresh-token");
      params.set("client_id", "Infrastructure_Web");
      const r = await fetch(url, {
        method: "POST",
        body: params,
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`refresh failed: ${r.status} ${body}`);
      }
      const json = (await r.json()) as { access_token: string };
      return json.access_token;
    },
  };
  return { refresher, state };
}

async function testEndToEndAuth(): Promise<void> {
  console.log("\n━━━ Section 7: 端到端鉴权（A16/D2/D7）+ B19 ━━━");

  // ── A16: HTTP 401 → refresh 成功 → 重试成功 ──
  {
    const store = makeMemoryStore("expired"); // 触发 401
    const { refresher, state } = makeHttpRefresher({});
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    // 初始 token=expired → 401 → refresh → refreshed-token → 重试 → 200
    const result = await (
      api as unknown as {
        GET: (p: string, o?: unknown) => Promise<{ data: unknown; response: Response }>;
      }
    ).GET("/api/identity/users");

    ok(state.calls === 1, `A16: 1 refresh call (got ${state.calls})`);
    ok(store._value === "refreshed-token", "A16: token updated to refreshed-token");
    ok(onAuthFailedCalls === 0, "A16: onAuthFailed NOT called (refresh success)");
    ok(result.response.status === 200, `A16: final status 200 (got ${result.response.status})`);
    ok(!!result.data, "A16: got data after retry");
    console.log("  → A16 HTTP 401 → refresh → retry 端到端通过 ✅");
  }

  // ── D2: refresh 失败（refresh-401）→ AuthError + onAuthFailed ──
  {
    const store = makeMemoryStore("expired");
    const { refresher, state } = makeHttpRefresher({ scenario: "refresh-401" });
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    // 401 → refresh → 401 invalid_grant → AuthError → onAuthFailed
    await expectThrows(
      () =>
        (
          api as unknown as {
            GET: (p: string, o?: unknown) => Promise<unknown>;
          }
        ).GET("/api/identity/users"),
      AuthError,
      "D2: refresh fail → AuthError",
    );
    ok(state.calls === 1, `D2: 1 refresh call (got ${state.calls})`);
    ok(onAuthFailedCalls === 1, `D2: onAuthFailed called once (got ${onAuthFailedCalls})`);
    console.log("  → D2 refresh 失败 → AuthError + onAuthFailed 端到端通过 ✅");
  }

  // ── D7: refresh 超时 → AuthError ──
  {
    const store = makeMemoryStore("expired");
    const { refresher, state } = makeHttpRefresher({ scenario: "refresh-slow" });
    let onAuthFailedCalls = 0;
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => onAuthFailedCalls++,
      refreshTimeoutMs: 500, // mock refresh-slow 延迟 3s，必触发超时
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    await expectThrows(
      () =>
        (
          api as unknown as {
            GET: (p: string, o?: unknown) => Promise<unknown>;
          }
        ).GET("/api/identity/users"),
      AuthError,
      "D7: refresh timeout → AuthError",
    );
    ok(state.calls === 1, `D7: 1 refresh call (got ${state.calls})`);
    ok(onAuthFailedCalls === 1, `D7: onAuthFailed called on timeout (got ${onAuthFailedCalls})`);
    console.log("  → D7 refresh 超时 → AuthError 端到端通过 ✅");
  }

  // ── B19: 文件下载（responseType: "blob"）──
  {
    const http = new HttpClient({ baseURL: BASE });
    const res = await http.request({
      method: "GET",
      path: "/api/test/download",
      responseType: "blob",
    });
    eq(res.status, 200, "B19 download status");
    ok(!!res.blob, "B19 blob present");
    ok(res.blob!.size === 1024, `B19 blob size 1024 (got ${res.blob!.size})`);
    const cd = res.headers.get("Content-Disposition");
    ok(cd?.includes('filename="test.bin"'), `B19 Content-Disposition (got ${cd})`);
    ok(res.headers.get("Content-Type") === "application/octet-stream", "B19 Content-Type");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 8: client.request 走内核（无 schema 接口保留 auth/retry/httpError）
// ═══════════════════════════════════════════════════════════════════════

async function testRequestKeepsKernel(): Promise<void> {
  console.log("\n━━━ Section 8: client.request 走内核（无 schema）━━━");

  // ── L1: client.request 5xx → ApiError（HTTP error 自动注入）──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [], // 无业务 middleware，纯内核
      maxRetries: 1,
    });

    // client.request 走内核 middleware（auth + httpError）
    const error = await expectThrows(
      () =>
        (
          api as unknown as {
            request: (m: string, p: string, o?: unknown) => Promise<unknown>;
          }
        ).request("get", "/api/test/500-json"),
      ApiError,
      "client.request 5xx → ApiError（HTTP error 自动注入）",
    );
    ok(error?.kind === "http", "client.request 5xx kind=http");
  }

  // ── L2: client.request 401 → refresh → retry → 200（auth 自动注入）──
  {
    const store = makeMemoryStore("expired-token");
    let refreshCount = 0;
    const refresher: AuthRefresher = {
      refresh: async () => {
        refreshCount++;
        return "refreshed-token";
      },
    };
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    // client.request 走 auth middleware：401 → refresh → 重试 → 200
    const res = (await (
      api as unknown as {
        request: (
          m: string,
          p: string,
          o?: unknown,
        ) => Promise<{
          data: unknown;
          response: Response;
        }>;
      }
    ).request("get", "/api/identity/users?SkipCount=0&MaxResultCount=1")) as {
      data: unknown;
      response: Response;
    };

    ok(res.response.status === 200, "client.request 401 → refresh → retry → 200");
    ok(refreshCount === 1, `client.request auth retry: refresh called once (got ${refreshCount})`);
    ok(res.data !== null, "client.request 返回 data 有值");
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Section 9: 文件下载走内核（download 方法测 progress + 文件名 + auth）
// ═══════════════════════════════════════════════════════════════════════

/**
 * downloadWithProgress —— 从 createNet client + Response 读 stream + 进度回调。
 *
 * 这是 init.ts download 方法的库层版本（Node.js 可跑）。
 * 业务层（init.ts）的 download 方法封装了 auth/httpError/retry，
 * 这里直接用 createNet client.request 测试内核能力。
 *
 * 两种模式（同 init.ts download）：
 *   - 内存模式（不传 onChunk）：累积 chunk → 返回 Blob
 *   - 流式模式（传 onChunk）：chunk 交 onChunk 处理，blob 返回 null
 */
async function downloadWithProgress(
  client: ReturnType<typeof createNet<Record<string, never>>>,
  path: string,
  onProgress?: (received: number, total: number | null) => void,
  rangeFrom?: number,
  onChunk?: (chunk: Uint8Array, received: number, total: number | null) => Promise<void> | void,
): Promise<{
  blob: Blob | null;
  filename: string | null;
  status: number;
  headers: Headers;
  total: number | null;
}> {
  type RawRequest = (
    method: string,
    path: string,
    opts: Record<string, unknown>,
  ) => Promise<{ data: unknown; response: Response }>;
  const rawRequest = client.request as unknown as RawRequest;

  const headers: Record<string, string> = {};
  if (rangeFrom !== undefined && rangeFrom > 0) {
    headers["Range"] = `bytes=${rangeFrom}-`;
  }

  const res = await rawRequest("get", path, { headers, parseAs: "stream" });
  const response = res.response;
  const contentLength = response.headers.get("Content-Length");
  const total = contentLength ? parseInt(contentLength, 10) : null;
  const disposition = response.headers.get("Content-Disposition");

  // 文件名提取
  let filename: string | null = null;
  if (disposition) {
    const starMatch = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (starMatch?.[1]) {
      try {
        filename = decodeURIComponent(starMatch[1].trim());
      } catch {
        filename = starMatch[1].trim();
      }
    }
    if (!filename) {
      const quotedMatch = disposition.match(/filename\s*=\s*"([^"]+)"/i);
      if (quotedMatch?.[1]) filename = quotedMatch[1];
    }
    if (!filename) {
      const plainMatch = disposition.match(/filename\s*=\s*([^;]+)/i);
      if (plainMatch?.[1]) filename = plainMatch[1].trim();
    }
  }

  // 读 stream（Node.js fetch 支持 response.body）
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    onProgress?.(blob.size, total);
    return { blob, filename, status: response.status, headers: response.headers, total };
  }

  const useStreamMode = !!onChunk;
  // Node.js 环境：无 BlobPart 类型，用 Uint8Array[] + cast
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (useStreamMode && onChunk) {
        await onChunk(value, received, total);
      } else {
        chunks.push(value);
      }
      onProgress?.(received, total);
    }
  }
  const blob = useStreamMode
    ? null
    : new Blob(chunks as unknown as ConstructorParameters<typeof Blob>[0]);
  return { blob, filename, status: response.status, headers: response.headers, total };
}

async function testDownloadKeepsKernel(): Promise<void> {
  console.log("\n━━━ Section 9: 文件下载走内核（progress + 文件名 + auth）━━━");

  // ── M1: 基本下载 + 文件名提取 ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    const { blob, filename, status, total } = await downloadWithProgress(api, "/api/test/download");
    ok(status === 200, `M1 download status 200 (got ${status})`);
    ok(blob !== null, "M1 download blob not null (memory mode)");
    ok(blob!.size === 1024, `M1 download blob.size 1024 (got ${blob?.size})`);
    ok(filename === "test.bin", `M1 download filename "test.bin" (got ${filename})`);
    ok(total === 1024, `M1 download total 1024 (got ${total})`);
  }

  // ── M2: 大文件下载 + 进度回调 ──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    let progressCount = 0;
    let lastReceived = 0;
    const { blob, filename, total } = await downloadWithProgress(
      api,
      "/api/test/download-large",
      (received, t) => {
        progressCount++;
        lastReceived = received;
        ok(t === 256 * 1024, `M2 progress total should be 256KB (got ${t})`);
      },
    );
    ok(blob !== null, "M2 download blob not null (memory mode)");
    ok(blob!.size === 256 * 1024, `M2 download blob.size 256KB (got ${blob?.size})`);
    ok(filename === "large-test.bin", `M2 download filename "large-test.bin" (got ${filename})`);
    ok(total === 256 * 1024, `M2 download total 256KB (got ${total})`);
    ok(progressCount >= 10, `M2 progress called >= 10 times (got ${progressCount})`);
    ok(lastReceived === 256 * 1024, `M2 last received 256KB (got ${lastReceived})`);
  }

  // ── M3: 过期 token → 401 → refresh → 下载成功（auth 走内核）──
  {
    const store = makeMemoryStore("expired-token");
    let refreshCount = 0;
    const refresher: AuthRefresher = {
      refresh: async () => {
        refreshCount++;
        return "refreshed-token";
      },
    };
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    const { blob, status } = await downloadWithProgress(api, "/api/test/download");
    ok(status === 200, `M3 download after refresh status 200 (got ${status})`);
    ok(blob !== null, "M3 download blob not null (memory mode)");
    ok(blob!.size === 1024, `M3 download blob.size 1024 (got ${blob?.size})`);
    ok(refreshCount === 1, `M3 download auth retry: refresh called once (got ${refreshCount})`);
  }

  // ── M4: 中文文件名（filename* UTF-8）──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    const { filename } = await downloadWithProgress(api, "/api/test/download-cn");
    ok(filename === "测试文件.bin", `M4 download CN filename "测试文件.bin" (got ${filename})`);
  }

  // ── M5: 断点续传（Range: bytes=32768- → 206 Partial Content）──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    const { blob, status, headers, total } = await downloadWithProgress(
      api,
      "/api/test/download-resumable",
      undefined,
      32768, // rangeFrom: 从 32KB 处续传
    );
    ok(status === 206, `M5 resume status 206 (got ${status})`);
    ok(blob !== null, "M5 resume blob not null (memory mode)");
    ok(blob!.size === 32768, `M5 resume blob.size 32768 (got ${blob?.size})`);
    ok(total === 32768, `M5 resume total 32768 (got ${total})`);
    const contentRange = headers.get("Content-Range");
    ok(
      contentRange?.startsWith("bytes 32768-") === true,
      `M5 Content-Range starts with "bytes 32768-" (got ${contentRange})`,
    );
  }

  // ── M6: 下载 5xx → ApiError（HTTP error 走内核）──
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    const error = await expectThrows(
      () => downloadWithProgress(api, "/api/test/500-json"),
      ApiError,
      "M6 download 5xx → ApiError（HTTP error 自动注入）",
    );
    ok(error?.kind === "http", "M6 download 5xx kind=http");
  }

  // ── M7: 流式下载（onChunk 模式，不累积到内存，blob 返回 null）──
  // 模拟大文件写盘：onChunk 收 chunk 后丢弃（不累积）
  // 验证：blob === null，received 累计正确，onProgress 正常回调
  {
    const store = makeMemoryStore("mock-token");
    const { refresher } = makeRefresher({ token: "mock-token" });
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    let chunkCount = 0;
    let totalReceived = 0;
    let progressCount = 0;
    let lastProgressReceived = 0;

    const result = await downloadWithProgress(
      api,
      "/api/test/download-large",
      (received, t) => {
        progressCount++;
        lastProgressReceived = received;
        ok(t === 256 * 1024, `M7 progress total should be 256KB (got ${t})`);
      },
      undefined,
      // onChunk：模拟写盘（这里只计数，不累积）
      (chunk, received) => {
        chunkCount++;
        totalReceived = received;
        // 验证 chunk 是 Uint8Array（非空）
        ok(chunk.byteLength > 0, `M7 chunk ${chunkCount} byteLength > 0 (got ${chunk.byteLength})`);
      },
    );

    ok(result.blob === null, `M7 stream mode blob should be null (got ${typeof result.blob})`);
    ok(result.status === 200, `M7 stream download status 200 (got ${result.status})`);
    ok(
      result.filename === "large-test.bin",
      `M7 stream filename "large-test.bin" (got ${result.filename})`,
    );
    ok(result.total === 256 * 1024, `M7 stream total 256KB (got ${result.total})`);
    ok(chunkCount >= 10, `M7 onChunk called >= 10 times (got ${chunkCount})`);
    ok(totalReceived === 256 * 1024, `M7 totalReceived 256KB (got ${totalReceived})`);
    ok(progressCount >= 10, `M7 onProgress called >= 10 times (got ${progressCount})`);
    ok(
      lastProgressReceived === 256 * 1024,
      `M7 last progress received 256KB (got ${lastProgressReceived})`,
    );
  }

  // ── M8: 流式下载 + 401 → refresh → 流式下载成功（auth 走内核 + 流式模式）──
  {
    const store = makeMemoryStore("expired-token");
    let refreshCount = 0;
    const refresher: AuthRefresher = {
      refresh: async () => {
        refreshCount++;
        return "refreshed-token";
      },
    };
    const auth = new AuthService({
      tokenStore: store,
      authRefresher: refresher,
      onAuthFailed: () => {},
    });

    const api = createNet<Record<string, never>>({
      baseURL: BASE,
      authService: auth,
      middleware: [],
      maxRetries: 1,
    });

    let chunkCount = 0;
    let totalReceived = 0;
    const result = await downloadWithProgress(
      api,
      "/api/test/download",
      undefined,
      undefined,
      (_chunk, received) => {
        chunkCount++;
        totalReceived = received;
      },
    );

    ok(result.blob === null, `M8 stream mode blob should be null`);
    ok(result.status === 200, `M8 stream download after refresh status 200 (got ${result.status})`);
    ok(totalReceived === 1024, `M8 stream totalReceived 1024 (got ${totalReceived})`);
    ok(chunkCount >= 1, `M8 onChunk called >= 1 time (got ${chunkCount})`);
    ok(refreshCount === 1, `M8 stream auth retry: refresh called once (got ${refreshCount})`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════════════

// ─── mock-server 自动起停 ───

/** 探测 mock-server 是否已启动（读 pidfile + 健康检查） */
async function isMockRunning(): Promise<boolean> {
  if (!existsSync(MOCK_PID_FILE)) return false;
  try {
    const res = await fetch(`${BASE}/api/test/204`, { method: "GET" });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** 拉起 mock-server 子进程，返回 childProcess；失败返 null */
function spawnMockServer(): ChildProcess | null {
  console.log("[test] mock-server 未运行，自动拉起子进程...");
  const child = spawn("pnpm", ["mock"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: false,
    shell: false,
  });
  child.on("error", (err) => {
    console.error(`[test] mock-server spawn failed: ${err.message}`);
  });
  return child;
}

/** 等待 mock-server 就绪（最多 5s） */
async function waitForMockReady(): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/test/204`, { method: "GET" });
      if (res.status === 204) return true;
    } catch {
      // 还没起
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("xapiforge 场景验证开始");
  console.log(`target: ${BASE}`);

  // 1. 判断 mock 是否已启动；没起就拉子进程
  let mockChild: ChildProcess | null = null;
  let startedByUs = false;
  if (await isMockRunning()) {
    console.log("[test] mock-server 已运行（复用）");
  } else {
    mockChild = spawnMockServer();
    if (!mockChild) {
      console.error("\n❌ 无法启动 mock-server。请手动跑 `pnpm mock` 后再试。");
      process.exit(1);
    }
    startedByUs = true;
    const ready = await waitForMockReady();
    if (!ready) {
      console.error("\n❌ mock-server 5s 内未就绪。");
      mockChild.kill();
      process.exit(1);
    }
    console.log("[test] mock-server 已就绪");
  }

  // 2. 跑测试（异常也要 cleanup）
  let exitCode = 0;
  try {
    await testHttpClient();
    await testMiddlewares();
    await testAuthService();
    await testEnvelopeVariants();
    await testMiddlewareChainAndRetry();
    await testA14AtLibLevel();
    await testEndToEndAuth();
    await testRequestKeepsKernel();
    await testDownloadKeepsKernel();

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    if (failures.length > 0) {
      console.log("\n失败列表:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error(`\n💥 测试执行异常: ${(e as Error).message}`);
    console.error((e as Error).stack);
    exitCode = 1;
  } finally {
    // 3. cleanup：只有自己起的才 kill
    if (startedByUs && mockChild) {
      console.log("[test] 关闭 mock-server 子进程...");
      mockChild.kill();
      // mock-server 会写 pidfile，清掉
      try {
        if (existsSync(MOCK_PID_FILE)) {
          const pid = Number(readFileSync(MOCK_PID_FILE, "utf8").trim());
          if (pid && !Number.isNaN(pid)) {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              // 可能已被 kill
            }
          }
          unlinkSync(MOCK_PID_FILE);
        }
      } catch {
        // ignore
      }
    }
  }

  process.exit(exitCode);
}

void main();
