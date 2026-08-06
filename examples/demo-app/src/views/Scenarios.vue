<!--
  demo-app 场景验证页 — 回归测试入口

  特点：
    1. 每个场景有自动断言（pass/fail），不只是展示结果
    2. "Run All" 一键跑全部 + 汇总（X passed / Y failed / Z total）
    3. 覆盖 @xapiforge/core 所有功能 + 易错边角场景
    4. 每个场景显示 expected vs actual，方便定位问题

  场景分类：
    A. 鉴权（401 refresh / 单飞 / 窗口保护 / 业务 200 鉴权码）
    B. HTTP 错误（4xx / 5xx / 空 body / HTML body）
    C. 特殊响应（204 / 200 空 body / BOM / 重定向 / 大响应 / 纯文本 / XML）
    D. ABP envelope 变体（C1-C10）
    E. createNet 5xx → ApiError（解析后的 body 保留验证）
    F. request 方法（走内核 + 自定义 unwrap + 401 refresh）
    G. 文件下载（基本 / 进度 / 401 refresh / 中文文件名 / 断点续传 / 流式 / fetch 注入）
    H. 后端错误格式（RFC7807 / 微信 / OAuth / 自研 A/B）

  使用前：pnpm mock 启动 mock-server + 已登录（token 有效）
-->

<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { useApi } from "../api/index.js";
import { ApiError, AuthError, NetworkError } from "@xapiforge/core";
import { AbpBizError } from "../middleware/abp-unwrap-mw.js";

const router = useRouter();
const api = useApi();

// ─── 辅助：绕过 schema 类型检查的 GET（走完整 middleware 链）───
// 用于 /api/test/* 等不在 swagger schema 里的测试端点
type RawGetResult = { data: unknown; response: Response };
type RawApiClient = {
  GET: (path: string, init?: Record<string, unknown>) => Promise<RawGetResult>;
};
const rawApi = api.base as unknown as RawApiClient;

/** 统一格式化 catch 到的 error（Vue 的 catch e 是 unknown） */
function errMsg(e: unknown): string {
  if (e instanceof Error) return `${e.constructor.name}: ${e.message}`;
  return String(e);
}

// ─── 类型 ───────────────────────────────────────────────────

interface VerifyResult {
  id: string;
  name: string;
  category: string;
  pass: boolean;
  expected: string;
  actual: string;
  detail?: string;
  timingMs: number;
  status?: "pending" | "running" | "done";
}

// ─── 状态 ───────────────────────────────────────────────────

const results = reactive<Record<string, VerifyResult>>({});
const running = ref(false);
const currentScenario = ref<string>("");
const summary = ref({ passed: 0, failed: 0, total: 0 });
const currentToken = ref(localStorage.getItem("app_token") ?? "(空)");

function refreshTokenDisplay(): void {
  currentToken.value = localStorage.getItem("app_token") ?? "(空)";
}

function setToken(token: string): void {
  localStorage.setItem("app_token", token);
  refreshTokenDisplay();
}

function restoreToken(): void {
  setToken("mock-token");
  localStorage.setItem("app_refresh_token", "mock-refresh-token");
  refreshTokenDisplay();
}

// ─── 工具：记录结果 ─────────────────────────────────────────

function record(
  id: string,
  name: string,
  category: string,
  pass: boolean,
  expected: string,
  actual: string,
  detail: string | undefined,
  timingMs: number,
): void {
  results[id] = {
    id,
    name,
    category,
    pass,
    expected,
    actual,
    detail,
    timingMs,
    status: "done",
  };
}

// ─── 场景定义 ───────────────────────────────────────────────

interface Scenario {
  id: string;
  name: string;
  category: string;
  run: () => Promise<void>;
}

