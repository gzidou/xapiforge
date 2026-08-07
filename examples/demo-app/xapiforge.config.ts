/**
 * Demo project swagger config.
 *
 * Run `pnpm download-swagger` (offline mode validates the local source files).
 * Run `pnpm generate:api demo` to generate TS API client into src/api/gen/demo/.
 */

import { createRuntimeEnumHooks, defineConfig } from "@xapiforge/genapi";
import { legacyEnumHooks } from "./hooks/legacy-enum.js";

export default defineConfig({
  timeoutMs: 15_000,
  outputDir: "swagger",
  genOutputDir: "src/api/gen",
  // offline: source.file is validated and read directly; no network access.
  mode: "offline",
  projects: [
    {
      name: "demo",
      displayName: "Demo Service",
      services: [
        {
          name: "base",
          displayName: "Base API",
          source: { file: "swagger/demo/base.json" },
        },
        {
          name: "infrastructure",
          displayName: "Infrastructure API",
          source: { file: "swagger/demo/infrastructure.json" },
          hooks: createRuntimeEnumHooks(),
        },
        {
          name: "legacy",
          displayName: "Legacy API fixture",
          source: { file: "swagger/demo/legacy.json" },
          hooks: legacyEnumHooks,
        },
      ],
    },
  ],
});
