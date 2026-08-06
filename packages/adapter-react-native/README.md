# @xapiforge/adapter-react-native

React Native token-storage adapters for `@xapiforge/core`.

## Install

```bash
pnpm add @xapiforge/core @xapiforge/adapter-react-native react-native-keychain
```

## Store a token in Keychain/Keystore

```typescript
import { keychainStore } from "@xapiforge/adapter-react-native";

const tokenStore = keychainStore({ service: "myapp.access-token" });
await tokenStore.set("access-token");
const token = await tokenStore.get();
await tokenStore.clear();
```

Alternatively, install `react-native-encrypted-storage` and use `encryptedStorageStore(key)`. The host application owns these native dependencies so it can choose versions compatible with its React Native runtime.

See the [React Native guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/react-native.md) for `AuthService` and generated-client integration.
