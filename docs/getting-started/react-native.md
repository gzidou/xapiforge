# React Native 接入

> 本文档展示在 React Native 应用里接入 `@xapiforge/core` 的步骤。前置步骤（xapiforge.config.ts / 生成 API / AuthApi / middleware）与 [浏览器接入](./browser.md) 相同，本文只讲差异点。

## 为什么需要单独接入

React Native 没有 DOM `fetch`，但有 polyfill（`react-native-fetch-api` 或 RN 内置）。主要差异在 **token 存储**：RN 没有 `localStorage`，需要用 `@react-native-async-storage/async-storage` 或 `react-native-keychain`。

## 步骤 1：安装依赖

```bash
pnpm add @xapiforge/core @xapiforge/adapter-react-native
pnpm add @react-native-async-storage/async-storage react-native-keychain
pnpm add -D @xapiforge/genapi openapi-fetch
```

## 步骤 2：初始化时注入 RN adapter

```typescript
// src/api/init.ts
import { keychainStore, encryptedStorageStore } from "@xapiforge/adapter-react-native";
import { AuthService, HttpClient, createNet } from "@xapiforge/core";
import { AuthApi } from "./AuthApi";

const BASE_URL = "https://api.example.com";

// TokenStore 选型：
//   - keychainStore：react-native-keychain（iOS Keychain / Android Keystore，生产推荐）
//   - encryptedStorageStore：react-native-encrypted-storage（加密 SharedPreferences，Android 主用）
const tokenStore = keychainStore({ service: "app_token" });

const httpClient = new HttpClient({ baseURL: BASE_URL });
const authApi = new AuthApi(httpClient, {/* ... */});

const authService = new AuthService({
  tokenStore,
  authRefresher: {
    async refresh() {
      const refreshToken = await tokenStore.get(); // 简化示例
      const r = await authApi.refreshToken(refreshToken ?? "");
      return r.token;
    }
  },
  onAuthFailed: () => {
    // RN 导航：用 React Navigation 的 navigationRef
    navigationRef.navigate("Login");
  }
});

export const api = createNet({
  baseURL: BASE_URL,
  authService,
  middleware: [/* 业务 middleware */],
  maxRetries: 3
});
```

## 步骤 3：业务代码调用

```typescript
// src/screens/Home.tsx
import { api } from "../api/init";

export function HomeScreen() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    api.GET("/api/identity/users/{id}", { params: { path: { id: "u-001" } } })
      .then(({ data }) => setUser(data))
      .catch(console.error);
  }, []);

  return <View>{/* ... */}</View>;
}
```

## 已知限制

1. **fetch polyfill**：RN 内置 fetch 支持 `AbortController`，但部分老版本 RN 需要手动引入 `react-native-fetch-api` 补全 stream 支持
2. **文件下载**：RN 无 `Blob` / `File System Access API`。大文件下载需用 `react-native-fs` 或 `expo-file-system`，通过 `api.download` 的 `onChunk` 回调流式写盘
3. **无 `document.cookie`**：cookie-based 鉴权不适用，必须用 token-based（Bearer）

## 下一步

- [浏览器接入](./browser.md) — 完整接入步骤（通用部分）
- [鉴权详解](../guides/auth.md) — token 刷新机制
