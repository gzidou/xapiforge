# 验证指南

本文记录仓库当前可重复执行的验证入口。提交前直接运行 `pnpm verify`；定位问题时再按下面的层级单独运行。

对应场景清单见 [scenarios.md](./scenarios.md)（97 个场景）和行为契约 [behavior-contract.md](./behavior-contract.md)。

---

## 两层验证体系

| 层级          | 范围                                              | 工具              | 命令                  | 自动化    |
| ------------- | ------------------------------------------------- | ----------------- | --------------------- | --------- |
| **L1 库层**   | HttpClient / AuthService / middleware / createNet | Node + tsx        | `pnpm test:scenarios` | ✅ 全自动 |
| **L2 端到端** | demo-app 页面 + 浏览器 + mock-server              | Playwright 或人工 | `pnpm test:demo-app`  | 半自动    |

**改代码后回归顺序**：L1 → （改了 demo-app 业务代码时）L2。

---

## L1：库层自动验证（首选，必跑）

**脚本**：[scripts/test/scenarios.ts](../../scripts/test/scenarios.ts)
**命令**：

```bash
pnpm test:scenarios
```

**特性**：

- 自动起停 mock-server（已运行则复用，未运行则拉子进程，跑完自动 kill）
- 直接 `import @xapiforge/core`，不依赖浏览器
- 9 个 Section 共 **222 个断言**；场景与断言不是一一对应，一个场景可能包含多个检查
- 覆盖：HttpClient HTTP 层 / middleware 单元 / AuthService 单飞+窗口 / C1-C10 envelope 变体 / 429 重试 / A14 业务 200 鉴权码 / A16+D2+D7 端到端鉴权 / B19 文件下载

**期望输出**：

```text
v0.2 场景验证开始
target: http://localhost:8787
[test] mock-server 未运行，自动拉起子进程...
[test] mock-server 已就绪

━━━ Section 1: HttpClient（HTTP 层）━━━
━━━ Section 2: middleware 单元测试 ━━━
━━━ Section 3: AuthService 单元测试 ━━━
━━━ Section 4: 业务 envelope 变体（C1-C10）━━━
━━━ Section 5: middleware 链 + retry loop ━━━
━━━ Section 6: A14 业务 200 鉴权码（库层）━━━
  → A14 库层完整链路通过 ✅
━━━ Section 7: 端到端鉴权（A16/D2/D7）+ B19 ━━━
  → A16 HTTP 401 → refresh → retry 端到端通过 ✅
  → D2 refresh 失败 → AuthError + onAuthFailed 端到端通过 ✅
  → D7 refresh 超时 → AuthError 端到端通过 ✅

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
━━━ Section 8: client.request 走内核（无 schema）━━━
━━━ Section 9: 文件下载走内核（progress + 文件名 + auth）━━━

✅ Passed: 222
❌ Failed: 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[test] 关闭 mock-server 子进程...
```

**exit code**：0 通过，1 有失败。CI 可直接用。

### 加新断言

在 `scripts/test/scenarios.ts` 对应 Section 加 `{ ... }` 块，用 `ok()` / `eq()` / `expectThrows()` 断言。mock-server 端点不够时，在 [scripts/mock-server.ts](../../scripts/mock-server.ts) 的 `handleTestEndpoint` switch 加 case。

---

## L2：浏览器端到端验证

**适用**：改了 demo-app 业务代码（[abp-unwrap-mw.ts](../../examples/demo-app/src/middleware/abp-unwrap-mw.ts) / [main.ts](../../examples/demo-app/src/main.ts) / 页面）后跑。

**前置**：

```bash
# 终端 1：起 mock（保持运行）
pnpm mock

# 终端 2：起 demo-app dev server（保持运行）
pnpm --filter '@xapiforge/example-demo-app' dev
# 打开 http://localhost:5173
```

自动执行需要本机已经安装 Python Playwright 和 Chromium：

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
pnpm test:demo-app
```

`test:demo-app` 不负责启动 mock-server 和 Vite；两个服务都要保持运行。没有 Python Playwright 时，可以打开 `/scenarios` 后点击 `Run All`，按下表人工核对。

### 场景清单

| #   | 场景                           | 操作                                                                                                 | 期望                                                 |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | 正常登录                       | 登录页输入 `admin` / 任意非空密码 → 点登录                                                           | 跳转 `/`，列表加载，token 写入 localStorage          |
| 2   | A16 HTTP 401 → refresh → retry | F12 console: `localStorage.app_token = "expired"` → 点"查询"                                         | 自动 refresh，列表返回，token 变 `refreshed-token`   |
| 3   | A14 业务 200 鉴权码            | console: `localStorage.app_token = "biz-code-expired"` → 调用带此 token 的接口                       | 自动 refresh，数据返回                               |
| 4   | D2 refresh 失败 → 跳登录       | console: `localStorage.app_refresh_token = "invalid"; localStorage.app_token = "expired"` → 点"查询" | 跳转 `/login`                                        |
| 5   | A17 429 限流                   | console: `fetch("/api/test/429-with-retry-after", {headers:{Authorization:"Bearer mock-token"}})`    | 退避重试后抛错                                       |
| 6   | B19 文件下载                   | console: `fetch("/api/test/download").then(r=>r.blob()).then(b=>console.log(b.size))`                | 输出 1024                                            |
| 7   | C1-C10 envelope 变体           | console: `fetch("/api/test/c1-data-string").then(r=>r.json())`                                       | 返回 `{code:0, data:"https://file.url"}`             |
| 8   | 跨刷新 token 持久化            | 登录后 F5 刷新页面                                                                                   | 仍在 `/`，列表重新加载（token 从 localStorage 恢复） |
| 9   | 第三方 API envelope            | 在 Home 页点"查天气"                                                                                 | 显示天气数据（`{ok, data}` envelope 解包）           |

### DevTools console 快捷脚本

```js
// 查看当前 token
console.log("access:", localStorage.app_token, "refresh:", localStorage.app_refresh_token);

