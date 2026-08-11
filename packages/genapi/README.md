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
    "generate:api": "xapiforge",
    "check:api": "xapiforge myapp --check"
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
  mode: "online",
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
pnpm check:api
```

`--check` is read-only and returns non-zero when generated output has drifted.

With the configuration above, the generated project is:

```text
src/api/gen/myapp/
├── index.ts
├── api-types.ts
├── manifest.json
└── types/
    └── base.ts
```

`index.ts` exports `createMyappClient`. `api-types.ts` exports the canonical `SchemasByService`, `ServiceName`, and `SchemaOf<Service, FullName>` APIs plus convenience namespaces selected by `typeExports`. Do not edit these files; fix configuration, hooks, or the OpenAPI input and regenerate.

Service IDs are stable identities and appear in different safe forms:

| Location                             | `legacy-orders`          |
| ------------------------------------ | ------------------------ |
| Config, `SchemaOf`, runtime override | `"legacy-orders"`        |
| Generated type file                  | `types/legacy-orders.ts` |
| Generated client property            | `api.legacy_orders`      |
| Default service namespace            | `LegacyOrdersSchemas`    |

Changing a `source.file` path or switching between an equivalent file and URL source does not rename these public APIs.

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

The OpenAPI `source.url` is a generation input, not the runtime request address. Supply the runtime `baseURL` when creating the generated client.

For one runtime endpoint, pass Core `NetConfig` directly:

```typescript
import { createMyappClient } from "./api/gen/myapp/index.js";

const api = createMyappClient({ baseURL, authService, middleware });
const baseApi = api.base;
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

For canonical access, import from the generated type entry:

```typescript
import type { BaseSchemas, SchemaOf } from "./api/gen/myapp/api-types.js";

type ConvenientUser = BaseSchemas.UserDto;
type CanonicalUser = SchemaOf<"base", "Company.Identity.UserDto">;
```

Replace the example full schema name with the exact name from your OpenAPI document. Cross-service duplicate names remain isolated by the service ID.

## Runtime enums

Standard OpenAPI enums remain literal unions. Runtime constants are opt-in:

```typescript
import { createRuntimeEnumHooks } from "@xapiforge/genapi";

const hooks = createRuntimeEnumHooks({
  metadata: {
    "Sample.DeviceState": {
      overrideLabels: { 0: "Offline", 1: "Online" },
      extensions: {
        colors: { 0: "#999", 1: "#16a34a" },
        icon: { 0: "WifiOff", 1: "Wifi" }
      }
    },
    "Sample.AccessMode": { isFlags: true }
  }
});
```

The helper emits runtime constants, labels, names, options, lookup helpers, JSON-valued extensions, serialization maps, and Flags members. These exports follow the same service/prefix/alias namespaces as their schema types. `transformTypes` consumes `ctx.normalizedDocument`; it never rereads the source Swagger.

Non-standard Swagger normalization belongs in a business `preprocessSwagger` hook; it is not a generator default.

For offline specifications and initialization, see the [browser onboarding guide](https://gzidou.github.io/xapiforge/getting-started/browser). For v2 multi-service configuration, aliases, transactions, hooks, and migration, see the [genapi v2 guide](https://gzidou.github.io/xapiforge/guides/genapi-v2).

For a step-by-step integration workflow covering mixed URL/file sources, non-standard backend documents, service-specific hooks, namespace usage, and runtime verification, see [multi-backend onboarding](https://gzidou.github.io/xapiforge/getting-started/multi-backend).
