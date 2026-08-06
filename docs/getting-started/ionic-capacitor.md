# Ionic / Capacitor 接入

这页只说明 Capacitor 与普通浏览器项目的差异。OpenAPI 配置、客户端生成、登录和错误处理先按[浏览器应用接入](./browser.md)完成。

`@xapiforge/adapter-capacitor` 当前提供两类能力：

- 基于 Capacitor Preferences 或 Secure Storage 的 TokenStore。
- 基于 Capacitor Filesystem 的原生文件下载。

它不包含 `CapacitorHttp` 的 fetch 适配器。应用可以继续使用 WebView 的 `fetch`，也可以把自己已经验证过的原生 HTTP 适配器通过 `fetch` 配置注入。

## 1. 安装依赖

使用 Preferences 保存 Token：

```bash
pnpm add @xapiforge/core @xapiforge/adapter-capacitor @capacitor/preferences
pnpm add -D @xapiforge/genapi
```

如果项目要求使用 Keychain / Keystore，把 `@capacitor/preferences` 换成 `@capacitor-community/secure-storage`，代码中使用 `secureStorageStore`。

需要原生文件下载时再安装：

```bash
pnpm add @capacitor/filesystem
pnpm exec cap sync
```

原生插件由应用项目直接依赖，便于和当前 Capacitor 主版本保持一致。

## 2. 初始化生成客户端

以下代码假设浏览器接入步骤已经生成 `createMyappClient`：

```typescript
// src/api-client.ts
import { preferencesStore } from "@xapiforge/adapter-capacitor";
import { AuthService } from "@xapiforge/core";
import { createMyappClient } from "./api/myapp/index.js";

const accessTokenStore = preferencesStore("myapp_access_token");

const authService = new AuthService({
  tokenStore: accessTokenStore,
  authRefresher: {
    async refresh() {
      // 按实际后端协议调用刷新端点并返回新的 access token。
      throw new Error("token refresh is not configured");
    }
  },
  onAuthFailed() {
    // 在应用路由层跳转到登录页。
  }
});

export const api = createMyappClient({
  baseURL: "https://api.example.com",
  authService
});
```

Preferences 适合非敏感配置。生产环境保存访问令牌时，应根据安全要求评估 `secureStorageStore`。

## 3. 选择网络实现

不传 `fetch` 时，客户端使用 WebView 的全局 `fetch`：

```typescript
export const api = createMyappClient({
  baseURL: "https://api.example.com",
  authService
});
```

这种方式最简单，但仍受 WebView CORS 和证书策略约束。

如果项目已有把 `CapacitorHttp` 转成标准 `fetch` 签名的适配器，可以注入：

```typescript
import type { FetchLike } from "@xapiforge/core";

declare const capacitorFetch: FetchLike;

export const api = createMyappClient({
  baseURL: "https://api.example.com",
  authService,
  fetch: capacitorFetch
});
```

该适配器必须返回标准 `Response`，正确保留 status、headers 和 body，并明确处理 `AbortSignal`、FormData 和二进制响应。xapiforge 不替应用选择或包装某个 Capacitor HTTP 插件。

## 4. 原生文件下载

大文件不适合先读入 WebView 内存。安装 `@capacitor/filesystem` 后，可直接写入原生目录：

```typescript
import { downloadFileNative } from "@xapiforge/adapter-capacitor";

const result = await downloadFileNative({
  url: "https://api.example.com/files/report.pdf",
  path: "reports/report.pdf",
  directory: "DOCUMENTS",
  getHeaders: async () => {
    const token = await accessTokenStore.get();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  onProgress(received, total) {
    console.log(`${received}/${total}`);
  }
});

console.log(result.path);
```

`downloadFileNative` 不经过 `createNet` 的 middleware。需要刷新 Token 时，应在 `getHeaders` 中先完成刷新，再返回最新请求头。

## 已知限制

- Capacitor Filesystem 的下载取消只会让 JavaScript Promise 失败，原生下载可能仍在后台继续。
- 下载进度事件是全局事件，adapter 会把多个下载排队执行，避免进度串扰。
- `EXTERNAL` 目录只适用于 Android；跨平台优先使用 `DOCUMENTS` 或 `CACHE`。
- 原生插件升级后要重新执行 `pnpm exec cap sync`，并在真机或模拟器上验证。

继续阅读：[鉴权详解](../guides/auth.md)、[文件下载](../guides/file-download.md)。