const scenarios: Scenario[] = [
  // ════════════ A. 鉴权场景 ════════════
  {
    id: "a16",
    name: "A16: 401 → refresh → retry → 200",
    category: "A. 鉴权",
    run: async () => {
      const savedToken = localStorage.getItem("app_token") ?? "";
      const savedRefresh = localStorage.getItem("app_refresh_token") ?? "";
      setToken("expired-token");
      const start = Date.now();
      try {
        await api.base.GET("/api/identity/users", {
          params: { query: { pageIndex: 0, pageSize: 1 } },
        });
        const elapsed = Date.now() - start;
        const afterToken = localStorage.getItem("app_token") ?? "";
        const pass = afterToken === "refreshed-token";
        record(
          "a16",
          "A16: 401 → refresh → retry → 200",
          "A. 鉴权",
          pass,
          "token 从 expired-token 变为 refreshed-token，请求成功",
          `refresh 后 token: ${afterToken}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "a16",
          "A16: 401 → refresh → retry → 200",
          "A. 鉴权",
          false,
          "请求成功（refresh 后重试）",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      } finally {
        localStorage.setItem("app_token", savedToken);
        localStorage.setItem("app_refresh_token", savedRefresh);
        refreshTokenDisplay();
      }
    },
  },
  {
    id: "a14",
    name: "A14: 业务 200 鉴权码 (code:40001 → refresh)",
    category: "A. 鉴权",
    run: async () => {
      const savedToken = localStorage.getItem("app_token") ?? "";
      const savedRefresh = localStorage.getItem("app_refresh_token") ?? "";
      setToken("biz-code-expired");
      const start = Date.now();
      try {
        // 走 createNet + abp-unwrap-mw：检测 code=40001 → RetryableError → refresh → 重试
        // 重试时 token 已变 refreshed-token（refresh 后），但 biz-code-expired 路径只认 mock-token/refreshed-token
        const res = await rawApi.GET("/api/auth/biz-code-expired");
        const elapsed = Date.now() - start;
        const afterToken = localStorage.getItem("app_token") ?? "";
        const data = res.data as { ok?: boolean } | undefined;
        const pass = afterToken === "refreshed-token" && data?.ok === true;
        record(
          "a14",
          "A14: 业务 200 鉴权码 (code:40001 → refresh)",
          "A. 鉴权",
          pass,
          "abp-unwrap-mw 检测 code=40001 → refresh → 重试 → data.ok=true",
          `data.ok=${data?.ok}, token=${afterToken}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "a14",
          "A14: 业务 200 鉴权码 (code:40001 → refresh)",
          "A. 鉴权",
          false,
          "abp-unwrap-mw 检测 code=40001 → refresh → 重试 → data.ok=true",
          `失败: ${errMsg(e)}`,
          undefined,
          Date.now() - start,
        );
      } finally {
        localStorage.setItem("app_token", savedToken);
        localStorage.setItem("app_refresh_token", savedRefresh);
        refreshTokenDisplay();
      }
    },
  },
  {
    id: "e1",
    name: "E1: 5 并发 401 → 单飞 refresh（只调 1 次）",
    category: "A. 鉴权",
    run: async () => {
      const savedToken = localStorage.getItem("app_token") ?? "";
      const savedRefresh = localStorage.getItem("app_refresh_token") ?? "";
      setToken("expired-token");
      // reset refresh 计数
      await fetch("http://localhost:8787/api/test/refresh-count-reset");
      const start = Date.now();
      try {
        const promises = Array.from({ length: 5 }, () =>
          api.base.GET("/api/identity/users", {
            params: { query: { pageIndex: 0, pageSize: 1 } },
          }),
        );
        const results5 = await Promise.allSettled(promises);
        const elapsed = Date.now() - start;
        const successCount = results5.filter((r) => r.status === "fulfilled").length;
        // 读 refresh 调用次数
        const countRes = await fetch("http://localhost:8787/api/test/refresh-count");
        const countJson = (await countRes.json()) as { count: number };
        // pass 条件：5/5 全部成功（单飞保证并发 401 只触发一次 refresh 或窗口内零次）
        // refreshCallCount 可能为 0（前序场景的 refresh 窗口仍激活，refreshIfNeeded
        //   直接返回缓存 token）或 1（首次 refresh）。两者都验证了单飞语义。
        const pass = successCount === 5 && countJson.count <= 1;
        record(
          "e1",
          "E1: 5 并发 401 → 单飞 refresh（≤1 次）",
          "A. 鉴权",
          pass,
          "5/5 成功 + refresh ≤1 次（单飞 + 窗口保护）",
          `成功 ${successCount}/5, refresh 调用 ${countJson.count} 次`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "e1",
          "E1: 5 并发 401 → 单飞 refresh（≤1 次）",
          "A. 鉴权",
          false,
          "5/5 成功 + refresh ≤1 次",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      } finally {
        localStorage.setItem("app_token", savedToken);
        localStorage.setItem("app_refresh_token", savedRefresh);
        refreshTokenDisplay();
      }
    },
  },
  {
    id: "f1",
    name: "F1: 窗口内 401 → onAuthFailed（Bug 2 修复）",
    category: "A. 鉴权",
    run: async () => {
      const savedToken = localStorage.getItem("app_token") ?? "";
      const savedRefresh = localStorage.getItem("app_refresh_token") ?? "";
      setToken("expired-token");
      const start = Date.now();
      try {
        // /api/test/auth-401 永远返 401 → refresh → 重试 → 还是 401 → 窗口内 → AuthError
        await rawApi.GET("/api/test/auth-401");
        record(
          "f1",
          "F1: 窗口内 401 → onAuthFailed（Bug 2 修复）",
          "A. 鉴权",
          false,
          "抛 AuthError（token rejected after fresh refresh）",
          "未抛错（不应该）",
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const isAuthError = e instanceof AuthError;
        const err = e instanceof Error ? e : new Error(String(e));
        record(
          "f1",
          "F1: 窗口内 401 → onAuthFailed（Bug 2 修复）",
          "A. 鉴权",
          isAuthError,
          "抛 AuthError（refresh 后仍 401 → 不再 refresh → onAuthFailed）",
          `${err.constructor.name}: ${err.message}`,
          undefined,
          elapsed,
        );
      } finally {
        localStorage.setItem("app_token", savedToken);
        localStorage.setItem("app_refresh_token", savedRefresh);
        refreshTokenDisplay();
      }
    },
  },

  // ════════════ B. HTTP 错误（HttpClient 直调）════════════
  {
    id: "a17",
    name: "A17: 429 + Retry-After header",
    category: "B. HTTP 错误",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({
          method: "GET",
          path: "/api/test/429-with-retry-after",
        });
        const elapsed = Date.now() - start;
        const retryAfter = res.headers.get("Retry-After");
        const pass = res.status === 429 && retryAfter === "1";
        record(
          "a17",
          "A17: 429 + Retry-After header",
          "B. HTTP 错误",
          pass,
          "status=429, Retry-After=1",
          `status=${res.status}, Retry-After=${retryAfter}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "a17",
          "A17: 429 + Retry-After header",
          "B. HTTP 错误",
          false,
          "status=429, Retry-After=1",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "a18",
    name: "A18: 500 + HTML body 保留",
    category: "B. HTTP 错误",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/500-html" });
        const elapsed = Date.now() - start;
        const hasHtml = (res.bodyText ?? "").includes("<html>");
        const pass = res.status === 500 && hasHtml;
        record(
          "a18",
          "A18: 500 + HTML body 保留",
          "B. HTTP 错误",
          pass,
          "status=500, body 含 <html>",
          `status=${res.status}, body 含 <html>: ${hasHtml}`,
          `body 前 100 字符: ${res.bodyText?.slice(0, 100) ?? "(空)"}`,
          elapsed,
        );
      } catch (e) {
        record(
          "a18",
          "A18: 500 + HTML body 保留",
          "B. HTTP 错误",
          false,
          "status=500, body 含 <html>",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "g1",
    name: "G1: 400 + 验证错误 body",
    category: "B. HTTP 错误",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/400-validation" });
        const elapsed = Date.now() - start;
        const json = JSON.parse(res.bodyText || "{}");
        const pass = res.status === 400 && Array.isArray(json.errors) && json.errors.length > 0;
        record(
          "g1",
          "G1: 400 + 验证错误 body",
          "B. HTTP 错误",
          pass,
          "status=400, body.errors 数组非空",
          `status=${res.status}, errors.length=${json.errors?.length}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "g1",
          "G1: 400 + 验证错误 body",
          "B. HTTP 错误",
          false,
          "status=400, body.errors 数组非空",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "g3",
    name: "G3: 413 + 空 body",
    category: "B. HTTP 错误",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({
          method: "GET",
          path: "/api/test/413-payload-too-large",
        });
        const elapsed = Date.now() - start;
        const pass = res.status === 413 && (res.bodyText === "" || res.bodyText === null);
        record(
          "g3",
          "G3: 413 + 空 body",
          "B. HTTP 错误",
          pass,
          "status=413, body 为空",
          `status=${res.status}, body="${res.bodyText ?? ""}"`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "g3",
          "G3: 413 + 空 body",
          "B. HTTP 错误",
          false,
          "status=413, body 为空",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "h1",
    name: "H1: 500 + 空 body",
    category: "B. HTTP 错误",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/500-empty" });
        const elapsed = Date.now() - start;
        const pass = res.status === 500 && (res.bodyText === "" || res.bodyText === null);
        record(
          "h1",
          "H1: 500 + 空 body",
          "B. HTTP 错误",
          pass,
          "status=500, body 为空",
          `status=${res.status}, body="${res.bodyText ?? ""}"`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "h1",
          "H1: 500 + 空 body",
          "B. HTTP 错误",
          false,
          "status=500, body 为空",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "h4",
    name: "H4: 503 + Retry-After header",
    category: "B. HTTP 错误",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/503-retry" });
        const elapsed = Date.now() - start;
        const retryAfter = res.headers.get("Retry-After");
        const pass = res.status === 503 && retryAfter === "2";
        record(
          "h4",
          "H4: 503 + Retry-After header",
          "B. HTTP 错误",
          pass,
          "status=503, Retry-After=2",
          `status=${res.status}, Retry-After=${retryAfter}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "h4",
          "H4: 503 + Retry-After header",
          "B. HTTP 错误",
          false,
          "status=503, Retry-After=2",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },

  // ════════════ C. 特殊响应 ════════════
  {
    id: "a21",
    name: "A21: 204 空响应",
    category: "C. 特殊响应",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/204" });
        const elapsed = Date.now() - start;
        const pass = res.status === 204 && (res.bodyText === "" || res.bodyText === null);
        record(
          "a21",
          "A21: 204 空响应",
          "C. 特殊响应",
          pass,
          "status=204, body 为空",
          `status=${res.status}, body="${res.bodyText ?? ""}"`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "a21",
          "A21: 204 空响应",
          "C. 特殊响应",
          false,
          "status=204, body 为空",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "a22",
    name: "A22: 200 + 空 body",
    category: "C. 特殊响应",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/200-empty" });
        const elapsed = Date.now() - start;
        const pass = res.status === 200 && (res.bodyText === "" || res.bodyText === null);
        record(
          "a22",
          "A22: 200 + 空 body",
          "C. 特殊响应",
          pass,
          "status=200, body 为空",
          `status=${res.status}, body="${res.bodyText ?? ""}"`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "a22",
          "A22: 200 + 空 body",
          "C. 特殊响应",
          false,
          "status=200, body 为空",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "b11",
    name: "B11: body 含 BOM（fetch 自动剥离，不破坏 JSON 解析）",
    category: "C. 特殊响应",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/bom" });
        const elapsed = Date.now() - start;
        // fetch .text() 按 spec 自动剥离 BOM（\uFEFF）→ bodyText 不含 BOM
        // 验证点：BOM 不破坏 JSON 解析（后端返 BOM 前缀的 JSON，库层无需特殊处理）
        // mock 返 biz({ok:true, bom:true}) = {code:0, data:{ok:true,bom:true}} → ok/bom 在 data 内
        const hasBom = (res.bodyText ?? "").startsWith("\uFEFF");
        let parsed: { code?: number; data?: { ok?: boolean; bom?: boolean } } | null = null;
        try {
          parsed = JSON.parse(res.bodyText ?? "");
        } catch {
          parsed = null;
        }
        const pass =
          res.status === 200 && !hasBom && parsed?.data?.ok === true && parsed?.data?.bom === true;
        record(
          "b11",
          "B11: body 含 BOM（fetch 自动剥离）",
          "C. 特殊响应",
          pass,
          "status=200, BOM 被 fetch 剥离, JSON.parse 成功且 data.ok=true",
          `status=${res.status}, hasBOM=${hasBom}, parsed.data.ok=${parsed?.data?.ok}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "b11",
          "B11: body 含 BOM（fetch 自动剥离）",
          "C. 特殊响应",
          false,
          "status=200, BOM 被剥离, JSON 解析成功",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "j2",
    name: "J2: 大响应体（1MB JSON, 10000 items）",
    category: "C. 特殊响应",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/large-response" });
        const elapsed = Date.now() - start;
        const json = JSON.parse(res.bodyText || "{}");
        const pass = res.status === 200 && json.data?.length === 10000;
        record(
          "j2",
          "J2: 大响应体（1MB JSON, 10000 items）",
          "C. 特殊响应",
          pass,
          "status=200, data.length=10000",
          `status=${res.status}, data.length=${json.data?.length}`,
          `body 大小: ${res.bodyText?.length ?? 0} 字符`,
          elapsed,
        );
      } catch (e) {
        record(
          "j2",
          "J2: 大响应体（1MB JSON, 10000 items）",
          "C. 特殊响应",
          false,
          "status=200, data.length=10000",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "j3",
    name: "J3: XML 错误（500 + application/xml）",
    category: "C. 特殊响应",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/xml-error" });
        const elapsed = Date.now() - start;
        const hasXml = (res.bodyText ?? "").includes("<?xml");
        const pass = res.status === 500 && hasXml;
        record(
          "j3",
          "J3: XML 错误（500 + application/xml）",
          "C. 特殊响应",
          pass,
          "status=500, body 含 <?xml",
          `status=${res.status}, hasXml=${hasXml}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "j3",
          "J3: XML 错误（500 + application/xml）",
          "C. 特殊响应",
          false,
          "status=500, body 含 <?xml",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },

  // ════════════ D. ABP envelope 变体（request 看原始 payload）════════════
  {
    id: "c1",
    name: "C1: data 是 string",
    category: "D. ABP envelope",
    run: async () => {
      const start = Date.now();
      try {
        const payload = await api.request<{ code: number; data: string }>(
          "/api/test/c1-data-string",
        );
        const elapsed = Date.now() - start;
        const pass = payload.code === 0 && payload.data === "https://file.url";
        record(
          "c1",
          "C1: data 是 string",
          "D. ABP envelope",
          pass,
          "code=0, data='https://file.url'",
          `code=${payload.code}, data=${payload.data}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "c1",
          "C1: data 是 string",
          "D. ABP envelope",
          false,
          "code=0, data='https://file.url'",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "c4",
    name: "C4: data 是 null",
    category: "D. ABP envelope",
    run: async () => {
      const start = Date.now();
      try {
        const payload = await api.request<{ code: number; data: unknown }>(
          "/api/test/c4-data-null",
        );
        const elapsed = Date.now() - start;
        const pass = payload.code === 0 && payload.data === null;
        record(
          "c4",
          "C4: data 是 null",
          "D. ABP envelope",
          pass,
          "code=0, data=null",
          `code=${payload.code}, data=${payload.data}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "c4",
          "C4: data 是 null",
          "D. ABP envelope",
          false,
          "code=0, data=null",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "c6",
    name: "C6: code 是 string '0'（非 ABP 格式，middleware 不处理）",
    category: "D. ABP envelope",
    run: async () => {
      const start = Date.now();
      try {
        const payload = await api.request<{ code: string; data: unknown }>(
          "/api/test/c6-code-string",
        );
        const elapsed = Date.now() - start;
        // code 是 string，abp-unwrap-mw 不处理（typeof code !== "number"）
        const pass = payload.code === "0" && typeof payload.data === "object";
        record(
          "c6",
          "C6: code 是 string '0'",
          "D. ABP envelope",
          pass,
          "code='0' (string), middleware 不处理",
          `code=${payload.code} (${typeof payload.code})`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "c6",
          "C6: code 是 string '0'",
          "D. ABP envelope",
          false,
          "code='0' (string)",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "c9",
    name: "C9: array root（非 envelope，middleware 不处理）",
    category: "D. ABP envelope",
    run: async () => {
      const start = Date.now();
      try {
        const payload = await api.request<unknown[]>("/api/test/c9-array-root");
        const elapsed = Date.now() - start;
        const pass = Array.isArray(payload) && payload.length === 2;
        record(
          "c9",
          "C9: array root",
          "D. ABP envelope",
          pass,
          "payload 是数组, length=2",
          `isArray=${Array.isArray(payload)}, length=${Array.isArray(payload) ? payload.length : "N/A"}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "c9",
          "C9: array root",
          "D. ABP envelope",
          false,
          "payload 是数组, length=2",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },

  // ════════════ E. createNet 5xx → ApiError（解析后的 body 保留）════════════
  {
    id: "k1",
    name: "K1: 500 JSON → ApiError.body 保留",
    category: "E. createNet 5xx",
    run: async () => {
      const start = Date.now();
      try {
        await rawApi.GET("/api/test/500-json");
        record(
          "k1",
          "K1: 500 JSON → ApiError.body",
          "E. createNet 5xx",
          false,
          "抛 ApiError(kind=http), body 含 code:500",
          "未抛错",
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const isHttpError = e instanceof ApiError && e.kind === "http";
        const body = isHttpError ? e.body : undefined;
        const pass = isHttpError && typeof body === "object" && body !== null && "code" in body;
        record(
          "k1",
          "K1: 500 JSON → ApiError.body",
          "E. createNet 5xx",
          pass,
          "抛 ApiError(kind=http), body 为解析后的对象",
          `${errMsg(e)}, body=${JSON.stringify(body).slice(0, 80)}`,
          undefined,
          elapsed,
        );
      }
    },
  },
  {
    id: "k2",
    name: "K2: 500 空 body → ApiError.body 为空",
    category: "E. createNet 5xx",
    run: async () => {
      const start = Date.now();
      try {
        await rawApi.GET("/api/test/500-empty");
        record(
          "k2",
          "K2: 500 空 body → ApiError",
          "E. createNet 5xx",
          false,
          "抛 ApiError(kind=http), body 为空",
          "未抛错",
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const isHttpError = e instanceof ApiError && e.kind === "http";
        const body = isHttpError ? e.body : undefined;
        const pass = isHttpError && body === undefined;
        record(
          "k2",
          "K2: 500 空 body → ApiError",
          "E. createNet 5xx",
          pass,
          "抛 ApiError(kind=http), body 为空",
          `${errMsg(e)}, body=${String(body)}`,
          undefined,
          elapsed,
        );
      }
    },
  },
  {
    id: "k3",
    name: "K3: 500 纯文本 → ApiError.body 保留",
    category: "E. createNet 5xx",
    run: async () => {
      const start = Date.now();
      try {
        await rawApi.GET("/api/test/plain-text-error");
        record(
          "k3",
          "K3: 500 纯文本 → ApiError",
          "E. createNet 5xx",
          false,
          "抛 ApiError(kind=http), body 含纯文本",
          "未抛错",
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const isHttpError = e instanceof ApiError && e.kind === "http";
        const body = isHttpError ? e.body : undefined;
        const hasBody = typeof body === "string" && body.includes("Internal Server Error");
        const pass = isHttpError && hasBody;
        record(
          "k3",
          "K3: 500 纯文本 → ApiError",
          "E. createNet 5xx",
          pass,
          "抛 ApiError(kind=http), body 含纯文本",
          `${errMsg(e)}, body=${typeof body === "string" ? body.slice(0, 80) : "(空)"}`,
          undefined,
          elapsed,
        );
      }
    },
  },

  // ════════════ F. request 方法（走内核 + 自定义 unwrap + 401 refresh）════════════
  {
    id: "l1",
    name: "L1: request 默认状态校验 → ApiError 保留 body",
    category: "F. request 方法",
    run: async () => {
      const start = Date.now();
      try {
        await api.request<{ type: string; title: string }>("/api/test/rfc7807");
        record(
          "l1",
          "L1: request 默认状态校验",
          "F. request 方法",
          false,
          "HTTP 400 抛 ApiError，且 body 保留 Problem Details",
          "未抛错",
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const err = e instanceof Error ? e : new Error(String(e));
        const body =
          e instanceof ApiError ? (e.body as { type?: string; title?: string }) : undefined;
        const pass =
          e instanceof ApiError &&
          e.status === 400 &&
          body?.type === "https://example.com/errors/invalid-request" &&
          body?.title === "Invalid request parameters";
        record(
          "l1",
          "L1: request 默认状态校验",
          "F. request 方法",
          pass,
          "HTTP 400 抛 ApiError，且 body 保留 Problem Details",
          `${err.constructor.name}(status=${e instanceof ApiError ? e.status : "n/a"}, title=${body?.title ?? "n/a"})`,
          undefined,
          elapsed,
        );
      }
    },
  },
  {
    id: "l2",
    name: "L2: request + unwrap 抽取 err.msg",
    category: "F. request 方法",
    run: async () => {
      const start = Date.now();
      try {
        const msg = await api.request<string>("/api/test/custom-a", {
          unwrap: (p) => (p as { err?: { msg?: string } })?.err?.msg ?? "(无 err.msg)",
        });
        const elapsed = Date.now() - start;
        const pass = msg === "Internal service error";
        record(
          "l2",
          "L2: request + unwrap",
          "F. request 方法",
          pass,
          "unwrap 抽取 err.msg='Internal service error'",
          `msg=${msg}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "l2",
          "L2: request + unwrap",
          "F. request 方法",
          false,
          "unwrap 抽取 err.msg",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "l3",
    name: "L3: 过期 token → request 401 → refresh → 重试",
    category: "F. request 方法",
    run: async () => {
      const savedToken = localStorage.getItem("app_token") ?? "";
      const savedRefresh = localStorage.getItem("app_refresh_token") ?? "";
      setToken("expired-token");
      const start = Date.now();
      try {
        // api.request 走 rawClient（无业务 middleware）→ 拿到原始 ABP envelope
        // {code:0, data:{items:[...], totalCount:N}} → items 在 data 内
        const payload = await api.request<{ code?: number; data?: { items?: unknown[] } }>(
          "/api/identity/users?pageIndex=0&pageSize=1",
        );
        const elapsed = Date.now() - start;
        const afterToken = localStorage.getItem("app_token") ?? "";
        const pass = afterToken === "refreshed-token" && !!payload?.data?.items;
        record(
          "l3",
          "L3: request 401 → refresh → 重试",
          "F. request 方法",
          pass,
          "token 变 refreshed-token, payload.data.items 存在",
          `token=${afterToken}, items=${!!payload?.data?.items}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "l3",
          "L3: request 401 → refresh → 重试",
          "F. request 方法",
          false,
          "token 变 refreshed-token",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      } finally {
        localStorage.setItem("app_token", savedToken);
        localStorage.setItem("app_refresh_token", savedRefresh);
        refreshTokenDisplay();
      }
    },
  },

  // ════════════ G. 文件下载 ════════════
  {
    id: "m1",
    name: "M1: 基本下载（1KB + 文件名提取）",
    category: "G. 文件下载",
    run: async () => {
      const start = Date.now();
      try {
        const { blob, filename, status, total } = await api.download("/api/test/download");
        const elapsed = Date.now() - start;
        const pass =
          status === 200 && blob?.size === 1024 && filename === "test.bin" && total === 1024;
        record(
          "m1",
          "M1: 基本下载",
          "G. 文件下载",
          pass,
          "status=200, blob=1024B, filename='test.bin'",
          `status=${status}, blob=${blob?.size}B, filename=${filename}, total=${total}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "m1",
          "M1: 基本下载",
          "G. 文件下载",
          false,
          "status=200, blob=1024B",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "m2",
    name: "M2: 大文件下载（256KB + 进度回调）",
    category: "G. 文件下载",
    run: async () => {
      let progressCount = 0;
      const start = Date.now();
      try {
        const { blob, filename, status } = await api.download("/api/test/download-large", {
          onProgress: () => {
            progressCount++;
          },
        });
        const elapsed = Date.now() - start;
        const pass =
          status === 200 &&
          blob?.size === 256 * 1024 &&
          filename === "large-test.bin" &&
          progressCount > 1;
        record(
          "m2",
          "M2: 大文件下载（256KB + 进度）",
          "G. 文件下载",
          pass,
          `status=200, blob=262144B, progress>1`,
          `status=${status}, blob=${blob?.size}B, progress=${progressCount}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "m2",
          "M2: 大文件下载",
          "G. 文件下载",
          false,
          `status=200, blob=262144B`,
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "m3",
    name: "M3: 过期 token → 401 → refresh → 下载",
    category: "G. 文件下载",
    run: async () => {
      const savedToken = localStorage.getItem("app_token") ?? "";
      const savedRefresh = localStorage.getItem("app_refresh_token") ?? "";
      setToken("expired-token");
      const start = Date.now();
      try {
        const { blob, status } = await api.download("/api/test/download");
        const elapsed = Date.now() - start;
        const afterToken = localStorage.getItem("app_token") ?? "";
        const pass = status === 200 && blob?.size === 1024 && afterToken === "refreshed-token";
        record(
          "m3",
          "M3: 下载 401 → refresh → 下载",
          "G. 文件下载",
          pass,
          "status=200, blob=1024B, token=refreshed-token",
          `status=${status}, blob=${blob?.size}B, token=${afterToken}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "m3",
          "M3: 下载 401 → refresh",
          "G. 文件下载",
          false,
          "status=200, blob=1024B",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      } finally {
        localStorage.setItem("app_token", savedToken);
        localStorage.setItem("app_refresh_token", savedRefresh);
        refreshTokenDisplay();
      }
    },
  },
  {
    id: "m4",
    name: "M4: 中文文件名（filename* UTF-8）",
    category: "G. 文件下载",
    run: async () => {
      const start = Date.now();
      try {
        const { blob, filename, status } = await api.download("/api/test/download-cn");
        const elapsed = Date.now() - start;
        const pass = status === 200 && blob?.size === 512 && filename === "测试文件.bin";
        record(
          "m4",
          "M4: 中文文件名",
          "G. 文件下载",
          pass,
          "filename='测试文件.bin'",
          `status=${status}, blob=${blob?.size}B, filename=${filename}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "m4",
          "M4: 中文文件名",
          "G. 文件下载",
          false,
          "filename='测试文件.bin'",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "m5",
    name: "M5: 断点续传（Range: bytes=32768-）",
    category: "G. 文件下载",
    run: async () => {
      const start = Date.now();
      try {
        const { blob, status, headers } = await api.download("/api/test/download-resumable", {
          rangeFrom: 32768,
        });
        const elapsed = Date.now() - start;
        const contentRange = headers.get("Content-Range");
        const pass = status === 206 && blob?.size === 32768 && !!contentRange;
        record(
          "m5",
          "M5: 断点续传",
          "G. 文件下载",
          pass,
          "status=206, blob=32768B, Content-Range 存在",
          `status=${status}, blob=${blob?.size}B, Content-Range=${contentRange}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "m5",
          "M5: 断点续传",
          "G. 文件下载",
          false,
          "status=206, blob=32768B",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "m6",
    name: "M6: 下载 5xx → ApiError（走内核 HTTP error）",
    category: "G. 文件下载",
    run: async () => {
      const start = Date.now();
      try {
        await api.download("/api/test/500-json");
        record(
          "m6",
          "M6: 下载 5xx → ApiError",
          "G. 文件下载",
          false,
          "抛 ApiError(kind=http)",
          "未抛错",
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const isHttpError = e instanceof ApiError && e.kind === "http";
        record(
          "m6",
          "M6: 下载 5xx → ApiError",
          "G. 文件下载",
          isHttpError,
          "抛 ApiError(kind=http)",
          `${errMsg(e)}`,
          `body: ${isHttpError ? JSON.stringify(e.body).slice(0, 100) : "(空)"}`,
          elapsed,
        );
      }
    },
  },
  {
    id: "m7",
    name: "M7: 流式下载（onChunk, blob=null, 不占内存）",
    category: "G. 文件下载",
    run: async () => {
      let chunkCount = 0;
      const writtenChunks: Uint8Array[] = [];
      const start = Date.now();
      try {
        const result = await api.download("/api/test/download-large", {
          onChunk: (chunk) => {
            chunkCount++;
            writtenChunks.push(chunk);
          },
        });
        const elapsed = Date.now() - start;
        const writtenSize = writtenChunks.reduce((sum, c) => sum + c.byteLength, 0);
        const pass =
          result.blob === null &&
          result.status === 200 &&
          writtenSize === 256 * 1024 &&
          chunkCount > 1;
        record(
          "m7",
          "M7: 流式下载",
          "G. 文件下载",
          pass,
          "blob=null, 写盘=262144B, chunk>1",
          `blob=${result.blob === null ? "null" : "非null"}, 写盘=${writtenSize}B, chunks=${chunkCount}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "m7",
          "M7: 流式下载",
          "G. 文件下载",
          false,
          "blob=null, 写盘=262144B",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "m11",
    name: "M11: fetch 注入验证（createNet({ fetch })）",
    category: "G. 文件下载",
    run: async () => {
      let callCount = 0;
      let capturedUrl = "";
      const mockFetch: typeof fetch = async (input, _init) => {
        callCount++;
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        capturedUrl = url;
        const mockBody = JSON.stringify({
          code: 0,
          data: { id: "mock-001", source: "mock-fetch" },
        });
        return new Response(mockBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };
      const start = Date.now();
      try {
        const { createNet, AuthService } = await import("@xapiforge/core");
        const mockAuth = new AuthService({
          tokenStore: { get: async () => "mock-token", set: async () => {}, clear: async () => {} },
          authRefresher: { refresh: async () => "mock-token-refreshed" },
          onAuthFailed: () => {},
        });
        const mockApi = createNet<Record<string, never>>({
          baseURL: "https://mock.example.com",
          authService: mockAuth,
          middleware: [],
          fetch: mockFetch,
        });
        const result = await (
          mockApi as unknown as {
            request: (m: string, p: string) => Promise<{ data: { data: { source: string } } }>;
          }
        ).request("get", "/api/test/mock-user");
        const elapsed = Date.now() - start;
        const pass = callCount === 1 && result.data?.data?.source === "mock-fetch";
        record(
          "m11",
          "M11: fetch 注入验证",
          "G. 文件下载",
          pass,
          "mock fetch 调用 1 次, source='mock-fetch'",
          `callCount=${callCount}, source=${result.data?.data?.source}`,
          `URL: ${capturedUrl}`,
          elapsed,
        );
      } catch (e) {
        record(
          "m11",
          "M11: fetch 注入验证",
          "G. 文件下载",
          false,
          "mock fetch 调用 1 次",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },

  // ════════════ H. 后端错误格式 ════════════
  {
    id: "i1",
    name: "I1: RFC 7807 Problem Details（400）",
    category: "H. 后端错误格式",
    run: async () => {
      const start = Date.now();
      try {
        const res = await api.http.request({ method: "GET", path: "/api/test/rfc7807" });
        const elapsed = Date.now() - start;
        const json = JSON.parse(res.bodyText || "{}");
        const pass = res.status === 400 && json.type && json.title && json.status === 400;
        record(
          "i1",
          "I1: RFC 7807",
          "H. 后端错误格式",
          pass,
          "status=400, {type, title, status:400}",
          `status=${res.status}, title=${json.title}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "i1",
          "I1: RFC 7807",
          "H. 后端错误格式",
          false,
          "status=400",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "i2",
    name: "I2: 微信风格（200 + errcode）",
    category: "H. 后端错误格式",
    run: async () => {
      const start = Date.now();
      try {
        const payload = await api.request<{ errcode: number; errmsg: string }>(
          "/api/test/wechat-error",
        );
        const elapsed = Date.now() - start;
        const pass = payload.errcode === 42001 && payload.errmsg.includes("access_token");
        record(
          "i2",
          "I2: 微信风格",
          "H. 后端错误格式",
          pass,
          "errcode=42001, errmsg 含 access_token",
          `errcode=${payload.errcode}, errmsg=${payload.errmsg}`,
          undefined,
          elapsed,
        );
      } catch (e) {
        record(
          "i2",
          "I2: 微信风格",
          "H. 后端错误格式",
          false,
          "errcode=42001",
          `失败: ${(e as Error).message}`,
          undefined,
          Date.now() - start,
        );
      }
    },
  },
  {
    id: "biz500",
    name: "L4.8: request 保留 200 业务错误 envelope",
    category: "H. 后端错误格式",
    run: async () => {
      const start = Date.now();
      try {
        // api.request 不走业务 envelope middleware；HTTP 200 的业务错误 envelope 应原样返回。
        const payload = await api.request<{ code?: number; message?: string }>(
          "/api/test/biz-code-500",
        );
        const pass = payload.code === 500 && payload.message === "业务错误：库存不足";
        record(
          "biz500",
          "L4.8: request 保留业务 envelope",
          "H. 后端错误格式",
          pass,
          "HTTP 200 不抛 ApiError，返回原始 envelope(code=500)",
          `code=${payload.code}, message=${payload.message}`,
          undefined,
          Date.now() - start,
        );
      } catch (e) {
        const elapsed = Date.now() - start;
        const err = e instanceof Error ? e : new Error(String(e));
        record(
          "biz500",
          "L4.8: request 保留业务 envelope",
          "H. 后端错误格式",
          false,
          "HTTP 200 不抛 ApiError，返回原始 envelope(code=500)",
          `失败: ${err.constructor.name}: ${err.message}`,
          undefined,
          elapsed,
        );
      }
    },
  },
];

// ─── 执行 ───────────────────────────────────────────────────

async function runOne(s: Scenario): Promise<void> {
  currentScenario.value = s.name;
  results[s.id] = {
    id: s.id,
    name: s.name,
    category: s.category,
    pass: false,
    expected: "执行中...",
    actual: "",
    timingMs: 0,
    status: "running",
  };
  try {
    await s.run();
  } catch (e) {
    // 场景本身抛未捕获异常
    record(
      s.id,
      s.name,
      s.category,
      false,
      "场景执行完成",
      `场景异常: ${(e as Error).message}`,
      undefined,
      0,
    );
  }
}

async function runAll(): Promise<void> {
  if (running.value) return;
  running.value = true;
  // 清空旧结果
  for (const key of Object.keys(results)) {
    delete results[key];
  }
  summary.value = { passed: 0, failed: 0, total: 0 };

  // 确保初始状态：有效 token
  restoreToken();

  for (const s of scenarios) {
    await runOne(s);
    // 每个场景后恢复 token（避免上一个场景改了 token 影响下一个）
    restoreToken();
    // 更新汇总
    const r = results[s.id];
    if (r) {
      summary.value.total++;
      if (r.pass) summary.value.passed++;
      else summary.value.failed++;
    }
  }
  currentScenario.value = "";
  running.value = false;
}

async function runSingle(s: Scenario): Promise<void> {
  if (running.value) return;
  running.value = true;
  restoreToken();
  await runOne(s);
  restoreToken();
  // 更新汇总（重新计算全部）
  let passed = 0,
    failed = 0,
    total = 0;
  for (const s2 of scenarios) {
    const r = results[s2.id];
    if (r && r.status === "done") {
      total++;
      if (r.pass) passed++;
      else failed++;
    }
  }
  summary.value = { passed, failed, total };
  running.value = false;
}

function restoreAndStay(): void {
  restoreToken();
}

function logout(): void {
  localStorage.removeItem("app_token");
  localStorage.removeItem("app_refresh_token");
  void router.push("/login");
}

// 按分类分组
function getCategories(): string[] {
  return [...new Set(scenarios.map((s) => s.category))];
}

function getScenariosByCategory(cat: string): Scenario[] {
  return scenarios.filter((s) => s.category === cat);
}
</script>

<template>
  <div class="verification">
    <header>
      <h1>@xapiforge/core 功能验证</h1>
      <div class="nav">
        <span class="token-display">
          当前 token: <code>{{ currentToken }}</code>
        </span>
        <button class="btn-restore" @click="restoreAndStay" :disabled="running">恢复 token</button>
        <button class="btn-logout" @click="logout">退出登录</button>
      </div>
    </header>

    <div
      class="summary-bar"
      :class="{ allPass: summary.failed === 0 && summary.total > 0, hasFail: summary.failed > 0 }"
    >
      <div class="summary-stats">
        <span class="stat total">总计 {{ summary.total }}</span>
        <span class="stat pass">✓ 通过 {{ summary.passed }}</span>
        <span class="stat fail">✗ 失败 {{ summary.failed }}</span>
      </div>
      <button class="btn-run-all" @click="runAll" :disabled="running">
        {{ running ? `运行中: ${currentScenario}` : "▶ Run All" }}
      </button>
    </div>

    <p v-if="summary.total === 0" class="hint">
      点击 <strong>Run All</strong> 跑全部 {{ scenarios.length }} 个场景。<br />
      每个场景有自动断言（pass/fail），可作回归测试用。<br />
      前置条件：mock-server 已启动（pnpm mock）+ 已登录。
    </p>

    <!-- ════════════ 按分类展示 ════════════ -->
    <section v-for="cat in getCategories()" :key="cat" class="category">
      <h2>
        {{ cat }} <span class="cat-count">({{ getScenariosByCategory(cat).length }})</span>
      </h2>
      <div
        v-for="s in getScenariosByCategory(cat)"
        :key="s.id"
        class="scenario-row"
        :class="results[s.id]?.status"
      >
        <div class="scenario-header">
          <button class="btn-run-one" @click="runSingle(s)" :disabled="running">▶</button>
          <span class="scenario-name">{{ s.name }}</span>
          <span
            v-if="results[s.id]?.status === 'done'"
            class="badge"
            :class="results[s.id]?.pass ? 'pass' : 'fail'"
          >
            {{ results[s.id]?.pass ? "✓ PASS" : "✗ FAIL" }}
          </span>
          <span v-if="results[s.id]?.status === 'done'" class="timing"
            >{{ results[s.id]?.timingMs }}ms</span
          >
          <span v-if="results[s.id]?.status === 'running'" class="running-indicator"
            >⏳ 运行中...</span
          >
        </div>
        <div v-if="results[s.id]?.status === 'done'" class="scenario-detail">
          <div class="detail-row">
            <span class="label">预期:</span>
            <span class="value expected">{{ results[s.id]?.expected }}</span>
          </div>
          <div class="detail-row">
            <span class="label">实际:</span>
            <span class="value actual" :class="results[s.id]?.pass ? 'pass' : 'fail'">{{
              results[s.id]?.actual
            }}</span>
          </div>
          <div v-if="results[s.id]?.detail" class="detail-row">
            <span class="label">详情:</span>
            <span class="value detail">{{ results[s.id]?.detail }}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.verification {
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 2px solid #e0e0e0;
}

header h1 {
  margin: 0;
  font-size: 22px;
}

.nav {
  display: flex;
  align-items: center;
  gap: 12px;
}

.token-display {
  font-size: 12px;
  color: #666;
}

.token-display code {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.btn-restore,
.btn-logout {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}

.btn-logout {
  color: #c00;
}

.summary-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-radius: 8px;
  background: #f5f5f5;
  margin-bottom: 24px;
  border: 2px solid #e0e0e0;
}

.summary-bar.allPass {
  background: #e8f5e9;
  border-color: #4caf50;
}

.summary-bar.hasFail {
  background: #ffebee;
  border-color: #f44336;
}

.summary-stats {
  display: flex;
  gap: 20px;
  font-size: 16px;
  font-weight: bold;
}

.stat.pass {
  color: #2e7d32;
}
.stat.fail {
  color: #c62828;
}
.stat.total {
  color: #333;
}

.btn-run-all {
  padding: 10px 24px;
  font-size: 16px;
  font-weight: bold;
  border: none;
  border-radius: 6px;
  background: #1976d2;
  color: white;
  cursor: pointer;
}

.btn-run-all:disabled {
  background: #90caf9;
  cursor: not-allowed;
}

.hint {
  padding: 16px;
  background: #fff3e0;
  border-radius: 6px;
  color: #e65100;
  line-height: 1.8;
}

.category {
  margin-bottom: 28px;
}

.category h2 {
  font-size: 16px;
  border-bottom: 1px solid #ddd;
  padding-bottom: 6px;
  margin-bottom: 8px;
}

.cat-count {
  color: #888;
  font-size: 13px;
  font-weight: normal;
}

.scenario-row {
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 4px;
  transition: background 0.2s;
}

.scenario-row.done {
  background: #fafafa;
}

.scenario-row.running {
  background: #fff3e0;
}

.scenario-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-run-one {
  padding: 2px 8px;
  border: 1px solid #ccc;
  border-radius: 3px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
}

.btn-run-one:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.scenario-name {
  flex: 1;
  font-size: 14px;
}

.badge {
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: bold;
}

.badge.pass {
  background: #c8e6c9;
  color: #2e7d32;
}

.badge.fail {
  background: #ffcdd2;
  color: #c62828;
}

.timing {
  font-size: 12px;
  color: #888;
  min-width: 50px;
  text-align: right;
}

.running-indicator {
  font-size: 12px;
  color: #e65100;
}

.scenario-detail {
  margin-top: 6px;
  margin-left: 34px;
  padding: 8px 12px;
  background: #fff;
  border-radius: 4px;
  border: 1px solid #eee;
}

.detail-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 13px;
}

.label {
  min-width: 40px;
  color: #888;
  font-weight: bold;
}

.value {
  flex: 1;
  word-break: break-all;
}

.value.expected {
  color: #555;
}

.value.actual.pass {
  color: #2e7d32;
}

.value.actual.fail {
  color: #c62828;
}

.value.detail {
  color: #666;
  font-family: monospace;
  font-size: 12px;
}
</style>
