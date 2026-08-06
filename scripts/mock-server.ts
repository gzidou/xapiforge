/**
 * Demo mock server —— 用来把 examples/demo-app 跑起来验证整链路。
 *
 * 覆盖 8 个 demo-app demo endpoint + /connect/token（OAuth2 password + refresh_token）。
 *
 * 真后端在 localhost（private network），开发期在外用这个 mock 顶替：
 *   pnpm mock          # 启动后台
 *   pnpm mock:stop     # 关
 *   cat /tmp/demo-mock.pid
 *
 * 数据格式严格按 Demo ABP 风格：{ code: 0, data: ..., message: null }。
 * v0.2：envelope 解包由业务侧 middleware（createAbpUnwrapMw）处理，mock 只管返 JSON。
 *
 * 端点（精确对照 examples/demo-app/src/views/Home.vue）：
 *   POST   /connect/token                          password / refresh_token
 *   GET    /api/auth/biz-code-expired             业务 200 鉴权码演示（40001）
 *   GET    /api/identity/users                     分页列表
 *   GET    /api/identity/users/{id}                详情
 *   POST   /api/identity/users                     创建
 *   PUT    /api/identity/users/{id}                更新（全量）
 *   DELETE /api/identity/users/{id}                删除
 *   GET    /api/identity/users/{id}/roles          子资源
 *   GET    /api/infrastructure/appManagement       复杂 query
 *   POST   /api/fileService/fileEntity/uploading   multipart upload
 *
 * 401 触发：把 Authorization 头置 "Bearer expired" → 返回 401。
 *             v0.2：auth middleware 捕获 401 → AuthService.refreshIfNeeded → 重试。
 * 业务 200 鉴权码触发：Authorization = "Bearer biz-code-expired" →
 *             返回 HTTP 200 + body {code: 40001, msg: "token expired"}。
 *             v0.2：AbpUnwrapMw 检测 code ∈ ABP_AUTH_CODES → 触发 refresh。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { Buffer } from "node:buffer";

const PORT = 8787;
const PID_FILE = "/tmp/demo-mock.pid";

// ---------- in-memory store ----------

interface User {
  id: string;
  userName: string;
  name: string | null;
  surname: string | null;
  email: string;
  phoneNumber: string | null;
  isActive: boolean;
  creationTime: string;
}

const users: User[] = [
  {
    id: "u-001",
    userName: "admin",
    name: "管理员",
    surname: null,
    email: "admin@demo.local",
    phoneNumber: "+8613800000001",
    isActive: true,
    creationTime: "2026-01-01T00:00:00Z",
  },
  {
    id: "u-002",
    userName: "operator",
    name: "操作员",
    surname: "李",
    email: "ops@demo.local",
    phoneNumber: "+8613800000002",
    isActive: true,
    creationTime: "2026-02-15T08:30:00Z",
  },
];

let nextId = 3;

// ---------- 响应包装（Demo ABP 风格） ----------

function biz<T>(data: T): string {
  return JSON.stringify({ code: 0, data, message: null });
}

function bizError(code: number, msg: string): string {
  return JSON.stringify({ code, data: null, message: msg });
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "application/json",
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    // Expose 自定义 header 让浏览器 JS 能读（Retry-After / Content-Disposition 等）
    "Access-Control-Expose-Headers": "Retry-After, Content-Disposition, Content-Length",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- token / auth ----------

const KNOWN_TOKENS = new Set(["mock-token", "refreshed-token"]);

/**
 * refresh_token grant 调用计数（并发单飞验证用）。
 * demo-app 并发 401 场景发 5 个请求 → auth-mw 单飞 → 只应调 1 次。
 * /api/test/refresh-count 返回当前计数，/api/test/refresh-count-reset 清零。
 */
let refreshCallCount = 0;

function isExpiredToken(req: IncomingMessage): boolean {
  const auth = req.headers["authorization"] ?? "";
  return auth === "Bearer expired";
}

