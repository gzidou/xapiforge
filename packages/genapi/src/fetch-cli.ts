#!/usr/bin/env node
/**
 * @xapiforge/genapi — `xapiforge-fetch` CLI。
 *
 * - source.file：直接校验并复用配置指定文件，不复制、不改名。
 * - source.url：online 下载到 outputDir/{project}/{service}.json 标准缓存；
 *   offline 只校验该缓存。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { configApiPlugin } from "./config-api-plugin.js";
import {
  defineConfig,
  validateConfig,
  type ProjectConfig,
  type ServiceConfig,
  type XApiForgeConfig,
} from "./index.js";
import { isSwaggerFileSource, resolveSwaggerInputPath } from "./swagger-source.js";
import { fetchSwaggerJson, formatBytes } from "./swagger-fetch.js";

/** 加载 cwd 下的 TypeScript 或 JavaScript 配置。 */
async function loadConfig(cwd: string): Promise<XApiForgeConfig> {
  const tsPath = join(cwd, "xapiforge.config.ts");
  const jsPath = join(cwd, "xapiforge.config.js");
  if (existsSync(tsPath)) {
    const result = await build({
      entryPoints: [tsPath],
      bundle: true,
      packages: "external",
      plugins: [configApiPlugin],
      format: "esm",
      platform: "node",
      write: false,
      target: "node20",
    });
    const code = result.outputFiles[0]?.text;
    if (!code) throw new Error(`esbuild build failed for ${tsPath}`);
    const cacheDirectory = join(cwd, "node_modules", ".cache", "xapiforge");
    await mkdir(cacheDirectory, { recursive: true });
    const compiledPath = join(cacheDirectory, `config-${process.pid}-${Date.now()}.mjs`);
    await writeFile(compiledPath, code, "utf8");
    try {
      const module = (await import(pathToFileURL(compiledPath).href)) as {
        default?: XApiForgeConfig;
        xapiForgeConfig?: XApiForgeConfig;
      };
      const config = module.default ?? module.xapiForgeConfig;
      if (!config) {
        throw new Error("xapiforge.config.ts 必须 default export 或导出 xapiForgeConfig");
      }
      return defineConfig(config);
    } finally {
      await rm(compiledPath, { force: true });
    }
  }
  if (existsSync(jsPath)) {
    const module = (await import(pathToFileURL(jsPath).href)) as {
      default?: XApiForgeConfig;
      xapiForgeConfig?: XApiForgeConfig;
    };
    const config = module.default ?? module.xapiForgeConfig;
    if (!config) {
      throw new Error("xapiforge.config.js 必须 default export 或导出 xapiForgeConfig");
    }
    return defineConfig(config);
  }
  throw new Error(`xapiforge.config not found: ${tsPath} or ${jsPath}`);
}

interface ParsedCli {
  only: string[];
  dryRun: boolean;
  help: boolean;
}

function parseCli(argv: readonly string[]): ParsedCli {
  const result: ParsedCli = { only: [], dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-h" || argument === "--help") {
      result.help = true;
    } else if (argument === "--dry-run") {
      result.dryRun = true;
    } else if (argument === "--only") {
      result.only = (argv[(index += 1)] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return result;
}

function printHelp(): void {
  console.log(
    [
      "Usage: xapiforge-fetch [options]",
      "",
      "Options:",
      "  --only <list>     只处理指定项目，逗号分隔",
      "  --dry-run         校验本地来源；远程来源只打印 URL，不下载",
      "  -h, --help        显示帮助",
    ].join("\n"),
  );
}

function projectLabel(project: ProjectConfig): string {
  return `${project.displayName} (${project.name})`;
}

function serviceLabel(service: ServiceConfig): string {
  return `${service.displayName} (${service.name})`;
}

interface SourceResult {
  project: string;
  service: string;
  source: string;
  outputPath: string | null;
  ok: boolean;
  bytes?: number;
  error?: string;
  status?: number;
}

async function validateJsonFile(path: string): Promise<number> {
  const text = await readFile(path, "utf8");
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 无效：${error instanceof Error ? error.message : String(error)}`);
  }
  return (await stat(path)).size;
}

/** 同目录临时文件 + rename，避免下载中断留下半个 JSON 缓存。 */
async function writeCacheAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function processFileSource(options: {
  cwd: string;
  swaggerRoot: string;
  project: ProjectConfig;
  service: ServiceConfig;
}): Promise<SourceResult> {
  const { cwd, swaggerRoot, project, service } = options;
  const inputPath = resolveSwaggerInputPath({
    configDirectory: cwd,
    swaggerRoot,
    projectId: project.name,
    service,
  });
  try {
    const bytes = await validateJsonFile(inputPath);
    console.log(
      `  [✓] ${project.name}/${service.name} — ${projectLabel(project)} / ${serviceLabel(service)} → file:${inputPath} (${formatBytes(bytes)})`,
    );
    return {
      project: project.name,
      service: service.name,
      source: `file:${inputPath}`,
      outputPath: null,
      ok: true,
      bytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  [FAIL] ${project.name}/${service.name} — file:${inputPath} — ${message}`);
    return {
      project: project.name,
      service: service.name,
      source: `file:${inputPath}`,
      outputPath: null,
      ok: false,
      error: message,
    };
  }
}

