#!/usr/bin/env node
/**
 * @xapiforge/genapi CLI
 *
 * 用法：
 *   业务项目装上 `@xapiforge/genapi` 后，配自己的 xapiforge.config.ts：
 *
 *   import { defineConfig } from "@xapiforge/genapi";
 *   export default defineConfig({ ... });
 *
 *   package.json:
 *     "scripts": { "generate:api": "xapiforge demo" }
 *
 *   pnpm generate:api
 *
 * CLI 默认读 cwd 下的 xapiforge.config.ts，调 generate() 输出。
 * - swaggerDir 默认 "swagger"
 * - outputDir  默认 "src/api/gen"
 * - projectId  从 CLI 参数取（必填）；all 表示全部生成
 */

import { generateMany, validateConfig, type XApiForgeConfig } from "./index.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

const configApiPlugin: Plugin = {
  name: "xapiforge-config-api",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@xapiforge\/genapi$/ }, () => ({
      path: "config-api",
      namespace: "xapiforge",
    }));
    buildContext.onLoad({ filter: /.*/, namespace: "xapiforge" }, () => ({
      contents: "export const defineConfig = (config) => config;",
      loader: "js",
    }));
  },
};

/**
 * 加载业务项目的 xapiforge.config。
 * 优先 .ts（用 esbuild 动态编译），fallback .js（Node 直接 import）。
 */
async function loadConfig(cwd: string): Promise<XApiForgeConfig> {
  const tsPath = `${cwd}/xapiforge.config.ts`;
  const jsPath = `${cwd}/xapiforge.config.js`;
  if (existsSync(tsPath)) {
    // esbuild 把 .ts 编译成临时文件，再 dynamic import
    const result = await build({
      entryPoints: [tsPath],
      bundle: true,
      packages: "external",
      plugins: [configApiPlugin],
      format: "esm",
      platform: "node",
      write: false, // 输出到内存
      target: "node20",
    });
    const code = result.outputFiles[0]?.text;
    if (!code) throw new Error(`esbuild build failed for ${tsPath}`);
    const cacheDir = join(cwd, "node_modules", ".cache", "xapiforge");
    mkdirSync(cacheDir, { recursive: true });
    const compiledPath = join(cacheDir, `config-${process.pid}-${Date.now()}.mjs`);
    writeFileSync(compiledPath, code, "utf8");
    try {
      const mod = (await import(pathToFileURL(compiledPath).href)) as {
        default?: XApiForgeConfig;
        xapiForgeConfig?: XApiForgeConfig;
      };
      const config = mod.default ?? mod.xapiForgeConfig;
      if (!config) {
        throw new Error(`xapiforge.config.ts must export default config or 'xapiForgeConfig'`);
      }
      return config;
    } finally {
      rmSync(compiledPath, { force: true });
    }
  }
  if (existsSync(jsPath)) {
    const mod = (await import(pathToFileURL(jsPath).href)) as {
      default?: XApiForgeConfig;
      xapiForgeConfig?: XApiForgeConfig;
    };
    const config = mod.default ?? mod.xapiForgeConfig;
    if (!config)
      throw new Error(`xapiforge.config.js must export default config or 'xapiForgeConfig'`);
    return config;
  }
  throw new Error(`xapiforge.config not found: ${tsPath} or ${jsPath}`);
}

function printHelp(): void {
  console.log(
    [
      "Usage: xapiforge <projectId|all|list> [options]",
      "",
      "Arguments:",
      "  projectId             生成单个项目（如 demo / admin）",
      "  all                   生成全部项目",
      "  list                  列出 xapiForgeConfig.projects 里的项目",
      "",
      "Options:",
      "  --swaggerDir <dir>    swagger.json 根目录（默认从 xapiforge.config.ts.outputDir 读）",
      "  --outputDir <dir>     生成产物根目录（默认从 xapiforge.config.ts.genOutputDir 读，否则 'src/api/gen'）",
      "  --no-types            跳过 api-types.ts（业务侧调试时用，默认生成）",
      "  --check               只比较生成结果；有漂移返回非 0，不写文件",
      "  -h, --help            显示帮助",
    ].join("\n"),
  );
}