/**
 * 业务 200 鉴权码触发：Authorization = "Bearer biz-code-expired"。
 *
 * 演示"业务 200 + envelope {code: 40001, ...}" 场景 —— 后端不返 HTTP 401，
 * 把鉴权失败塞进业务 envelope。验证 NetConfig.isAuthError 业务覆盖场景。
 */
function isBizCodeExpired(req: IncomingMessage): boolean {
  const auth = req.headers["authorization"] ?? "";
  return auth === "Bearer biz-code-expired";
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers["authorization"] ?? "";
  // 调试日志：返回 false 时打出来 (含 header 字段)
  if (!auth.startsWith("Bearer ")) {
    console.log(
      `[demo-mock-debug]   isAuthorized=false (no Bearer prefix): ${JSON.stringify(auth)}`,
    );
    return false;
  }
  const t = auth.slice("Bearer ".length);
  if (!KNOWN_TOKENS.has(t)) {
    console.log(
      `[demo-mock-debug]   isAuthorized=false (token not in KNOWN_TOKENS: ${t.slice(0, 20)})`,
    );
    return false;
  }
  return true;
}

// ---------- 业务 handler（按是否调 readBody 拆 sync / async） ----------

interface AppManagementItem {
  id: string;
  name: string;
  platform: string;
  remark: string | null;
  creationTime: string;
}

const appList: AppManagementItem[] = [
  {
    id: "app-001",
    name: "demo-monitor",
    platform: "Android",
    remark: null,
    creationTime: "2026-01-10T00:00:00Z",
  },
  {
    id: "app-002",
    name: "demo-patrol",
    platform: "Android",
    remark: "巡查 App",
    creationTime: "2026-01-12T00:00:00Z",
  },
  {
    id: "app-003",
    name: "demo-web",
    platform: "Iso",
    remark: "Web 管理端",
    creationTime: "2026-01-15T00:00:00Z",
  },
];

async function handleConnectToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type") ?? "";

  if (grantType === "password") {
    const user = params.get("username") ?? "";
    const pass = params.get("password") ?? "";
    if (!user || !pass) {
      send(
        res,
        400,
        JSON.stringify({ error: "invalid_grant", error_description: "missing credentials" }),
      );
      return;
    }
    send(
      res,
      200,
      JSON.stringify({
        access_token: "mock-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "mock-refresh-token",
      }),
    );
    return;
  }
  if (grantType === "refresh_token") {
    const rt = params.get("refresh_token") ?? "";
    if (!rt) {
      send(res, 400, JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    refreshCallCount++; // 并发单飞验证：计数 refresh 调用次数
    send(
      res,
      200,
      JSON.stringify({
        access_token: "refreshed-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "new-mock-refresh-token",
      }),
    );
    return;
  }
  send(res, 400, JSON.stringify({ error: "unsupported_grant_type" }));
}

function handleUsersGet(req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const skip = Number(url.searchParams.get("SkipCount") ?? 0);
  const max = Number(url.searchParams.get("MaxResultCount") ?? 10);
  const filter = url.searchParams.get("Filter") ?? "";
  const filtered = filter ? users.filter((u) => u.userName.includes(filter)) : users;
  const slice = filtered.slice(skip, skip + max);
  send(res, 200, biz({ items: slice, totalCount: filtered.length }));
}

function handleUserGetOne(req: IncomingMessage, res: ServerResponse, id: string): void {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const user = users.find((u) => u.id === id);
  if (!user) {
    send(res, 404, bizError(404, `user not found: ${id}`));
    return;
  }
  send(res, 200, biz(user));
}

async function handleUserPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const body = await readBody(req);
  const input = JSON.parse(body) as { userName?: string; email?: string };
  const created: User = {
    id: `u-${String(nextId++).padStart(3, "0")}`,
    userName: input.userName ?? "new-user",
    name: null,
    surname: null,
    email: input.email ?? "new@demo.local",
    phoneNumber: null,
    isActive: true,
    creationTime: new Date().toISOString(),
  };
  users.push(created);
  send(res, 200, biz(created));
}

