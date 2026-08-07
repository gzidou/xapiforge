# @xapiforge/example-demo-app

Vue 3 全链路接入示例 — **模拟接入 Demo 项目**。

> 本示例验证 `@xapiforge/core` + `@xapiforge/genapi`（含 `xapiforge-fetch` CLI）全套工具链。
> 接入文档见 [docs/getting-started/browser.md](../../docs/getting-started/browser.md)。

---

## 它验证什么

在一个示例业务项目（Demo Service）里跑通 `@xapiforge/core` 全套：

- `xapiforge.config.ts` 配置三个隔离 service → `xapiforge-fetch` 下载或复用 swagger.json
- `genapi` 生成 TS API 客户端
- `SchemasByService` / `SchemaOf` 多服务类型隔离
- `defaults/services` 运行时地址覆盖
- 标准 runtime enum helper 与 service 级 legacy enum hook
- `HttpClient` + `AuthService` + `createNet` 初始化
- `AuthApi` 调 `/connect/token`（OAuth2 password grant）
- 业务 middleware（ABP envelope 解包）
- 401 自动 refresh（单飞 + 窗口保护）
- 业务 API 调用（类型安全）

## Demo 后端特点

运行时 mock 包含一组 envelope/OAuth2 场景；Swagger fixture 全部是仓库内合成数据：

- 标准 OAuth2 password grant + `Infrastructure_Web` client_id + 多租户
- `base.json`：主 API 和通用请求场景
- `infrastructure.json`：独立 service、标准 enum 和独立运行时地址示例
- `legacy.json`：只由 service hook 规范化的历史 enum 示例
- `/connect/token` 不在 swagger paths 里（OpenAPI 标准 —— security scheme 描述，不算 path endpoint）
- 响应格式：`{ code: 0, data: ..., message: null }`（ABP envelope）
- 错误响应：OAuth2 标准 `{ error, error_description }`（不是 `{code, data, message}`）

## 文件结构

```
examples/demo-app/
├── package.json          # @xapiforge/core + adapter + genapi 依赖
├── xapiforge.config.ts     # Demo project config (3 services)
├── hooks/
│   └── legacy-enum.ts     # 可复制的保守 legacy enum 规范化示例
├── swagger/demo/*.json    # 分离的标准/多服务/legacy 合成快照
├── tsconfig.json         # extends ../../tsconfig.base.json
├── vite.config.ts
└── src/
    ├── main.ts           # createNet 初始化 + Vue Router
    ├── AuthApi.ts        # /connect/token 调用（独立 fetch，不走 net 拦截链）
    ├── middleware/
    │   └── abp-unwrap-mw.ts  # ABP envelope 解包 middleware
    ├── utils/
    │   ├── enum-options.ts   # 枚举工具
    │   ├── file-saver.ts     # 文件下载（浏览器 + Capacitor 双模式）
    │   └── paged.ts          # ABP 分页 DTO
    └── views/
        ├── Login.vue     # 登录表单
        ├── Home.vue      # 业务 API demo
        └── Scenarios.vue # 场景验证页面
```

## 启动

```bash
cd examples/demo-app
pnpm install
pnpm dev   # 需 vue / vite（项目内不装，开发者自己装）
```

> 配合 mock-server 跑：根目录 `pnpm mock` 启动本地 mock（模拟 Demo 后端）。

生成并检查：

```bash
pnpm generate:api
pnpm run generate:api -- --check
pnpm typecheck
```

Home 页的主业务请求走 `api.base`，配置查询走 `api.infrastructure`。`main.ts` 使用 `services.infrastructure.baseURL` 演示 service 级运行时地址覆盖；mock 环境两个地址相同，部署时可以独立注入。

## ABP 接入的 4 个陷阱

| #   | 陷阱                                                                                  | 解决方案                                          |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | `URLSearchParams.toString()` 会自动把 `%20` 转 `+`，后端期望 `%20`                    | 手动拼字符串，不调 `.toString()`                  |
| 2   | 必须带 `__tenant` header（多租户场景）                                                | 业务代码 `if (tenant) headers.__tenant = tenant;` |
| 3   | 响应是 snake_case (`access_token`)，业务代码用 camelCase (`token`)                    | `toAuthPojo()` 字段映射                           |
| 4   | 错误响应是 OAuth2 标准 `{error, error_description}`，**不是** `{code, data, message}` | `isOAuth2Error(json)` 检测 + 抛 `AuthLoginError`  |

## login 端点走不走 net 的拦截链？

**不走**。原因：

- login 端点不带 `Authorization` header
- login 端点 Content-Type 是 form-urlencoded，不是 JSON
- login 端点的错误格式是 OAuth2，不是业务码

所以 `AuthApi.login()` **直接用全局 `fetch()`**，不走 `createNet`。

> **设计取舍**：login 是「auth 链路入口」，不是「业务请求」，所以独立 fetch 是合理设计。
