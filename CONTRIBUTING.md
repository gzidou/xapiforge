# Contributing to xapiforge

Thanks for your interest in contributing! This guide covers the basics.

## Prerequisites

- Node.js 20.19+ (24 LTS recommended)
- pnpm 9+

## Setup

```bash
git clone https://github.com/gzidou/xapiforge.git
cd xapiforge
pnpm install --frozen-lockfile
pnpm verify
```

## Development Workflow

1. Create a branch: `git checkout -b feat/your-feature`
2. Make changes
3. Run the complete verification gate:
   ```bash
   pnpm verify
   ```
4. Commit with a clear message
5. Open a PR

## Pre-commit Hook

Husky runs `lint:fix + format` on staged files automatically. Build verification runs in CI.

## Code Style

- TypeScript strict mode everywhere
- ESM (`"type": "module"`)
- No `eslint-disable` comments (fix the type issue instead)
- See [AGENTS.md](./AGENTS.md) for detailed conventions

## Testing

```bash
pnpm test:scenarios    # library-level scenario tests
pnpm mock              # start mock-server (port 8787)
```

For browser-level regression checks, run `pnpm mock`, start `examples/demo-app`, then run `pnpm test:demo-app` or open `/scenarios` and click "Run All". The automated command requires Python Playwright and Chromium; see the [validation guide](./docs/internals/validation.md) for setup.

Maintainers responsible for releases, CI, or documentation should start with the [maintenance guide](./docs/internals/maintenance.md).

## Adding a New Package

See [AGENTS.md > Adding a New Package](./AGENTS.md#adding-a-new-package).

## Reporting Issues

- Use GitHub Issues
- Include: Node version, pnpm version, OS, minimal reproduction
- Check existing issues first
