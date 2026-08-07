# Changelog

All notable changes to xapiforge are documented here.

## Unreleased

- Added the breaking genapi v2 contract: required `services[].source.file|url`, canonical `SchemasByService`/`SchemaOf`, and the explicit `service-namespace`, `flat-strict`, and `canonical-only` export strategies with strict collision diagnostics.
- Added deterministic manifests, read-only `--check`, generation locking, transactional project replacement, stale-file cleanup, and interrupted-transaction recovery.
- Added strict unknown-field and internal `$ref` validation, JSON-safe canonicalization, and a deeply frozen normalized document with a mutation-safe clone for `openapi-typescript`.
- Added two intentional v2 client initialization forms: simple `NetConfig` for one shared runtime endpoint, and layered `service override > defaults` for per-service runtime boundaries.
- Added opt-in standard runtime enum maps, explicit Flags handling, metadata validation, and a runnable legacy enum service hook; framework-specific normalization remains outside the generator default path.
- Removed `AllSchemas`, legacy Swagger URL fragments, root `namespacePrefixAliases`, and compatibility switches; v2 intentionally has no legacy configuration path.
- Changed hook resolution to the documented whole-object precedence `service > project > root`; explicit `{}` disables inherited hooks.
- Added separate base, infrastructure, standard-enum, and legacy demo/test fixtures plus independent CLI coverage for config-side helper imports.
- Changed the genapi default output directory from `src/api` to `src/api/gen`; explicit `genOutputDir` and `--outputDir` overrides remain supported.
- Fixed workspace config loading so the demo can use `defineConfig` without resolving the package's TypeScript source at CLI runtime.
- Made demo download, generation, development, type checking, and production builds prepare genapi and regenerate the ignored offline API client automatically.
- Added clear entry points for first-time integrators and maintainers.
- Added the `xapiforge-integration` Skill for AI-assisted consumer inspection, integration, and evidence-based verification.
- Corrected Capacitor and React Native dependency and initialization guidance.
- Added package, scenario, native download, and documentation checks to the standard verification gate and CI.
- Added a shared version command and partial-publish recovery support for maintainers.
- Fixed browser cookie lookup for names containing regular-expression characters and documented cookie security limits.
- Stopped generating package source maps and removed implementation comments from published JavaScript while retaining declaration JSDoc for editor help.
- Declared the demo app as ESM so Vite loads its TypeScript config without the CommonJS compatibility warning.

## 0.1.4 - 2026-08-06

- Ensured `@xapiforge/genapi` installs its supported TypeScript 5.9 runtime instead of inheriting an incompatible TypeScript 7 version from a new consumer project.
- Excluded source-map files from npm packages and added standalone usage examples to every package README.

## 0.1.3 - 2026-08-06

- Added public repository metadata and package-level npm documentation.
- Documented exact-version testing for newly published local packages.

## 0.1.2 - 2026-08-06

- Made `genapi` call `openapi-typescript` through its programmatic API.
- Fixed TypeScript config loading in independent consumer projects.
- Added an independent CLI regression test covering download and generation.
- Reworked the browser onboarding guide into a minimal path and production enhancements.

## 0.1.0 - 2026-08-06

- Prepared the initial clean xapiforge monorepo and local npm publishing workflow.