interface ParsedCli {
  arg: string;
  swaggerDir: string;
  /** 未被 --outputDir 覆盖时是空字符串（fallback 用 config.genOutputDir ?? "src/api/gen"） */
  outputDir: string;
  noTypes: boolean;
  check: boolean;
  help: boolean;
}

function parseCli(argv: string[]): ParsedCli {
  const out: ParsedCli = {
    arg: "",
    swaggerDir: "",
    outputDir: "",
    noTypes: false,
    check: false,
    help: false,
  };
  const positionals: string[] = [];
  const readValue = (option: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`${option} 缺少参数值`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--") continue;
    else if (a === "--swaggerDir") {
      out.swaggerDir = readValue(a, i);
      i += 1;
    } else if (a === "--outputDir") {
      out.outputDir = readValue(a, i);
      i += 1;
    } else if (a === "--no-types") out.noTypes = true;
    else if (a === "--check") out.check = true;
    else if (a.startsWith("-")) throw new Error(`未知参数：${a}`);
    else positionals.push(a);
  }
  if (positionals.length > 1) throw new Error(`只能指定一个 project：${positionals.join(", ")}`);
  out.arg = positionals[0] ?? "";
  return out;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help || !cli.arg) {
    printHelp();
    if (cli.help) process.exit(0);
    process.exit(2);
  }
  const config = await loadConfig(process.cwd());
  validateConfig(config);

  if (cli.arg === "list") {
    if (cli.swaggerDir || cli.outputDir || cli.noTypes || cli.check) {
      throw new Error("list 不接受生成选项");
    }
    console.log("xapiForgeConfig.projects:");
    for (const p of config.projects) {
      console.log(`  - ${p.name} (${p.displayName}): ${p.services.length} services`);
    }
    return;
  }

  const targets =
    cli.arg === "all" ? config.projects : config.projects.filter((p) => p.name === cli.arg);
  if (targets.length === 0) {
    console.error(`未找到项目: ${cli.arg}`);
    process.exit(2);
  }

  // 输出目录解析顺序：CLI --outputDir > xapiforge.config.ts genOutputDir > "src/api/gen"
  // swaggerDir 同理（CLI > config.outputDir > "swagger"）
  const outputDir = cli.outputDir || config.genOutputDir || "src/api/gen";
  const swaggerDir = cli.swaggerDir || config.outputDir;

  const results = await generateMany(
    targets.map((project) => ({
      xapiForgeConfig: config,
      projectId: project.name,
      swaggerDir,
      outputDir,
      emitApiTypes: !cli.noTypes,
      check: cli.check,
      hooks: config.hooks,
    })),
  );

  let totalFiles = 0;
  let totalEndpoints = 0;
  for (const [index, result] of results.entries()) {
    const project = targets[index]!;
    const status = cli.check && result.changed ? "DRIFT" : result.changed ? "OK" : "UNCHANGED";
    console.log(
      `${status} ${project.name} (${project.displayName}): ${result.serviceNames.length} services, ${result.totalEndpoints} endpoints, ${result.filesWritten} files`,
    );
    if (result.changedFiles.length > 0) {
      for (const file of result.changedFiles) console.log(`  - ${file}`);
    }
    totalFiles += result.filesWritten;
    totalEndpoints += result.totalEndpoints;
    if (cli.check && result.changed) process.exitCode = 1;
  }

  console.log("");
  console.log(
    `--- 汇总: ${targets.length} 项目, ${totalFiles} 文件, ${totalEndpoints} endpoints ---`,
  );
}

main()
  .catch((e) => {
    console.error(`\u274c 未捕获异常: ${(e as Error).message}`);
    process.exit(1);
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
