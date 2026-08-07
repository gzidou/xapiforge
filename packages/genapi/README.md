# @xapiforge/genapi

OpenAPI-to-TypeScript client generator for xapiforge projects. v2 keeps every service's `paths` and `components` isolated, generates deterministic manifests, and replaces project output transactionally.

Requires Node.js 20.19 or newer.

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
  timeoutMs: 15_000,
  maxSwaggerBytes: 64 * 1024 * 1024,
  outputDir: "swagger",
  genOutputDir: "src/api/gen",
  projects: [
    {
      name: "myapp",
      displayName: "My Application",
      services: [
        {
          name: "base",
          displayName: "Base API",
          source: { url: "http://localhost:8081/swagger/v1/swagger.json" }
        }
      ]
    }
  ]
});
```

`genOutputDir` is optional and defaults to `src/api/gen`. Existing explicit output directories continue to work.

Project and service IDs must use kebab-case. Every service requires either `source.file` or `source.url`; URL sources use `swagger/<project>/<service>.json` as their offline cache.

`maxSwaggerBytes` is optional and defaults to 64 MiB. It limits remote response streams, offline caches, local files, and generation inputs before they can consume unbounded memory.

## Generate

```bash
pnpm download-swagger
pnpm generate:api myapp
pnpm run generate:api -- --check
```

`--check` is read-only and returns non-zero when generated output has drifted.

For programmatic generation, relative `source.file` paths default to `process.cwd()`. Pass `configDirectory` to resolve them from a different configuration directory:

```typescript
await generate({
  xapiForgeConfig: config,
  projectId: "myapp",
  swaggerDir: "swagger",
  outputDir: "src/api/gen",
  configDirectory: "/absolute/path/to/config"
});
```

Semantic OpenAPI references must be resolvable internal `$ref` values. Ref-like keys inside arbitrary JSON data such as `example`, `default`, Example Object `value`, or `x-*` extensions remain literal business data and are isolated from Redocly's reference resolver.

## Multi-service runtime config

For one runtime endpoint, pass Core `NetConfig` directly:

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

Type exports have three explicit strategies: default `service-namespace` (`BaseSchemas.UserDto`), strict project-level `flat-strict` (`UserDto`, with generation failing on every same-scope collision), and `canonical-only`. Every strategy retains `SchemaOf<Service, FullName>`; v2 does not emit `AllSchemas`. Prefix namespaces are nested under the service in `service-namespace` and live at project top level in `flat-strict`.

## Runtime enums

Standard OpenAPI enums remain literal unions. Runtime constants are opt-in:

```typescript
import { createRuntimeEnumHooks } from "@xapiforge/genapi";

const hooks = createRuntimeEnumHooks({
  metadata: { "Sample.AccessMode": { isFlags: true } }
});
```

Non-standard Swagger normalization belongs in a business `transformSwagger` hook; it is not a generator default.

For offline specifications and initialization, see the [browser onboarding guide](https://gzidou.github.io/xapiforge/getting-started/browser). For v2 multi-service configuration, aliases, transactions, hooks, and migration, see the [genapi v2 guide](https://gzidou.github.io/xapiforge/guides/genapi-v2).
