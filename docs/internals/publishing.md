# Publishing packages

This document is the maintainer runbook for publishing `@xapiforge/*` packages.

Publishing is intentionally manual. The repository provides scripts to reduce mistakes, but no script should publish to a real registry unless the maintainer explicitly chooses the target and confirms the action.

## Package set

The root package is private and must stay private. Only these workspace packages are publishable:

| Package                           | Role                                 |
| --------------------------------- | ------------------------------------ |
| `@xapiforge/core`                 | HTTP client, auth, middleware core   |
| `@xapiforge/genapi`               | OpenAPI codegen and CLI              |
| `@xapiforge/adapter-browser`      | Browser TokenStore adapter           |
| `@xapiforge/adapter-capacitor`    | Capacitor TokenStore/native adapter  |
| `@xapiforge/adapter-react-native` | React Native TokenStore adapter      |
| `@xapiforge/vconsole-debug`       | Framework-agnostic vConsole debugger |

All scoped packages use `publishConfig.access = "public"`. The registry is not hard-coded in package manifests; the publish script decides it at runtime.

Package manifests keep source-adjacent exports for monorepo development. During `pnpm pack` / `pnpm publish`, `publishConfig` overrides the published manifest so npm consumers resolve `dist/index.js` and `dist/index.d.ts`.

## Registry switch

Use `scripts/publish-packages.ts`.

| Target   | Registry source                                                  | Typical use                |
| -------- | ---------------------------------------------------------------- | -------------------------- |
| `local`  | `XAPIFORGE_LOCAL_NPM_REGISTRY`, fallback `http://localhost:4873` | Local npm / Verdaccio test |
| `npm`    | `https://registry.npmjs.org/`                                    | Public npm release         |
| `custom` | Required `--registry <url>`                                      | Company/private registry   |

Safety rule: dry-run is the default. Real publishing requires `--confirm`.

## Before publishing

Start from a clean repository:

```bash
git status --short --branch
```

Run the publish gate:

```bash
pnpm publish:check
```

This runs package build, typecheck, formatting, lint, library scenarios, and native download tests. Browser demo regression can be run separately when Playwright is available:

```bash
pnpm test:demo-app
```

The publish scripts `publish:dry-run`, `publish:local`, and `publish:npm` run this gate automatically before packing or publishing.

## Local registry test

Start your local npm registry first. For Verdaccio the usual default is:

```bash
verdaccio
```

If your local registry is not `http://localhost:4873`, pass it through an environment variable:

```bash
XAPIFORGE_LOCAL_NPM_REGISTRY=http://localhost:4873 pnpm publish:local
```

`pnpm publish:local` performs a real publish to the local registry. It is safe only if the registry points to your local test server.

Then test install from a temporary consumer project:

```bash
mkdir /tmp/xapiforge-consumer
cd /tmp/xapiforge-consumer
pnpm init
XAPIFORGE_TEST_VERSION=0.1.2
pnpm add "@xapiforge/core@${XAPIFORGE_TEST_VERSION}" "@xapiforge/adapter-browser@${XAPIFORGE_TEST_VERSION}" --registry http://localhost:4873
pnpm add -D "@xapiforge/genapi@${XAPIFORGE_TEST_VERSION}" --registry http://localhost:4873
```

Always specify the version that was just published. A consumer with pnpm's `minimumReleaseAge` policy may otherwise select an older version even when the local registry's `latest` tag is correct.

For a disposable local verification project, you may temporarily add this to `pnpm-workspace.yaml` before installing the just-published packages:

```yaml
minimumReleaseAge: 0
```

Do not copy that relaxation into a production project without reviewing its supply-chain policy.

## Public npm dry-run

Always do this before a real public release:

```bash
pnpm publish:dry-run
```

The dry-run packs and validates each package without uploading it.

## Public npm release

Log in first:

```bash
npm login
npm whoami
```

If the account requires two-factor authentication, pass the one-time password:

```bash
pnpm exec tsx scripts/publish-packages.ts --target npm --confirm --otp 123456
```

Without 2FA:

```bash
pnpm publish:npm
```

After publishing, verify from a temporary consumer project:

```bash
mkdir /tmp/xapiforge-npm-consumer
cd /tmp/xapiforge-npm-consumer
pnpm init
pnpm add @xapiforge/core @xapiforge/genapi
```

## Notes

- `workspace:*` dependencies are kept in source. pnpm rewrites them to real package versions when packing or publishing workspace packages.
- Do not commit `.npmrc` with real tokens. Use `.npmrc.example` as a template.
- Do not publish from a dirty worktree unless you are intentionally testing a local registry.
- The script publishes packages in dependency-aware order, starting with `@xapiforge/core`.