async function handleUserPut(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) {
    send(res, 404, bizError(404, `user not found: ${id}`));
    return;
  }
  const body = await readBody(req);
  const input = JSON.parse(body) as Partial<User>;
  users[idx] = { ...users[idx]!, ...input, id };
  send(res, 200, biz(users[idx]));
}

function handleUserDelete(req: IncomingMessage, res: ServerResponse, id: string): void {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) {
    send(res, 404, bizError(404, `user not found: ${id}`));
    return;
  }
  users.splice(idx, 1);
  send(res, 204, "");
}

function handleUserRolesGet(req: IncomingMessage, res: ServerResponse, id: string): void {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const user = users.find((u) => u.id === id);
  if (!user) {
    send(res, 404, bizError(404, `user not found: ${id}`));
    return;
  }
  send(res, 200, biz({ items: [{ name: "admin" }, { name: "user" }], totalCount: 2 }));
}

function handleAppManagementGet(req: IncomingMessage, res: ServerResponse): void {
  if (isExpiredToken(req)) {
    send(res, 401, bizError(401, "expired"));
    return;
  }
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const skip = Number(url.searchParams.get("SkipCount") ?? 0);
  const max = Number(url.searchParams.get("MaxResultCount") ?? 10);
  send(res, 200, biz({ items: appList.slice(skip, skip + max), totalCount: appList.length }));
}

async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  const ctype = req.headers["content-type"] ?? "";
  if (!ctype.includes("multipart/form-data")) {
    send(res, 400, bizError(400, "expected multipart/form-data"));
    return;
  }
  const len = Number(req.headers["content-length"] ?? 0);
  await readBody(req);
  // 严格按 Demo.FileService.FileEntityDto 形状返（一项一组文件 → 真后端返数组）
  send(
    res,
    200,
    biz([
      {
        id: `f-${Date.now()}`,
        name: "uploaded.bin",
        filePath: "/files/uploaded.bin",
        fileExt: ".bin",
        fileSize: String(len),
        md5: "00000000000000000000000000000000",
        belongsSystem: "demo",
        company: null,
        department: null,
        isFileDelete: false,
        thumbnail: null,
      },
    ]),
  );
}

