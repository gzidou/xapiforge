# @xapiforge/adapter-browser

Browser `TokenStore` implementations for `@xapiforge/core`, backed by localStorage, sessionStorage, or cookies.

## Install

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
```

## Use localStorage

```typescript
import { localStorageStore } from "@xapiforge/adapter-browser";

const tokenStore = localStorageStore("app_access_token");

await tokenStore.set("access-token");
const token = await tokenStore.get();
await tokenStore.clear();
```

Use `sessionStorageStore(key)` for tab-scoped storage or `cookieStore(key, days)` for a same-origin cookie. These adapters access browser globals and must only be called on the client in SSR applications.

See the [browser onboarding guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/browser.md) for `AuthService` integration.
