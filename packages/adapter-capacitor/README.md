# @xapiforge/adapter-capacitor

Capacitor token-storage adapters and native file downloads for `@xapiforge/core`.

## Install

Install only the Capacitor plugin used by your application:

```bash
pnpm add @xapiforge/core @xapiforge/adapter-capacitor
pnpm add @capacitor/preferences
```

For Keychain/Keystore-backed tokens, install `@capacitor-community/secure-storage` instead. For native downloads, install `@capacitor/filesystem`.

## Store a token

```typescript
import { preferencesStore } from "@xapiforge/adapter-capacitor";

const tokenStore = preferencesStore("app_access_token");
await tokenStore.set("access-token");
const token = await tokenStore.get();
await tokenStore.clear();
```

Use `secureStorageStore(key)` for sensitive credentials. Use `downloadFileNative(options)` when a large file must be written by the native layer instead of being buffered in the WebView.

See the [Ionic and Capacitor guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/ionic-capacitor.md) for native HTTP and download examples.
