import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Plugin } from "esbuild";

const runtimeEnumModulePath = fileURLToPath(new URL("./runtime-enum.js", import.meta.url));
const runtimeEnumModuleDirectory = dirname(runtimeEnumModulePath);

/**
 * 配置文件只需要轻量 API，不应把完整 generator/openapi-typescript 打进临时配置 bundle。
 */
export const configApiPlugin: Plugin = {
  name: "xapiforge-config-api",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@xapiforge\/genapi$/ }, () => ({
      path: "config-api",
      namespace: "xapiforge",
    }));
    buildContext.onLoad({ filter: /.*/, namespace: "xapiforge" }, () => ({
      contents: [
        "export const defineConfig = (config) => config;",
        'export { createRuntimeEnumHooks } from "./runtime-enum.js";',
      ].join("\n"),
      loader: "js",
      resolveDir: runtimeEnumModuleDirectory,
    }));
  },
};
