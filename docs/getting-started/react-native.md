# React Native 接入

这页只说明 React Native 的差异。先按[浏览器应用接入](./browser.md)完成 `xapiforge.config.ts` 和客户端生成，初始化时再换成 React Native TokenStore。

## 1. 安装依赖

使用系统 Keychain / Keystore：

```bash
pnpm add @xapiforge/core @xapiforge/adapter-react-native react-native-keychain
pnpm add -D @xapiforge/genapi
```

`encryptedStorageStore` 只用于兼容已经依赖 `react-native-encrypted-storage` 的旧项目。它的上游仓库已经归档，新项目优先使用 `react-native-keychain`：

```bash
pnpm add @xapiforge/core @xapiforge/adapter-react-native react-native-encrypted-storage
pnpm add -D @xapiforge/genapi
```

参考：[react-native-keychain 文档](https://oblador.github.io/react-native-keychain/docs/)、[react-native-encrypted-storage 归档仓库](https://github.com/emeraldsanto/react-native-encrypted-storage)。安装后按 React Native 项目的原生依赖流程重新安装 Pods 或重新构建应用。

## 2. 初始化生成客户端

以下代码使用两个 Keychain service，分别保存 access token 和 refresh token：

```typescript
// src/api-client.ts
import { keychainStore } from "@xapiforge/adapter-react-native";
import { AuthService } from "@xapiforge/core";
import { createMyappClient } from "./api/myapp/index.js";

const BASE_URL = "https://api.example.com";
const accessTokenStore = keychainStore({ service: "myapp.access-token" });
const refreshTokenStore = keychainStore({ service: "myapp.refresh-token" });

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
}

const authService = new AuthService({
  tokenStore: accessTokenStore,
  authRefresher: {
    async refresh() {
      const refreshToken = await refreshTokenStore.get();
      if (!refreshToken) throw new Error("refresh token is missing");

      const response = await fetch(`${BASE_URL}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken
        }).toString()
      });
      if (!response.ok) throw new Error(`refresh failed: HTTP ${response.status}`);

      const token = (await response.json()) as RefreshResponse;
      if (token.refresh_token) await refreshTokenStore.set(token.refresh_token);
      return token.access_token;
    }
  },
  onAuthFailed() {
    // 通过应用自己的 navigation ref 返回登录页。
  }
});

export const api = createMyappClient({
  baseURL: BASE_URL,
  authService
});
```

刷新端点、字段名和请求格式必须按实际后端修改。登录成功后，把两个 Token 分别写入对应的 store。

旧项目使用 `encryptedStorageStore("myapp.access-token")` 时，其他初始化代码不变；迁移计划应由应用维护者决定。

## 3. 在页面中调用

```tsx
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "../api-client";

export function HealthScreen() {
  const [result, setResult] = useState("loading");

  useEffect(() => {
    api.base
      .GET("/api/health")
      .then(({ data }) => setResult(JSON.stringify(data)))
      .catch(error => setResult(error instanceof Error ? error.message : String(error)));
  }, []);

  return (
    <View>
      <Text>{result}</Text>
    </View>
  );
}
```

`base` 和 `/api/health` 来自示例配置。接入真实项目时，编辑器会根据生成类型提示可用 service 和 path。

## 需要注意

- React Native 提供全局 `fetch`，一般无需额外注入。老版本或需要流式响应时，再评估 fetch polyfill。
- 不要用同一个 Keychain service 同时保存 access token 和 refresh token，后写入的值会覆盖前一个。
- 大文件下载由应用选择 `react-native-fs`、Expo FileSystem 等原生方案；`adapter-react-native` 当前只负责 TokenStore。
- 原生依赖变更必须在 iOS 和 Android 上分别验证，单独通过 TypeScript 编译不代表原生链接成功。

继续阅读：[鉴权详解](../guides/auth.md)、[错误处理](../guides/error-handling.md)。
