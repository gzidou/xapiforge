# @xapiforge/genapi

OpenAPI-to-TypeScript client generator for xapiforge projects.

```bash
pnpm add -D @xapiforge/genapi
```

Add the CLI scripts to your application:

```json
{
  "scripts": {
    "download-swagger": "xapiforge-fetch",
    "generate:api": "xapiforge"
  }
}
```

Then create `xapiforge.config.ts` and run:

```bash
pnpm download-swagger
pnpm generate:api myapp
```

See the [browser onboarding guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/browser.md) for a complete example.