// 模拟 token 过期（触发 A16）
localStorage.app_token = "expired";

// 模拟 refresh token 失效（触发 D2 跳登录）
localStorage.app_refresh_token = "invalid";
localStorage.app_token = "expired";

// 清空 token（相当于登出）
localStorage.removeItem("app_token");
localStorage.removeItem("app_refresh_token");

// 调用 api（main.ts DEV 模式已暴露 window.__api）
await window.__api.base.GET("/api/identity/users");
```

---

## mock-server 测试端点速查

**路径前缀**：`/api/test/`（无需鉴权，除显式 401/403 测试）

| 端点                   | 场景                     | 响应                                          |
| ---------------------- | ------------------------ | --------------------------------------------- |
| `429-with-retry-after` | A17 限流 + Retry-After   | 429 + `Retry-After: 1`                        |
| `429-no-retry-after`   | A17 限流无 Retry-After   | 429                                           |
| `500-html`             | A18 5xx + HTML           | 500 + `<html>...`                             |
| `500-json`             | A19 5xx + JSON envelope  | 500 + `{code:500,...}`                        |
| `503`                  | A20 503                  | 503 + `{message:"Service Unavailable"}`       |
| `204`                  | A21 空响应               | 204 No Content                                |
| `200-empty`            | A22 200 空 body          | 200 + empty body                              |
| `200-non-json-text`    | B10 Content-Type 不匹配  | 200 + `application/json` + 非 JSON 文本       |
| `bom`                  | B11 BOM                  | 200 + `\uFEFF{...}`                           |
| `redirect-to-users`    | B23 重定向               | 302 → `/api/identity/users`                   |
| `slow?ms=N`            | B4 慢响应                | 延迟 N ms 后 200                              |
| `c1-data-string`       | C1 data 是 string        | `{code:0, data:"https://file.url"}`           |
| `c2-data-array`        | C2 data 是 array         | `{code:0, data:[...]}`                        |
| `c3-data-paged`        | C3 data 是分页           | `{code:0, data:{items, totalCount}}`          |
| `c4-data-null`         | C4 data 是 null          | `{code:0, data:null}`                         |
| `c5-no-msg`            | C5 无 message 字段       | `{code:0, data:{...}}`                        |
| `c6-code-string`       | C6 code 是 string        | `{code:"0", data:{...}}`                      |
| `c7-code-bool`         | C7 success 是 bool       | `{success:true, data:{...}}`                  |
| `c8-both-code-status`  | C8 同时有 code 和 status | `{code:0, status:"ok", data:{...}}`           |
| `c9-array-root`        | C9 数组根                | `[{id:1},{id:2}]`                             |
| `c10-nested`           | C10 嵌套 2 层            | `{result:{inner:{code:0, data:{...}}}}`       |
| `biz-code-500`         | L4.8 业务错误码          | `{code:500, message:"业务错误"}`              |
| `auth-401`             | A16 HTTP 401             | 401 + `{code:401,...}`                        |
| `auth-403`             | A16 HTTP 403             | 403 + `{code:403,...}`                        |
| `download`             | B19 文件下载             | 200 + 1024 字节二进制 + `Content-Disposition` |

**`/connect/token?scenario=xxx`**（refresh_token grant 专用）：

| scenario       | 场景                  | 响应                                           |
| -------------- | --------------------- | ---------------------------------------------- |
| （无）         | 正常                  | 200 + `{access_token: "refreshed-token", ...}` |
| `refresh-401`  | D2 refresh token 过期 | 401 + `{error:"invalid_grant"}`                |
| `refresh-429`  | D3 refresh 限流       | 429 + `Retry-After: 1`                         |
| `refresh-500`  | D4 refresh 服务端错误 | 500                                            |
| `refresh-slow` | D7 refresh 超时       | 延迟 3s 后 200                                 |

---

## CI 集成

`.github/workflows/ci.yml` 在 pull request 和 `main` 推送时运行 lint、format、build、test 和 docs 五类 job。`test` job 包含包测试、`test:scenarios` 和 `test:download`；浏览器测试依赖额外的 Playwright 环境，目前仍由维护者在涉及 demo 改动时执行。

---

## 提交前验证清单

```bash
pnpm verify
```

涉及 demo 页面时，再启动 mock 和 demo 后运行：

```bash
pnpm test:demo-app
```

---

## 常见问题

**Q: `pnpm test:scenarios` 报端口占用？**
A: 脚本会先探测 8787 是否可用；已运行的 mock 会复用。若 pidfile 残留但进程已死，删 `/tmp/demo-mock.pid` 重试。

**Q: 改了库代码后 L1 通过但 L2 失败？**
A: L2 走真实浏览器 + demo-app，可能是 demo-app 业务侧代码（如 `abp-unwrap-mw.ts`）的问题，不是库的问题。看浏览器 DevTools 的 Network / Console 定位。

**Q: 加了新场景怎么补测试？**
A:

1. 库层场景 → 在 `scripts/test/scenarios.ts` 加断言
2. mock 端点不够 → 在 `scripts/mock-server.ts` 的 `handleTestEndpoint` 加 case
3. 端到端场景 → 在 `VALIDATION.md` 的 L2 场景清单加一行
4. 更新 `docs/internals/scenarios.md` 和 `docs/internals/behavior-contract.md` 的覆盖表
