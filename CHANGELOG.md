# Changelog

All notable changes to xapiforge are documented here.

## Unreleased

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
