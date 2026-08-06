# @xapiforge/genapi

OpenAPI-to-TypeScript client generator for xapiforge projects.

## Install

Generated clients import `openapi-fetch`, so install it as an application dependency:

```bash
pnpm add openapi-fetch
pnpm add -D @xapiforge/genapi
```

## Configure

Add scripts to your application's `package.json`:

```json
{
  "scripts": {
    "download-swagger": "xapiforge-fetch",
    "generate:api": "xapiforge"
  }
}
```

Create `xapiforge.config.ts`:

```typescript
import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  defaultPath: "/swagger/v1/swagger.json",
  outputDir: "swagger",
  genOutputDir: "src/api",
  projects: [
    {
      name: "myapp",
      displayName: "My Application",
      baseHost: "http://localhost:8081",
      services: [{ name: "base", displayName: "Base API", port: 8081 }]
    }
  ]
});
```

## Generate

```bash
pnpm download-swagger
pnpm generate:api myapp
```

For offline specifications, hooks, and generated-client initialization, see the [browser onboarding guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/browser.md).
