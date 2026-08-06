# @xapiforge/adapter-browser

Browser `TokenStore` implementations for `@xapiforge/core`, backed by localStorage, sessionStorage, or cookies.

```bash
pnpm add @xapiforge/core @xapiforge/adapter-browser
```

```typescript
import { localStorageStore } from "@xapiforge/adapter-browser";

const tokenStore = localStorageStore("app_access_token");
```

See the [browser onboarding guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/browser.md).
