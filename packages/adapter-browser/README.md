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

Use `sessionStorageStore(key)` for tab-scoped storage or `cookieStore(key, days)` for a same-origin, JavaScript-readable cookie. `cookieStore` cannot create an HttpOnly cookie and does not add Secure or SameSite attributes; do not treat it as a replacement for a server-managed session cookie. These adapters access browser globals and must only be called on the client in SSR applications.

See the [browser onboarding guide](https://gzidou.github.io/xapiforge/getting-started/browser) for `AuthService` integration.