function handleWeatherGet(req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthorized(req)) {
    send(res, 401, JSON.stringify({ ok: false, err: { code: 401, msg: "Unauthorized" } }));
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const city = url.searchParams.get("city") ?? "北京";

  send(
    res,
    200,
    JSON.stringify({
      ok: true,
      data: {
        city,
        tempC: 18 + Math.floor(Math.random() * 5),
        humidity: 60 + Math.floor(Math.random() * 20),
        wind: "NE",
        observedAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * /api/3rd/exotic —— 偏离 envelope 风格（演示 per-call unwrap override）
 *
 * 服务器返回：{ code:200, data:{...}, msg:"ok" }
 * 业务侧 createUnwrapResponseMw(p => p.data ?? p) 来覆盖默认 unwrap。
 */
function handleExoticGet(req: IncomingMessage, res: ServerResponse): void {
  if (!isAuthorized(req)) {
    send(res, 401, JSON.stringify({ code: 401, data: null, msg: "Unauthorized" }));
    return;
  }
  send(
    res,
    200,
    JSON.stringify({
      code: 200,
      data: {
        id: "ex-1",
        items: ["alpha", "beta", "gamma"],
        observedAt: new Date().toISOString(),
      },
      msg: "ok",
    }),
  );
}

/**
 * 演示 endpoint：业务 200 鉴权码场景。
 *
 *   curl -H "Authorization: Bearer biz-code-expired" http://localhost:8787/api/auth/biz-code-expired
 *   → HTTP 200 + {code: 40001, data: null, msg: "token expired"}
 *
 *   curl -H "Authorization: Bearer mock-token" http://localhost:8787/api/auth/biz-code-expired
 *   → HTTP 200 + {code: 0, data: {ok: true}, message: null}
 *
 * 业务侧 AbpUnwrapMw 检测 code ∈ ABP_AUTH_CODES → 触发 refresh + 重试。
 * refresh 失败 → AuthService 调 onAuthFailed → 跳登录。
 */
function handleBizCodeExpired(req: IncomingMessage, res: ServerResponse): void {
  if (isBizCodeExpired(req)) {
    send(res, 200, bizError(40001, "token expired"));
    return;
  }
  if (!isAuthorized(req)) {
    send(res, 401, bizError(401, "Unauthorized"));
    return;
  }
  send(res, 200, biz({ ok: true, checked: "biz-code-expired path" }));
}

// ---------- 测试场景端点（/api/test/*） ----------
//
// 为 SCENARIOS.md 系统验证提供后端。每个端点对应一个或多个场景编号。
// 不需要鉴权（除非显式测试 401），简化测试逻辑。

/**
 * 统一测试端点路由。
 *
 * 端点列表（对应 SCENARIOS.md 编号）：
 *   GET /api/test/429-with-retry-after       A17  429 + Retry-After: 1
 *   GET /api/test/429-no-retry-after         A17  429 无 header
 *   GET /api/test/500-html                   A18  500 + HTML body
 *   GET /api/test/500-json                   A19  500 + JSON envelope
 *   GET /api/test/503                        A20  503 + JSON
 *   GET /api/test/204                        A21  204 No Content
 *   GET /api/test/200-empty                  A22  200 + 空 body
 *   GET /api/test/200-non-json-text          B10  200 + 纯文本（Content-Type: application/json）
 *   GET /api/test/bom                        B11  body 含 BOM
 *   GET /api/test/redirect-to-users          B23  302 → /api/identity/users
 *   GET /api/test/slow?ms=2000               B4   延迟响应（测超时）
 *   GET /api/test/c1-data-string             C1   {code:0, data:"https://file.url"}
 *   GET /api/test/c2-data-array              C2   {code:0, data:[{...}]}
 *   GET /api/test/c3-data-paged              C3   {code:0, data:{items, totalCount}}
 *   GET /api/test/c4-data-null               C4   {code:0, data:null}
 *   GET /api/test/c5-no-msg                  C5   {code:0, data:{...}}（无 message）
 *   GET /api/test/c6-code-string             C6   {code:"0", data:{...}}
 *   GET /api/test/c7-code-bool               C7   {success:true, data:{...}}
 *   GET /api/test/c8-both-code-status        C8   {code:0, status:"ok", data:{...}}
 *   GET /api/test/c9-array-root              C9   [{...},{...}]
 *   GET /api/test/c10-nested                 C10  {result:{inner:{code:0, data:{...}}}}
 *   GET /api/test/biz-code-500               C/L4.8 业务 code 非 0 非 auth code
 *   GET /api/test/auth-401                   A16  401（触发 auth-mw refresh + retry）
 *   GET /api/test/auth-403                   A16  403（不 refresh）
 */
function handleTestEndpoint(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const scenario = path.replace(/^\/api\/test\//, "");

  // 通用：所有 /api/test/* 不需要鉴权（除显式 401/403 测试）

  switch (scenario) {
    // ── A17 429 退避 ──
    case "429-with-retry-after": {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Expose-Headers": "Retry-After",
        "Retry-After": "1",
      });
      res.end(bizError(429, "Too Many Requests"));
      return;
    }
    case "429-no-retry-after": {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end(bizError(429, "Too Many Requests"));
      return;
    }

    // ── A18/A19/A20 5xx ──
    case "500-html": {
      const html = "<html><body><h1>500 Internal Server Error</h1></body></html>";
      res.writeHead(500, {
        "Content-Type": "text/html",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end(html);
      return;
    }
    case "500-json": {
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end(bizError(500, "Internal Server Error"));
      return;
    }
    case "503": {
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end(JSON.stringify({ message: "Service Unavailable" }));
      return;
    }

    // ── A21/A22 空响应 ──
    case "204": {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }
    case "200-empty": {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end("");
      return;
    }

    // ── B10 Content-Type 与 body 不匹配 ──
    case "200-non-json-text": {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end("this is not json but content-type says json");
      return;
    }

    // ── B11 BOM ──
    case "bom": {
      const body = "\uFEFF" + biz({ ok: true, bom: true });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end(body);
      return;
    }

    // ── B23 重定向 ──
    case "redirect-to-users": {
      res.writeHead(302, {
        Location: "/api/identity/users",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    // ── B4 慢响应（?ms=N 延迟）──
    case "slow": {
      const ms = Number(url.searchParams.get("ms") ?? "1000");
      setTimeout(() => {
        send(res, 200, biz({ ok: true, delayed: ms }));
      }, ms);
      return;
    }

    // ── C1-C10 envelope 变体 ──
    case "c1-data-string":
      send(res, 200, JSON.stringify({ code: 0, data: "https://file.url" }));
      return;
    case "c2-data-array":
      send(res, 200, JSON.stringify({ code: 0, data: [{ id: 1 }, { id: 2 }] }));
      return;
    case "c3-data-paged":
      send(
        res,
        200,
        JSON.stringify({ code: 0, data: { items: [{ id: 1 }, { id: 2 }], totalCount: 2 } }),
      );
      return;
    case "c4-data-null":
      send(res, 200, JSON.stringify({ code: 0, data: null }));
      return;
    case "c5-no-msg":
      send(res, 200, JSON.stringify({ code: 0, data: { id: 1, name: "x" } }));
      return;
    case "c6-code-string":
      send(res, 200, JSON.stringify({ code: "0", data: { id: 1, name: "x" } }));
      return;
    case "c7-code-bool":
      send(res, 200, JSON.stringify({ success: true, data: { id: 1, name: "x" } }));
      return;
    case "c8-both-code-status":
      send(res, 200, JSON.stringify({ code: 0, status: "ok", data: { id: 1, name: "x" } }));
      return;
    case "c9-array-root":
      send(res, 200, JSON.stringify([{ id: 1 }, { id: 2 }]));
      return;
    case "c10-nested":
      send(
        res,
        200,
        JSON.stringify({ result: { inner: { code: 0, data: { id: 1, name: "x" } } } }),
      );
      return;

    // ── L4.8 业务 code 非 0 非 auth code ──
    case "biz-code-500":
      send(res, 200, bizError(500, "业务错误：库存不足"));
      return;

    // ── A16 鉴权失败 ──
    case "auth-401":
      send(res, 401, bizError(401, "Unauthorized"));
      return;
    case "auth-403":
      send(res, 403, bizError(403, "Forbidden"));
      return;

    // ── 并发单飞验证：refresh 调用计数 ──
    case "refresh-count":
      send(res, 200, JSON.stringify({ count: refreshCallCount }));
      return;
    case "refresh-count-reset":
      refreshCallCount = 0;
      send(res, 200, JSON.stringify({ count: 0 }));
      return;

    // ── B19 文件下载（二进制 + Content-Disposition）──
    // M3: expired-token → 401 → refresh → 200（auth 走内核）
    case "download": {
      // 检查 token：expired-token 返 401（测 auth retry）
      const authHeader = req.headers["authorization"];
      const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/, "") : "";
      if (token === "expired-token") {
        send(res, 401, bizError(401, "Unauthorized"));
        return;
      }
      // 1KB 二进制
      const buf = Buffer.alloc(1024, 0xab);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="test.bin"',
        "Content-Length": String(buf.length),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        // CORS：不显式 expose 的话浏览器 JS 拿不到 Content-Disposition / Content-Length
        // （只有 simple response headers 默认暴露：Cache-Control / Content-Language /
        //  Content-Type / Expires / Last-Modified / Pragma）
        "Access-Control-Expose-Headers": "Retry-After, Content-Disposition, Content-Length",
      });
      res.end(buf);
      return;
    }

    // ── M1 大文件下载（限速，测进度回调）──
    // 总大小 256KB，分 16 个 16KB chunk 发送，每 chunk 间隔 20ms
    // 浏览器 onProgress 会收到 16 次回调（每 16KB 一次）
    case "download-large": {
      const totalSize = 256 * 1024; // 256KB
      const chunkSize = 16 * 1024; // 16KB
      const delayMs = 20; // 每 chunk 间隔 20ms
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="large-test.bin"',
        "Content-Length": String(totalSize),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Expose-Headers": "Retry-After, Content-Disposition, Content-Length",
      });
      // 限速发送：每 chunkSize 字节停一下
      const buf = Buffer.alloc(chunkSize, 0xcd);
      const chunksToSend = Math.floor(totalSize / chunkSize);
      let sent = 0;
      const sendChunk = (): void => {
        if (sent >= chunksToSend) {
          res.end();
          return;
        }
        res.write(buf);
        sent++;
        setTimeout(sendChunk, delayMs);
      };
      sendChunk();
      return;
    }

    // ── M2 断点续传（Range 请求支持，返 206 Partial Content）──
    // 总大小 64KB，支持 Range: bytes=start-end
    case "download-resumable": {
      const totalSize = 64 * 1024; // 64KB
      const range = req.headers["range"];
      if (typeof range === "string") {
        // 解析 Range: bytes=start-end
        const match = /bytes=(\d+)-(\d*)/.exec(range);
        if (match?.[1]) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
          const length = end - start + 1;
          const buf = Buffer.alloc(length, 0xef);
          res.writeHead(206, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="resumable-test.bin"',
            "Content-Length": String(length),
            "Content-Range": `bytes ${start}-${end}/${totalSize}`,
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
            "Access-Control-Expose-Headers":
              "Retry-After, Content-Disposition, Content-Length, Content-Range",
          });
          res.end(buf);
          return;
        }
      }
      // 无 Range → 返完整文件
      const buf = Buffer.alloc(totalSize, 0xef);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="resumable-test.bin"',
        "Content-Length": String(totalSize),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
        "Access-Control-Expose-Headers":
          "Retry-After, Content-Disposition, Content-Length, Content-Range, Accept-Ranges",
      });
      res.end(buf);
      return;
    }

    // ── M3 中文文件名下载（filename* UTF-8 encoded）──
    case "download-cn": {
      const buf = Buffer.alloc(512, 0xab);
      const filename = encodeURIComponent("测试文件.bin");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
        "Content-Length": String(buf.length),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Expose-Headers": "Retry-After, Content-Disposition, Content-Length",
      });
      res.end(buf);
      return;
    }

    // ───────────────────────────────────────────────────────────
    // 全面场景补齐：HTTP 错误状态码 + 不同错误格式 + 特殊响应
    // ───────────────────────────────────────────────────────────

    // ── G. HTTP 4xx 错误 ──

    // G1: 400 + 验证错误（字段级）
    case "400-validation": {
      send(
        res,
        400,
        JSON.stringify({
          errors: [
            { field: "name", message: "name is required" },
            { field: "email", message: "invalid email format" },
          ],
        }),
      );
      return;
    }

    // G2: 404 Not Found
    case "404-not-found": {
      send(res, 404, JSON.stringify({ code: 404, message: "Resource not found" }));
      return;
    }

    // G3: 413 Payload Too Large（空 body）
    case "413-payload-too-large": {
      res.writeHead(413, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    // G4: 422 Unprocessable Entity
    case "422-unprocessable": {
      send(
        res,
        422,
        JSON.stringify({
          title: "Validation failed",
          errors: [{ field: "age", message: "must be positive" }],
        }),
      );
      return;
    }

    // ── H. 5xx 服务端错误 ──

    // H1: 500 + 空 body（网关返回空响应）
    case "500-empty": {
      res.writeHead(500, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    // H2: 502 + 空 body
    case "502-empty": {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    // H3: 503 + Retry-After header
    case "503-retry": {
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "2",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Expose-Headers": "Retry-After",
      });
      res.end(JSON.stringify({ message: "Service temporarily unavailable" }));
      return;
    }

    // ── I. 不同后端错误格式 ──

    // I1: RFC 7807 Problem Details
    case "rfc7807": {
      send(
        res,
        400,
        JSON.stringify({
          type: "https://example.com/errors/invalid-request",
          title: "Invalid request parameters",
          status: 400,
          detail: "The 'name' field must not be empty",
          instance: "/api/test/rfc7807",
        }),
      );
      return;
    }

    // I2: 微信风格（200 + errcode/errmsg）
    case "wechat-error": {
      send(
        res,
        200,
        JSON.stringify({
          errcode: 42001,
          errmsg: "access_token expired",
        }),
      );
      return;
    }

    // I3: OAuth 错误（400 + error/error_description）
    case "oauth-error": {
      send(
        res,
        400,
        JSON.stringify({
          error: "invalid_grant",
          error_description: "The refresh token is invalid or expired.",
        }),
      );
      return;
    }

    // I4: 自研 A（200 + ok/err）
    case "custom-a": {
      send(
        res,
        200,
        JSON.stringify({
          ok: false,
          err: { code: 500, msg: "Internal service error" },
        }),
      );
      return;
    }

    // I5: 自研 B（200 + success/error）
    case "custom-b": {
      send(
        res,
        200,
        JSON.stringify({
          success: false,
          error: { code: "NOT_FOUND", detail: "User not found" },
        }),
      );
      return;
    }

    // ── J. 特殊响应 ──

    // J1: 纯文本错误（500 + text/plain）
    case "plain-text-error": {
      send(res, 500, "Internal Server Error: database connection lost", "text/plain");
      return;
    }

    // J2: 大响应体（1MB JSON）
    case "large-response": {
      const items = Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        description: `Description for item ${i} with some padding text to increase size`,
      }));
      send(res, 200, JSON.stringify({ code: 0, data: items, totalCount: 10000 }));
      return;
    }

    // J3: XML 错误（legacy SOAP）
    case "xml-error": {
      send(
        res,
        500,
        '<?xml version="1.0"?><error><code>500</code><message>SOAP fault</message></error>',
        "application/xml",
      );
      return;
    }

    default:
      send(res, 404, bizError(404, `unknown test scenario: ${scenario}`));
  }
}

