# 鉴权（token / refresh / 401）

> 本文档详解 `@xapiforge/core` 的鉴权机制：token 注入、401 自动刷新、单飞、窗口保护、超时。

## 鉴权架构

```text
┌─────────────── 业务代码 ───────────────┐
│  api.base.GET("/api/...")              │
└──────────────────┬─────────────────────┘
                   │ 1. 请求
┌──────────────────▼─────────────────────┐
│  auth middleware（内核自动注入）         │
│  ├─ authService.getToken()              │
│  ├─ 注入 Authorization: Bearer <token>  │
│  └─ 放行给 fetch                        │
└──────────────────┬─────────────────────┘
                   │ 2. 响应 401
┌──────────────────▼─────────────────────┐
│  retry loop（内核自动注入）             │
│  ├─ catch RetryableError({needsRefresh})│
│  ├─ authService.refreshIfNeeded()       │
│  │  ├─ 单飞：并发 401 只发一次 refresh   │
│  │  ├─ 窗口保护：30s 内已 refresh → 复用 │
│  │  └─ 超时：10s 未完成 → 抛 AuthError   │
│  └─ 重发请求（新 token 自动注入）        │
└──────────────────┬─────────────────────┘
                   │ 3. refresh 失败
┌──────────────────▼─────────────────────┐
│  authService.onAuthFailed()             │
│  └─ 业务侧实现：跳登录页 / 清 token     │
└────────────────────────────────────────┘
```

## AuthService 配置

```typescript
import { AuthService } from "@xapiforge/core";
import { localStorageStore } from "@xapiforge/adapter-browser";

const authService = new AuthService({
  // 1. token 存储（按运行时选 adapter）
  tokenStore: localStorageStore("app_token"),

  // 2. token 刷新逻辑（业务侧实现）
  authRefresher: {
    async refresh(): Promise<string> {
      const refreshToken = localStorage.getItem("app_refresh_token");
      if (!refreshToken) throw new Error("no refresh_token");
      const r = await authApi.refreshToken(refreshToken);
      localStorage.setItem("app_refresh_token", r.refreshToken ?? "");
      return r.token; // 返回新 access_token
    }
  },

  // 3. refresh 失败回调（跳登录）
  onAuthFailed: () => {
    router.push("/login");
  },

  // 4. 可选：调参（以下为默认值）
  refreshWindowMs: 30_000, // 窗口保护：30s 内已 refresh → 复用结果
  refreshTimeoutMs: 10_000, // refresh 超时：10s 未完成 → 抛 AuthError
  logger: console // 日志（调试用）
});
```

## 三大机制详解

### 1. 单飞（singleflight）

多个请求并发 401 时，只发一次 refresh 请求，其他请求等结果。

```typescript
// 场景：页面同时发 5 个 API 请求，token 过期
// ❌ 无单飞：5 个请求都 401 → 5 次 refresh → 后端可能拒绝（refresh_token 一次性）
// ✅ 有单飞：5 个请求都 401 → 只发 1 次 refresh → 5 个请求都用新 token 重试

// 无需配置，AuthService 内部自动单飞
```

### 2. 窗口保护（refresh window）

`refreshWindowMs` 内已 refresh 过 → 直接返回上次 token，避免频繁 refresh。

```typescript
// 场景：用户快速切页面，1s 内触发 10 次 API 调用
// ❌ 无窗口保护：每次 401 都 refresh（如果 token 即将过期）
// ✅ 有窗口保护：30s 内只 refresh 一次，后续直接复用

// 配置：refreshWindowMs（默认 30000）
const authService = new AuthService({
  // ...
  refreshWindowMs: 30_000
});
```

### 3. 超时（refresh timeout）

`refreshTimeoutMs` 后仍未完成 → 抛 `AuthError`，避免死等。

```typescript
// 场景：后端 /connect/token 卡住（网络问题 / 服务挂了）
// ❌ 无超时：业务代码 await 永远不返回
// ✅ 有超时：10s 后抛 AuthError → onAuthFailed 跳登录

// 配置：refreshTimeoutMs（默认 10000）
const authService = new AuthService({
  // ...
  refreshTimeoutMs: 10_000
});
```

## 401 自动刷新流程

业务代码无需处理 401，内核自动完成：

```typescript
// 业务代码（无需 try/catch 401）
const user = await api.base.GET("/api/users/{id}", { params: { path: { id } } });

// 内核自动处理：
//   1. auth middleware 注入 token（旧 token）
//   2. 后端返 401
//   3. retry loop catch 401 → 抛 RetryableError({ needsRefresh: true })
//   4. authService.refreshIfNeeded() → 拿新 token
//   5. auth middleware 重新注入 token（新 token）
//   6. 重发请求 → 成功
//   7. 业务代码拿到响应（全程无感）
```

## 业务鉴权码（非 HTTP 401）

某些后端（如 ABP）用 HTTP 200 + envelope code 表示鉴权失败：

```json
// HTTP 200，但 envelope code = 40001 表示 token 过期
{
  "code": 40001,
  "data": null,
  "message": "token expired"
}
```

这种情况下，auth middleware（看 HTTP status）不会触发 refresh。需要业务 middleware 抛 `RetryableError`：

```typescript
// 业务 middleware（ABP envelope 解包）
import { RetryableError } from "@xapiforge/core";
import type { Middleware } from "openapi-fetch";

const ABP_AUTH_CODES = new Set([40001, 40002, 41001]);

export const abpUnwrapMw: Middleware = {
  async onResponse({ response }) {
    if (!response.ok) return response;
    const envelope = await response.clone().json();
    if (ABP_AUTH_CODES.has(envelope.code)) {
      // 抛 RetryableError 触发 refresh + 重试
      throw new RetryableError(`abp auth code ${envelope.code}`, {
        needsRefresh: true
      });
    }
    return response;
  }
};
```

## TokenStore 选型

| 运行时       | adapter                           | TokenStore            | 说明              |
| ------------ | --------------------------------- | --------------------- | ----------------- |
| 浏览器       | `@xapiforge/adapter-browser`      | `localStorageStore`   | 明文，开发用      |
| 浏览器       | `@xapiforge/adapter-browser`      | `sessionStorageStore` | 标签页关闭即失效  |
| Capacitor    | `@xapiforge/adapter-capacitor`    | `preferencesStore`    | Preferences 插件  |
| Capacitor    | `@xapiforge/adapter-capacitor`    | `secureStorageStore`  | Keychain/Keystore |
| React Native | `@xapiforge/adapter-react-native` | `keychainStore`       | Keychain/Keystore |

## 手动触发 refresh

```typescript
// 场景：知道 token 即将过期，提前刷新（如长操作前）
await authService.refreshIfNeeded();

// 场景：登出，清 token
await authService.clear();
```

## 调试技巧

```typescript
// 开启日志
const authService = new AuthService({
  // ...
  logger: console // 输出 refresh / 单飞 / 窗口保护日志
});

// 手动检查 token 状态
const token = await authService.getToken();
console.log("current token:", token);
```

## 下一步

- [自定义 middleware](./middleware.md) — 适配非 ABP 后端协议
- [错误处理](./error-handling.md) — AuthError / NetworkError / BizError
