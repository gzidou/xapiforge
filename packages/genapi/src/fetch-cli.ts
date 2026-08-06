#!/usr/bin/env node
/**
 * @xapiforge/genapi — `xapiforge-fetch` CLI
 *
 * 原独立 swagger-fetch 能力已合入 genapi。
 *
 * 用法：
 *   业务项目装上 `@xapiforge/genapi` 后，配自己的 xapiforge.config.ts：
 *
 *   import { defineConfig } from "@xapiforge/genapi";
 *   export default defineConfig({ ... });
 *
 *   package.json:
 *     "scripts": { "download-swagger": "xapiforge-fetch" }
 *
 *   pnpm download-swagger
 *
 * CLI 默认读 cwd 下的 xapiforge.config.ts，遍历项目逐个下载 swagger.json。
 */

import {
  fetchSwaggerJson,
  formatBytes,
  type ServiceConfig,
  type ProjectConfig,
  type XApiForgeConfig,
} from "./swagger-fetch.js";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * 加载业务项目的 xapiforge.config。
 * 优先 .ts（用 esbuild 动态编译），fallback .js（Node 直接 import）。
 */
async function loadConfig(cwd: string): Promise<XApiForgeConfig> {
  const tsPath = `${cwd}/xapiforge.config.ts`;
  const jsPath = `${cwd}/xapiforge.config.js`;
  if (existsSync(tsPath)) {
    const result = await build({
      entryPoints: [tsPath],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
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
      "Usage: xapiforge-fetch [options]",
      "",
      "Options:",
      "  --only <list>     只下载指定项目，逗号分隔（如 demo,admin）",
      "  --dry-run         只打印 URL，不写文件",
      "  -h, --help        显示帮助",
    ].join("\n"),
  );
}

interface ParsedCli {
  only: string[];
  dryRun: boolean;
  help: boolean;
}

function parseCli(argv: string[]): ParsedCli {
  const out: ParsedCli = { only: [], dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--only") {
      const v = argv[++i] ?? "";
      out.only = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function projLabel(p: ProjectConfig): string {
  return `${p.displayName} (${p.name})`;
}
function svcLabel(s: ServiceConfig): string {
  return `${s.displayName} (${s.name})`;
}

interface DownloadResult {
  project: string;
  service: string;
  url: string | null;
  outputPath: string;
  ok: boolean;
  bytes?: number;
  error?: string;
  status?: number;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    process.exit(0);
  }
  const config = await loadConfig(process.cwd());

  if (config.projects.length === 0) {
    console.error(`xapiForgeConfig.projects 为空，请检查 xapiforge.config.ts`);
    process.exit(2);
  }

  const filterSet = cli.only.length > 0 ? new Set(cli.only) : null;
  const projects: ProjectConfig[] = filterSet
    ? config.projects.filter((p: ProjectConfig) => filterSet.has(p.name))
    : config.projects;
  if (projects.length === 0) {
    console.error(`未匹配到任何项目（--only=${cli.only.join(",")}）`);
    process.exit(2);
  }

  const total = projects.reduce((n: number, p: ProjectConfig) => n + p.services.length, 0);
  console.log(
    `\u25b6 配置: xapiforge.config.ts\n\u25b6 目标项目: ${projects.map(projLabel).join(", ")}\n\u25b6 共 ${total} 个 swagger.json${cli.dryRun ? "（dry-run）" : ""}`,
  );

  const results: DownloadResult[] = [];
  const outBase = resolve(process.cwd(), config.outputDir);
  const isOffline = config.mode === "offline";

  if (isOffline) {
    console.log(
      `\u26a0  mode=offline：跳过下载，假设 ${config.outputDir}/{project}/{service}.json 已存在`,
    );
  }

  for (const proj of projects) {
    for (const svc of proj.services) {
      const tag = `${proj.name}/${svc.name}`;
      const outputPath = join(outBase, proj.name, `${svc.name}.json`);

      // offline mode：检查文件是否存在，存在就跳过，不存在就报错
      if (isOffline) {
        if (existsSync(outputPath)) {
          const st = await stat(outputPath);
          console.log(
            `  [\u2713] ${tag} \u2014 ${projLabel(proj)} / ${svcLabel(svc)} \u2192 已存在 (${formatBytes(st.size)})`,
          );
          results.push({
            project: proj.name,
            service: svc.name,
            url: null,
            outputPath,
            ok: true,
            bytes: st.size,
          });
          continue;
        }
        const errMsg = `swagger/${proj.name}/${svc.name}.json 不存在（offline 模式）`;
        console.log(`  [FAIL] ${tag} \u2014 ${errMsg}`);
        results.push({
          project: proj.name,
          service: svc.name,
          url: null,
          outputPath,
          ok: false,
          error: errMsg,
        });
        continue;
      }

      const res = await fetchSwaggerJson({
        defaultPath: config.defaultPath,
        timeoutMs: config.timeoutMs,
        project: {
          name: proj.name,
          displayName: proj.displayName,
          baseHost: proj.baseHost,
          services: proj.services,
        },
        serviceName: svc.name,
      });

      if (res.url === null && res.ok) {
        console.log(
          `  [\u23ed ] ${tag} \u2014 ${projLabel(proj)} / ${svcLabel(svc)} \u2192 \u26a0 占位（port: 0，暂未联调）`,
        );
        results.push({ project: proj.name, service: svc.name, url: null, outputPath, ok: true });
        continue;
      }

      if (cli.dryRun) {
        console.log(
          `  [dry] ${tag} \u2014 ${projLabel(proj)} / ${svcLabel(svc)} \u2192 ${res.url}`,
        );
        results.push({ project: proj.name, service: svc.name, url: res.url, outputPath, ok: true });
        continue;
      }

      process.stdout.write(
        `  [..] ${tag} \u2014 ${projLabel(proj)} / ${svcLabel(svc)} \u2192 ${res.url} ... `,
      );
      if (!res.ok || !res.text) {
        const errMsg = res.error ?? "unknown error";
        console.log(`FAIL \u2014 ${errMsg}`);
        results.push({
          project: proj.name,
          service: svc.name,
          url: res.url,
          outputPath,
          ok: false,
          error: errMsg,
          status: res.status,
        });
        continue;
      }

      try {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, res.text, "utf8");
        console.log(`OK (${formatBytes(res.bytes ?? 0)})`);
        results.push({
          project: proj.name,
          service: svc.name,
          url: res.url,
          outputPath,
          ok: true,
          bytes: res.bytes,
        });
      } catch (e) {
        const err = e as Error;
        console.log(`FAIL \u2014 writeFile: ${err.message}`);
        results.push({
          project: proj.name,
          service: svc.name,
          url: res.url,
          outputPath,
          ok: false,
          error: `writeFile: ${err.message}`,
        });
      }
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const totalBytes = results.reduce((n, r) => n + (r.bytes ?? 0), 0);

  console.log("");
  console.log("--- 汇总 ---");
  console.log(`成功: ${ok}  失败: ${fail}  总大小: ${formatBytes(totalBytes)}`);

  if (fail > 0) {
    console.log("\n失败明细:");
    for (const r of results) {
      if (r.ok) continue;
      const status = r.status ? ` [HTTP ${r.status}]` : "";
      console.log(`  - ${r.project}/${r.service}${status}: ${r.error}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!cli.dryRun) {
    console.log("\n\u2705 全部下载完成");
  }
}

main()
  .catch((e) => {
    console.error(`\u274c 未捕获异常: ${(e as Error).message}`);
    process.exit(1);
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
