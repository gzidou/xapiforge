/**
 * @xapiforge/example-demo-app — Vue 3 接入示例（v0.2）
 *
 * **本次目标：模拟接入Demo 项目**
 *
 * v0.2 架构：
 *   1. HttpClient — 纯 HTTP（给 AuthApi / 文件下载用）
 *   2. AuthService — 鉴权状态机（单飞 refresh + 窗口保护 + 超时）
 *   3. createNet — 业务 client（封装 openapi-fetch + middleware + retry loop）
 *   4. 业务 middleware — ABP envelope 解包（写在 demo-app，不在库里）
 *
 * 集成步骤：
 *   1. 安装 @xapiforge/core + adapter
 *   2. new HttpClient({ baseURL }) — 给 AuthApi 用
 *   3. new AuthService({ tokenStore, authRefresher, onAuthFailed }) — 鉴权状态机
 *   4. initApi('default', { baseURL, authService, middleware: [createAbpUnwrapMw()] })
 *   5. 业务代码调 useApi().base.GET(...) 即可
 *
 * demo-app 定位：通用验证工程（不是 ABP 专用）
 *   - ABP 是其中一个示例（createAbpUnwrapMw）
 *   - 还可承载其他协议验证（微信 errcode / 自研协议等）
 */

import { createApp } from "vue";
import { AuthService, HttpClient } from "@xapiforge/core";
import { localStorageStore } from "@xapiforge/adapter-browser";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { AuthApi } from "./AuthApi.js";
import { createAbpUnwrapMw } from "./middleware/abp-unwrap-mw.js";
import { initApi, useApi } from "./api/index.js";

// Demo 后端基础 URL（真后端在private network localhost:8787；本地开发用 mock 服务顶替）
const BASE_URL = "http://localhost:8787";

// 多 service 可在部署时独立配置；mock 环境仍指向同一进程。
const INFRASTRUCTURE_BASE_URL = "http://localhost:8787";

// 第三方 API（mock 顶替，演示独立 client 配置）
const THIRD_PARTY_BASE_URL = "http://localhost:8787/api/3rd";

// ABP OAuth2 配置（Demo 项目专用）
const AUTH_CONFIG = {
  tokenUrl: "/connect/token",
  clientId: "Infrastructure_Web",
  scope: "offline_access Infrastructure",
};

// Vue Router（401 跳登录用 router.push）
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", component: () => import("./views/Login.vue") },
    { path: "/", component: () => import("./views/Home.vue") },
    { path: "/scenarios", component: () => import("./views/Scenarios.vue") },
  ],
});

// 路由守卫：未登录 → 跳 /login（tokenStore 在下方创建，但 localStorage 已有则直接放行）
router.beforeEach((to) => {
  if (to.path === "/login") return true;
  const token = localStorage.getItem("app_token");
  return token ? true : "/login";
});

// ─── 1. HttpClient（纯 HTTP，给 AuthApi / 文件下载用）───
const httpClient = new HttpClient({ baseURL: BASE_URL });

// ─── 2. AuthApi（用 HttpClient 调 /connect/token）───
const authApi = new AuthApi(httpClient, AUTH_CONFIG);

// ─── 3. AuthService（鉴权状态机）───
//
// 职责：
//   - getToken() — 读 tokenStore
//   - refreshIfNeeded() — 单飞 refresh + 窗口保护 + 超时
//   - onAuthFailed — refresh 失败时调（跳登录）
//
// refresh 单飞：多个 401 并发时，只发一次 refresh 请求，其他等结果。
// 窗口保护：refreshWindowMs 内已 refresh → 直接返回上次 token（避免频繁 refresh）。
// 超时：refreshTimeoutMs 后仍未完成 → 抛 AuthError（避免死等）。
const authService = new AuthService({
  tokenStore: localStorageStore("app_token"),
  authRefresher: {
    async refresh() {
      // 从 localStorage 读 refresh_token（登录时存的）
      const refreshToken = localStorage.getItem("app_refresh_token");
      if (!refreshToken) throw new Error("no refresh_token");

      // 调 AuthApi.refreshToken（用 HttpClient，不走 middleware 链）
      const r = await authApi.refreshToken(refreshToken);

      // 存新 token + refresh_token
      localStorage.setItem("app_refresh_token", r.refreshToken ?? "");
      return r.token;
    },
  },
  onAuthFailed: () => {
    // 场景验证页需要稳定承载 Run All：F1 会故意触发 onAuthFailed，
    // 此时不跳转，避免组件卸载导致回归验证中断。普通页面仍按应用行为跳登录。
    if (router.currentRoute.value.path === "/scenarios") {
      console.warn("[demo-app] onAuthFailed triggered in scenario mode");
      return;
    }
    void router.push("/login");
  },
});

// ─── 4. 注册业务 client（createNet + middleware）───
//
// initApi('default', ...) — 主 API（Demo）
//   - authService 注入（createNet 自动加 auth middleware）
//   - createAbpUnwrapMw() — ABP envelope 解包（业务侧 middleware）
//   - maxRetries: 3 — 429 退避重试
//
// initApi('weather', ...) — 第三方 API（mock 演示）
//   - 共享 authService（同一套鉴权）
//   - 不加 ABP middleware（第三方用自己的 envelope 格式）
initApi("default", {
  baseURL: BASE_URL,
  authService,
  // 业务 middleware：abpUnwrap（envelope 解包）
  // 内核 middleware（auth + httpError）由 createNet 自动注入，无需配置
  // onResponse 反序执行：abpUnwrap 先看 response（跳过非 2xx）→ httpError 处理 5xx → auth 处理 401
  middleware: [createAbpUnwrapMw()],
  maxRetries: 3,
  services: {
    infrastructure: {
      baseURL: INFRASTRUCTURE_BASE_URL,
    },
  },
});

initApi("weather", {
  baseURL: THIRD_PARTY_BASE_URL,
  authService,
  // 第三方 API 用自己的 envelope 格式（{ ok, data }），不加 ABP middleware
  // 第三方 envelope 解包由业务代码在 request 调用时传 unwrap 处理
  middleware: [],
  maxRetries: 1,
});

// 业务代码（纯 TS，无 Vue 依赖）—— 由 views/Login.vue 等组件调用
// authApi 在此处创建（需要 httpClient + config 注入），导出给 Login.vue 用。
// Login.vue 通过动态 import 加载，此时 main.ts 已完成求值，无循环依赖问题。
export { authApi };

// Vue 入口
createApp(App).use(router).mount("#app");

// DEV ONLY: 暴露 api 到 window 供 Playwright 测试 A14 链路
if (import.meta.env.DEV) {
  (window as unknown as { __api: unknown }).__api = useApi();
}
