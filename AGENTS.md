# AGENTS.md

Quick reference for AI coding assistants and human contributors working on this monorepo.

> Full docs: `pnpm docs:dev` (VitePress) → http://localhost:5174

## Core Principles

### 禁止幻觉，实事求是

- **没读过的代码不要描述**：陈述任何代码行为前，必须先用 Read / Grep / SearchCodebase 工具确认。不允许凭文件名或包名推测实现。
- **不编造 API / 函数 / 文件 / 配置**：引用不存在的导出、不存在的脚本、不存在的字段均属幻觉。不确定时说"我不确定，需要验证"。
- **不编造统计数据**：引用文件数、行数、出现次数等必须来自 Grep count / wc 等工具结果，不允许目测或估算。
- **不编造外部库行为**：涉及 openapi-typescript / openapi-fetch / VitePress 等第三方库时，以实际代码产物或官方文档为准，不凭印象描述。
- **错误承认错误**：被发现幻觉时，立即纠正，不辩解。

### 通用工具，业务自适配

xapiforge 是**框架无关的通用 HTTP 客户端 + OpenAPI codegen 工具**。后端框架（ABP / SpringBoot / NestJS 等）的特殊 swagger 形态不属于工具内核职责，应通过 genapi 的 **hooks 扩展点**（见 [genapi hooks 设计](./docs/guides/genapi-hooks.md)）由业务侧自定义处理。内核只做规范 OpenAPI 的标准处理。

## Project Overview

**xapiforge** — Framework-agnostic HTTP client + OpenAPI codegen toolkit.
Package namespace: `@xapiforge/*`. Works with Vue / React / React Native / Ionic.

## Key Commands

```bash
pnpm install
pnpm build                 # all packages
pnpm lint                  # root lint
pnpm format:check
pnpm docs:dev              # VitePress docs dev
pnpm test:scenarios        # library-level scenario tests

# single package
pnpm --filter '@xapiforge/core' build

# swagger download / API generation (run inside examples/demo-app)
cd examples/demo-app
pnpm download-swagger      # download swagger.json (offline mode = no-op)
pnpm generate:api          # generate TS API client (genapi)
```

## Directory Layout

| Path                                                 | Purpose                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core/`                                     | **Core** — HttpClient / AuthService / createNet / middleware chain                        |
| `packages/adapter-{browser,capacitor,react-native}/` | TokenStore adapters (mutually exclusive, pick one per host)                               |
| `packages/genapi/`                                   | OpenAPI → TS API client generator + swagger.json download CLI (`xapiforge-fetch` command) |
| `examples/demo-app/`                                 | Vue 3 full integration demo + browser scenario regression page                            |
| `scripts/`                                           | Toolchain scripts (mock-server / scenario tests)                                          |
| `docs/`                                              | VitePress docs (getting-started / guides / internals)                                     |

## Conventions

### 1. Cross-package references → use `exports.types: "./src/index.ts"`

Each package's `package.json`:

```jsonc
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  }
}
```

Do **not** add `paths` in sub-package tsconfig — it's a hack that breaks monorepo transparency.

### 2. Third-party framework deps → never in peerDependencies

`@capacitor/*` / `react-native-keychain` / `vue` / `react` etc. If added to peerDeps, pnpm validates existence (fails on registries). **Don't include them** — users install in their own app projects.

### 3. `workspace:*` only for actual workspace packages

- ✅ `"@xapiforge/core": "workspace:*"`
- ❌ `"typescript": "workspace:*"` (use `^5.9.3`)
- ❌ `"@types/node": "workspace:*"` (use `^24.13.3`)

### 4. Project `name` field semantics

- `ProjectConfig.name` = ID / directory name (short English code, e.g. `demo`)
- `ProjectConfig.displayName` = human-readable name (e.g. `Demo Service`)

### 5. Lint strict mode

`eslint.config.mjs` enforces: type-safety (`no-explicit-any` / `no-unsafe-*`), consistency (`consistent-type-imports`), async pitfalls (`no-floating-promises` / `await-thenable`), style (`eqeqeq` / `prefer-const`).

For stub/placeholder code hitting `no-unsafe-*` errors, use type annotations or `Promise.resolve()` — **don't** use `eslint-disable` comments.

### 6. TypeScript / Node version strategy

| Item              | Current                                             | Notes                                                           |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| **TypeScript**    | **5.9.x**                                           | typescript-eslint 8.x peerDep is `<6.1.0`, doesn't support TS 7 |
| **`@types/node`** | 24.x                                                | Matches Node 24 LTS                                             |
| **Module system** | ESM (`"type": "module"` + Bundler moduleResolution) |                                                                 |

**Upgrade path**: Wait for `typescript-eslint` to support TS 7, then upgrade TS 7 + Node ESM in one shot. Don't do piecemeal upgrades.

## Common Pitfalls

| Symptom                                            | Cause / Fix                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`                 | Used `workspace:*` for non-workspace package                                                               |
| `ERR_PNPM_FETCH_404` for @capacitor/*              | Added third-party framework dep to peerDeps (remove it)                                                    |
| TS can't find `@xapiforge/*`                       | Check `exports.types` points to src                                                                        |
| `Cannot find module @capacitor/...`                | You imported a third-party SDK in adapter package — remove it, let callers install                         |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@xapiforge/*` | Package `exports` missing `default` condition. Add `"default": "./src/index.ts"`                           |
| tsc cross-dir `import "../X.js"` TS2307            | tsc Bundler mode doesn't resolve parent `.js` → `.ts`. Flatten all sub-files to sibling `.js` imports      |
| `tsc --noEmit` can't find scripts/test/ modules    | scripts/test/ imports workspace packages, root tsconfig excludes them; run via `pnpm test:scenarios` (tsx) |

## CI / Husky

| Item                    | Constraint                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **pnpm version**        | 9.x                                                                                   |
| **Node version**        | 24 LTS                                                                                |
| **CI jobs**             | lint / format:check / build (GitHub Actions `ubuntu-latest`)                          |
| **Pre-commit**          | `lint:fix + format` (auto-fix what's fixable, build stays on CI)                      |
| **`--frozen-lockfile`** | Required in CI, no lockfile drift                                                     |
| **Prettier**            | Markdown tables excluded (see `.prettierrc.json` `overrides: *.md → printWidth: 999`) |

## Adding a New Package

1. `mkdir packages/<name>/src`
2. Copy `packages/core/package.json` as template, change `name` / `description`
3. Copy `packages/core/tsconfig.json` as template
4. `src/index.ts` with JSDoc + type annotations
5. `pnpm install`, verify `pnpm --filter '@xapiforge/<name>' build`

## Verification Checklist (before commit)

```bash
pnpm build       # 5 packages
pnpm lint        # 0 errors
pnpm format:check
npx tsc --noEmit  # root scripts (excludes scripts/test/)
```
