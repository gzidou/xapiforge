---
name: xapiforge-integration
description: Inspect and integrate xapiforge into new or existing TypeScript applications, including Vue, React, browser, Ionic/Capacitor, React Native, and generated OpenAPI clients. Use when an AI coding agent is asked to install or migrate to @xapiforge packages, create xapiforge.config.ts, generate API clients, connect AuthService and a TokenStore, add middleware or downloads, diagnose integration failures, or verify that a consumer project is correctly connected.
---

# Integrate xapiforge

Complete one small, working API path in the consumer project. Inspect first, preserve the host project's conventions, and validate the result with its own toolchain.

## Inspect before changing files

1. Read the consumer repository's `AGENTS.md`, contributing guide, package manifest, lockfiles, TypeScript config, existing API layer, authentication code, and environment configuration.
2. Run the bundled inspector from the Skill directory:

   ```bash
   node scripts/inspect-project.mjs <consumer-project-root>
   ```

3. Treat the report as evidence, not authority. Confirm ambiguous runtime signals in source code.
4. Preserve the package manager selected by the existing lockfile. Do not create a second lockfile.
5. Locate the real OpenAPI document or URL, API base URL, and authentication contract. If they cannot be derived from code or supplied artifacts, ask for them instead of inventing values.

Read [integration-paths.md](references/integration-paths.md) after identifying the runtime. Read [verification.md](references/verification.md) before declaring completion.

## Select one runtime path

- Browser Vue, React, or other Web application: use `@xapiforge/adapter-browser`.
- Ionic/Capacitor application: use `@xapiforge/adapter-capacitor` and install only the Capacitor plugins actually used.
- React Native or Expo application: use `@xapiforge/adapter-react-native`.

Install `@xapiforge/core` and exactly one runtime adapter as application dependencies. Install `@xapiforge/genapi` as a development dependency. Do not add direct `openapi-fetch` or `openapi-typescript` dependencies unless the consumer already uses their public APIs independently of xapiforge.

## Build the smallest vertical slice

### 1. Configure generation

Create `xapiforge.config.ts` at the consumer project root. Derive every project, service, host, port, path, output directory, and mode from the consumer's real contract.

Use `defineConfig` from `@xapiforge/genapi`. Keep `ProjectConfig.name` and service names stable English identifiers because they become directories and generated properties. Use `displayName` only for human-readable logs.

Choose one mode deliberately:

- `online`: download the OpenAPI document from the configured service.
- `offline`: use a reviewed local file at `<outputDir>/<project>/<service>.json`.

Prefer a checked-in OpenAPI snapshot when reproducibility matters or the build environment cannot reach the backend.

### 2. Add consumer scripts

Add scripts equivalent to:

```json
{
  "download-swagger": "xapiforge-fetch",
  "generate:api": "xapiforge"
}
```

Use the consumer's package manager to run them. Pass the configured project ID to `generate:api` when required.

Do not edit generated files to fix a repeatable generation problem. Fix the input specification, consumer hooks, or configuration, then regenerate.

### 3. Initialize one generated client

Import the generated `create<Project>Client`, construct `AuthService`, select the runtime TokenStore, and pass both the real `baseURL` and `authService` to the generated factory.

Keep login and refresh requests outside the authenticated generated client so they cannot recurse through the 401 refresh middleware. Reuse the consumer's existing auth service when it already owns token epochs, logout, navigation, or race handling.

Do not copy OAuth paths, `client_id`, scopes, token field names, business envelope codes, or demo URLs from xapiforge examples. Map them from the actual backend.

### 4. Add one real request

Choose a safe endpoint that proves generated service and path types work. Prefer a health, profile, or read-only list endpoint. Use the generated service property and let TypeScript validate method, path, params, body, and result.

Handle loading and failure states. Preserve `ApiError`, `AuthError`, and `NetworkError` distinctions when the consumer UI already has an error policy. Log diagnostic details only where the host project allows them.

### 5. Add optional behavior only when required

- Add business envelope middleware in the consumer project, not xapiforge core.
- Use genapi hooks for non-standard OpenAPI shapes; do not embed backend-framework rules into the library.
- Choose browser, native, or application-owned download behavior from the actual file size and runtime.
- Add `@xapiforge/vconsole-debug` only for an explicit debugging requirement and keep it disabled in production by default.

## Migrate an existing client incrementally

Inventory old package imports, config filenames, generated directories, auth ownership, middleware, and consuming call sites before replacing anything. Generate xapiforge output beside the old client, migrate one safe endpoint, and compare its request and error behavior. Remove the old path only after the consumer checks and observed request pass. Keep a compatibility path when another application or an imminent demonstration still depends on the old package.

## Validate honestly

Run the consumer project's formatting, lint, type check, tests, and production build that are relevant to the changed files. Then exercise at least one generated request against a permitted backend or mock.

Run the consumer's dependency audit when its maintenance policy requires one. Report direct and transitive findings separately; never run an automatic audit fix that can change dependency versions without reviewing the resulting lockfile and compatibility impact.

For Capacitor and React Native, TypeScript success is not enough: run the project's native sync/link step and verify at least one target platform when the environment is available.

Report separately:

- what was changed;
- which commands passed;
- which real or mock request was observed;
- what was not run and why;
- remaining backend, credential, device, CORS, or certificate dependencies.

Never claim successful integration from package installation or code generation alone.

## Guardrails

- Do not expose tokens, passwords, private OpenAPI URLs, cookies, or `.env` values in output or committed files.
- Do not replace an existing API/auth architecture without explaining the compatibility impact and receiving approval for material behavior changes.
- Do not install all adapters “just in case.”
- Do not introduce another package manager.
- Do not bypass type errors with `any`, blanket casts, generated-file edits, or lint-disable comments.
- Do not change xapiforge library source while working in a consumer repository unless the failure is reproduced as a library defect and the user authorizes cross-repository work.
- Use current package exports and current documentation. If installed package behavior differs from the latest docs, inspect the installed version instead of assuming compatibility.

## Canonical documentation

Use the repository docs when available. Otherwise use <https://gzidou.github.io/xapiforge/>. Start with the runtime guide, then open authentication, error handling, middleware, hooks, or file-download guidance only when the task needs it.
