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

`encryptedStorageStore(key)` remains available for existing applications that already use `react-native-encrypted-storage`. Its upstream repository is archived, so new integrations should prefer `keychainStore`. The host application owns native dependency versions and the migration decision.

See the [React Native guide](https://gzidou.github.io/xapiforge/getting-started/react-native) for `AuthService` and generated-client integration.
