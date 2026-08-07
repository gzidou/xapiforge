# @xapiforge/genapi

OpenAPI-to-TypeScript client generator for xapiforge projects. v2 keeps every service's `paths` and `components` isolated, generates deterministic manifests, and replaces project output transactionally.

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
  genOutputDir: "src/api/gen",
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

`genOutputDir` is optional and defaults to `src/api/gen`. Existing explicit output directories continue to work.

Project and service IDs must use kebab-case. Every declared service is required and maps to `swagger/<project>/<service>.json` in offline mode.

## Generate

```bash
pnpm download-swagger
pnpm generate:api myapp
pnpm run generate:api -- --check
```

`--check` is read-only and returns non-zero when generated output has drifted.

## Multi-service runtime config

The legacy flat Core `NetConfig` remains supported:

```typescript
const api = createMyappClient({ baseURL, authService, middleware });
```

Use layered config when a service needs a different runtime address or middleware:

```typescript
const api = createMyappClient({
  defaults: { baseURL, authService, middleware, logger },
  services: {
    infrastructure: {
      baseURL: infrastructureBaseURL,
      middleware: [infrastructureMiddleware]
    }
  }
});
```

Defined service values replace defaults. Middleware arrays are replaced, not concatenated.

For multi-service types, use `SchemasByService` and `SchemaOf<Service, FullName>`. Multi-service projects no longer emit the unsafe `AllSchemas` intersection by default.

## Runtime enums

Standard OpenAPI enums remain literal unions. Runtime constants are opt-in:

```typescript
import { createRuntimeEnumHooks } from "@xapiforge/genapi";

const hooks = createRuntimeEnumHooks({
  metadata: { "Sample.AccessMode": { isFlags: true } }
});
```

Legacy Swagger normalization belongs in a business `preprocessSwagger` hook; it is not a generator default.

For offline specifications and initialization, see the [browser onboarding guide](https://gzidou.github.io/xapiforge/getting-started/browser). For v2 multi-service configuration, aliases, transactions, hooks, and migration, see the [genapi v2 guide](https://gzidou.github.io/xapiforge/guides/genapi-v2).