/**
 * /connect/token 测试场景切换（?scenario=xxx）
 *
 * 场景：
 *   default          正常 password/refresh_token
 *   refresh-401      D2: refresh_token grant 返 401（refresh token 也过期）
 *   refresh-429      D3: refresh_token grant 返 429
 *   refresh-500      D4: refresh_token grant 返 500
 *   refresh-slow     D7: refresh_token grant 延迟 3s（触发 refreshTimeoutMs）
 */
async function handleConnectTokenScenario(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const scenario = url.searchParams.get("scenario");

  if (!scenario) return false; // 走默认 handleConnectToken

  const body = await readBody(req);
  const params = new URLSearchParams(body);
  const grantType = params.get("grant_type") ?? "";

  if (grantType !== "refresh_token") return false;

  switch (scenario) {
    case "refresh-401":
      send(
        res,
        401,
        JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }),
      );
      return true;
    case "refresh-429":
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Retry-After": "1",
      });
      res.end(JSON.stringify({ error: "too_many_requests" }));
      return true;
    case "refresh-500":
      send(res, 500, bizError(500, "refresh endpoint internal error"));
      return true;
    case "refresh-slow":
      await new Promise((resolve) => setTimeout(resolve, 3000));
      send(res, 200, JSON.stringify({ access_token: "slow-token", token_type: "Bearer" }));
      return true;
    default:
      return false;
  }
}

