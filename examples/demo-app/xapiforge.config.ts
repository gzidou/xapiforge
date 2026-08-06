/**
 * Demo project swagger config.
 *
 * Run `pnpm download-swagger` (offline mode = no-op, snapshot included).
 * Run `pnpm generate:api demo` to generate TS API client into src/api/demo/.
 */

import { defineConfig } from "@xapiforge/genapi";

export default defineConfig({
  defaultPath: "/swagger/v1/swagger.json",
  timeoutMs: 15_000,
  outputDir: "swagger",
  genOutputDir: "src/api",
  // offline: skip download, swagger/demo/*.json already included in repo
  mode: "offline",
  projects: [
    {
      name: "demo",
      displayName: "Demo Service",
      baseHost: "http://localhost:8787",
      services: [{ name: "base", displayName: "Base API", port: 8787 }],
    },
  ],
});