async function processUrlSource(options: {
  swaggerRoot: string;
  project: ProjectConfig;
  service: ServiceConfig;
  timeoutMs: number;
  offline: boolean;
  dryRun: boolean;
}): Promise<SourceResult> {
  const { swaggerRoot, project, service, timeoutMs, offline, dryRun } = options;
  if (isSwaggerFileSource(service.source)) {
    throw new Error("[genapi] internal: processUrlSource received source.file");
  }
  const tag = `${project.name}/${service.name}`;
  const url = service.source.url;
  const outputPath = resolve(swaggerRoot, project.name, `${service.name}.json`);

  // dry-run 是显式 CLI 行为，优先于 online/offline：远程来源永远不访问网络或缓存。
  if (dryRun) {
    console.log(`  [dry] ${tag} → ${url} => ${outputPath}`);
    return {
      project: project.name,
      service: service.name,
      source: url,
      outputPath,
      ok: true,
    };
  }

  if (offline) {
    try {
      const bytes = await validateJsonFile(outputPath);
      console.log(`  [✓] ${tag} — cache:${outputPath} (${formatBytes(bytes)})`);
      return {
        project: project.name,
        service: service.name,
        source: url,
        outputPath,
        ok: true,
        bytes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  [FAIL] ${tag} — cache:${outputPath} — ${message}`);
      return {
        project: project.name,
        service: service.name,
        source: url,
        outputPath,
        ok: false,
        error: message,
      };
    }
  }

  process.stdout.write(`  [..] ${tag} → ${url} ... `);
  const response = await fetchSwaggerJson({ source: service.source, timeoutMs });
  if (!response.ok || response.text === undefined) {
    const error = response.error ?? "unknown error";
    console.log(`FAIL — ${error}`);
    return {
      project: project.name,
      service: service.name,
      source: url,
      outputPath,
      ok: false,
      error,
      status: response.status,
    };
  }

  try {
    await writeCacheAtomically(outputPath, response.text);
    console.log(`OK (${formatBytes(response.bytes ?? 0)})`);
    return {
      project: project.name,
      service: service.name,
      source: url,
      outputPath,
      ok: true,
      bytes: response.bytes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL — write cache: ${message}`);
    return {
      project: project.name,
      service: service.name,
      source: url,
      outputPath,
      ok: false,
      error: `write cache: ${message}`,
    };
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  validateConfig(config);
  const selected = cli.only.length === 0 ? null : new Set(cli.only);
  const projects = selected
    ? config.projects.filter((project) => selected.has(project.name))
    : config.projects;
  if (projects.length === 0) {
    throw new Error(`未匹配到任何项目（--only=${cli.only.join(",")}）`);
  }

  const swaggerRoot = resolve(cwd, config.outputDir);
  const offline = config.mode === "offline";
  const total = projects.reduce((sum, project) => sum + project.services.length, 0);
  console.log(
    `▶ 目标项目: ${projects.map(projectLabel).join(", ")}\n▶ 共 ${total} 个 OpenAPI source${cli.dryRun ? "（dry-run）" : offline ? "（offline）" : ""}`,
  );

  const results: SourceResult[] = [];
  for (const project of projects) {
    for (const service of project.services) {
      results.push(
        isSwaggerFileSource(service.source)
          ? await processFileSource({ cwd, swaggerRoot, project, service })
          : await processUrlSource({
              swaggerRoot,
              project,
              service,
              timeoutMs: config.timeoutMs,
              offline,
              dryRun: cli.dryRun,
            }),
      );
    }
  }

  const failures = results.filter((result) => !result.ok);
  const totalBytes = results.reduce((sum, result) => sum + (result.bytes ?? 0), 0);
  console.log(
    `\n${failures.length === 0 ? "✓" : "✗"} 完成：${results.length - failures.length}/${results.length} 成功，${formatBytes(totalBytes)}`,
  );
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`  - ${failure.project}/${failure.service}: ${failure.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