// ---------- router ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") {
      send(res, 204, "");
      return;
    }

    if (path === "/connect/token" && method === "POST") {
      // 测试场景切换（?scenario=refresh-401 等）→ 不消费则走默认
      if (await handleConnectTokenScenario(req, res)) return;
      await handleConnectToken(req, res);
      return;
    }

    // 测试场景端点（/api/test/*）— 不需要鉴权（除显式 401/403 测试）
    if (path.startsWith("/api/test/") && method === "GET") {
      handleTestEndpoint(req, res);
      return;
    }
    if (path === "/api/auth/biz-code-expired" && method === "GET") {
      handleBizCodeExpired(req, res);
      return;
    }
    if (path === "/api/identity/users" && method === "GET") {
      handleUsersGet(req, res);
      return;
    }
    if (path === "/api/identity/users" && method === "POST") {
      await handleUserPost(req, res);
      return;
    }

    const userIdMatch = path.match(/^\/api\/identity\/users\/([^/]+)$/);
    if (userIdMatch && method === "GET") {
      handleUserGetOne(req, res, userIdMatch[1]!);
      return;
    }
    if (userIdMatch && method === "PUT") {
      await handleUserPut(req, res, userIdMatch[1]!);
      return;
    }
    if (userIdMatch && method === "DELETE") {
      handleUserDelete(req, res, userIdMatch[1]!);
      return;
    }

    const rolesMatch = path.match(/^\/api\/identity\/users\/([^/]+)\/roles$/);
    if (rolesMatch && method === "GET") {
      handleUserRolesGet(req, res, rolesMatch[1]!);
      return;
    }

    if (path === "/api/infrastructure/appManagement" && method === "GET") {
      handleAppManagementGet(req, res);
      return;
    }
    if (path === "/api/fileService/fileEntity/uploading" && method === "POST") {
      await handleUpload(req, res);
      return;
    }
    if (path === "/api/3rd/weather" && method === "GET") {
      handleWeatherGet(req, res);
      return;
    }
    // 演示 endpoint 偏离 envelope：
    // 返回 { code:200, data:{...}, msg:"ok" } 而不是 ABP 的 {code:0, data, message:null}
    if (path === "/api/3rd/exotic" && method === "GET") {
      handleExoticGet(req, res);
      return;
    }

    send(res, 404, bizError(404, `not found: ${method} ${path}`));
  } catch (e) {
    console.error("handler error:", e);
    send(res, 500, bizError(500, (e as Error).message));
  }
}

const server = createServer((req, res) => {
  // 每个 request 一行 log（dev 时方便看是否到达 mock + 带什么 header）
  const auth = req.headers["authorization"] ?? "";
  const url = (req.url ?? "/").split("?")[0];
  console.log(
    `[demo-mock] ${req.method ?? "GET"} ${url}` +
      (auth ? ` [Authorization: ${auth.slice(0, 40)}]` : " [NO AUTH]"),
  );
  void route(req, res);
});

// ---------- start / stop ----------

function start(): void {
  writeFileSync(PID_FILE, String(process.pid));
  // 监听 0.0.0.0 让 IPv4 + IPv6 双栈客户端都能连（VS Code 内置浏览器是 IPv4 localhost）
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[demo-mock] listening on 0.0.0.0:${PORT}, pid=${process.pid}`);
    console.log(`[demo-mock] pid file: ${PID_FILE}`);
    console.log(`[demo-mock] try: curl -X POST http://localhost:${PORT}/connect/token \\`);
    console.log(
      `                  -d "username=admin&password=p&grant_type=password&client_id=Infrastructure_Web"`,
    );
  });
}

function shutdown(): void {
  console.log(`[demo-mock] shutting down...`);
  void unlink(PID_FILE).catch(() => undefined);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
