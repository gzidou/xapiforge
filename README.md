# xapiforge

[![CI](https://github.com/xapiforge/xapiforge/actions/workflows/ci.yml/badge.svg)](https://github.com/xapiforge/xapiforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pnpm 9](https://img.shields.io/badge/pnpm-9-orange.svg)](https://pnpm.io/)
[![Node 24](https://img.shields.io/badge/node-24 LTS-green.svg)](https://nodejs.org/)

Framework-agnostic HTTP client + OpenAPI codegen toolkit. One `@xapiforge/core` package works across Vue / React / React Native / Ionic.

## Features

- **API Codegen** — Generate typed TypeScript API clients from OpenAPI/Swagger specs (`@xapiforge/genapi`)
- **Token Refresh** — Single-flight + window guard + timeout, built into the core (`@xapiforge/core`)
- **Framework-agnostic** — Zero framework deps. Pick a TokenStore adapter per runtime (browser / Capacitor / RN)
- **Middleware Chain** — Business-side envelope unwrapping via middleware, no library lock-in
- **File Download** — Progress callback + filename extraction + stream support
- **Retry & Backoff** — 429 Retry-After + 5xx exponential backoff, configurable
- **Business Debugging** — Framework-agnostic vConsole diagnostics, Storage snapshots, redaction, and safe actions

## Packages

| Package                                                               | Description                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`@xapiforge/core`](./packages/core/)                                 | Core: HttpClient + AuthService + createNet + middleware chain           |
| [`@xapiforge/adapter-browser`](./packages/adapter-browser/)           | Browser TokenStore (localStorage / sessionStorage)                      |
| [`@xapiforge/adapter-capacitor`](./packages/adapter-capacitor/)       | Capacitor TokenStore + native HTTP + file download                      |
| [`@xapiforge/adapter-react-native`](./packages/adapter-react-native/) | RN TokenStore (Keychain / EncryptedStorage)                             |
| [`@xapiforge/genapi`](./packages/genapi/)                             | OpenAPI → TypeScript API client generator + swagger.json download CLI   |
| [`@xapiforge/vconsole-debug`](./packages/vconsole-debug/)             | Framework-agnostic vConsole business diagnostics and safe debug actions |

## Quick Start

```bash
pnpm install
pnpm build          # build all packages
pnpm docs:dev       # start docs site (VitePress, port 5174)
```

See the [browser integration guide](./docs/getting-started/browser.md) for a full walkthrough.

## Examples

- [`examples/demo-app`](./examples/demo-app/) — Vue 3 integration demo with a one-click scenario regression page

## Documentation

| Section                                              | Audience    | Content                                                            |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| [Getting Started](./docs/getting-started/browser.md) | Integrators | Step-by-step integration                                           |
| [Guides](./docs/guides/auth.md)                      | Developers  | Auth / middleware / download / error handling / vConsole debugging |
| [Internals](./docs/internals/architecture-v0.2.md)   | Maintainers | Architecture / scenarios / backend protocols                       |

Local docs: `pnpm docs:dev` → http://localhost:5174

## Scripts

```bash
pnpm build           # build all packages
pnpm lint            # ESLint strict mode
pnpm format:check    # Prettier check
pnpm test:scenarios  # library-level scenario tests
pnpm test:demo-app   # browser-level scenario regression (requires mock + demo-app dev)
pnpm mock            # start local mock-server (port 8787)
pnpm docs:dev        # VitePress dev server
pnpm docs:build      # VitePress production build
```

## Requirements

- Node.js 20.19+ (24 LTS recommended)
- pnpm 9+

## License

[MIT](./LICENSE)
