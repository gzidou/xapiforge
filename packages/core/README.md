# @xapiforge/core

Framework-agnostic TypeScript HTTP client built on `fetch` and OpenAPI-generated path types.

## Install

```bash
pnpm add @xapiforge/core
```

## Basic request

```typescript
import { HttpClient } from "@xapiforge/core";

const http = new HttpClient({
  baseURL: "https://api.example.com",
  defaultTimeoutMs: 15_000
});

const response = await http.request({
  method: "GET",
  path: "/health",
  responseType: "json"
});

if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = JSON.parse(response.bodyText) as { status: string };
```

For OpenAPI-generated clients, authentication, middleware, retry behavior, and data-or-throw error handling, see the [browser onboarding guide](https://github.com/gzidou/xapiforge/blob/main/docs/getting-started/browser.md).
