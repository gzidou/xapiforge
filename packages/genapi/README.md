# @xapiforge/genapi

OpenAPI-to-TypeScript client generator for xapiforge projects.

## Install

Install the generator as a development dependency. Generated clients use `@xapiforge/core`, which owns the `openapi-fetch` runtime dependency:

```bash
pnpm add @xapiforge/core
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
  timeoutMs: 15_000,
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

For offline specifications, hooks, and generated-client initialization, see the [browser onboarding guide](https://gzidou.github.io/xapiforge/getting-started/browser).
