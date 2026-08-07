/**
 * @xapiforge/genapi — swagger.json → TS API 客户端生成器（openapi-fetch 驱动）
 *
 * 双层生成（用开源工具，自己只写胶水）：
 *   1. openapi-typescript（社区库）生成精准 types → ./types/<service>.ts
 *   2. openapi-fetch（同一个开源联盟）按 paths 类型给 client 提供强类型 GET/POST/PUT/DELETE/PATCH
 *   3. 本库的 renderIndex() 生成业务对象（按 service 切分 client）+ renderApiTypes() 扫
 *      components.schemas 导 schema 名 alias
 *
 * 关键设计（基于跨项目研究数据）：
 *   - 调用形式：apiDemo.base.GET("/api/identity/users/{id}", { params: { path: { id } } })
 *     method/path/pathParam/query/body 全强类型（拼错立刻报）
 *   - 按 service 拆 client 而非合并 paths —— ABP swagger 把公共 endpoint 复制到每个 service，
 *     合并 `paths & paths` 会触发 TS2300 "Named property not identical"
 *   - schema 别名按 `Volo.Abp.Identity.IdentityUserDto` 末段名 `IdentityUserDto`，
 *     冲突时用倒数两级 `Identity_IdentityUserDto`。业务侧 import `IdentityUserDto` 即用
 *
 * 用法：
 *   import { generate } from "@xapiforge/genapi";
 *   import config from "./xapiforge.config.js";
 *
 *   await generate({
 *     projectId: "demo",
 *     xapiForgeConfig,
 *     swaggerDir: "swagger",
 *     outputDir: "src/api/gen",
 *   });
 *   // → 产出 src/api/gen/demo/index.ts + src/api/gen/demo/types/<svc>.ts + src/api/gen/demo/api-types.ts
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

// ---------- 语义类型 ----------

export function defineConfig(config: XApiForgeConfig): XApiForgeConfig {
  return config;
}

export interface ServiceConfig {
  name: string;
  displayName: string;
  port: number;
  path?: string;
  baseHost?: string;
  /**
   * service 级 hooks（可选，覆盖 XApiForgeConfig.hooks）。
   *
   * 用途：跨框架 / 老服务迁移场景下，某个微服务的 swagger 形态跟其它服务不同，
   * 需要单独 hook。例：项目整体使用一套 legacyHooks 做规范化，
   * 但接入了一个第三方 SpringBoot 服务，service 级传 `{}` 跳过 legacy 规范化。
   *
   * 合并策略：覆盖式（`svc.hooks ?? config.hooks`）。
   * service 级传 `{}` 表示「显式禁用所有 hook」。
   */
  hooks?: GenapiHooks;
}

export interface ProjectConfig {
  name: string;
  displayName: string;
  baseHost: string;
  services: ServiceConfig[];
}

/**
 * 命名空间前缀映射（可选）。
 *
 * 把匹配指定前缀的 schema 归入 TypeScript namespace，组内用短名。
 * 未匹配的 schema 退化为全局短名（无 namespace）。
 *
 * 例：{ match: 'Example.Module.', namespace: 'Module' }
 *   → schema 'Example.Module.ItemDto' 归入 namespace Module，内部 alias = 'ItemDto'
 *   → import type { Module } from '@/api/gen/demo/api-types'
 *   → Module.ItemDto
 *
 * 通用机制：纯字符串前缀匹配，不限定后端框架（ABP / SpringBoot / NestJS 等均可）。
 */
export interface NamespacePrefixAlias {
  /** Schema full-name prefix to match（如 'Example.Module.'） */
  match: string;
  /** Namespace name to group matching schemas under（如 'Module'） */
  namespace: string;
}

export interface XApiForgeConfig {
  defaultPath: string;
  timeoutMs: number;
  outputDir: string;
  /** 生成产物根目录；CLI 默认使用 `src/api/gen`。 */
  genOutputDir?: string;
  mode?: "online" | "offline";
  projects: ProjectConfig[];
  /**
   * 业务侧扩展点（可选），见 docs/guides/genapi-hooks.md。
   *
   * 注：放在 XApiForgeConfig 顶层是为了让 CLI 一次性加载配置即可拿到 hooks。
   * hooks 是函数，不可 JSON 序列化；offline 项目从本地 xapiforge.config.ts import
   * 而非读 JSON，所以不影响。后续如需拆出 GenapiConfig 类型可重构。
   */
  hooks?: GenapiHooks;
  /**
   * 命名空间前缀映射（可选），用于 api-types.ts 分组导出。
   *
   * 把匹配指定前缀的 schema 归入 TypeScript namespace，组内用短名。
   * 未匹配的 schema 退化为全局短名。
   *
   * 通用机制：纯字符串前缀匹配，不限定后端框架（ABP / SpringBoot 等）。
   *
   * 例：{ match: 'Example.Module.', namespace: 'Module' }
   *   → 'Example.Module.ItemDto' 归入 namespace Module
   *   → 业务侧：import type { Module } from '@/api/gen/demo/api-types'
   *            然后 Module.ItemDto
   */
  namespacePrefixAliases?: NamespacePrefixAlias[];
}

// ---------- genapi hooks 扩展点 ----------
//
// 见 docs/guides/genapi-hooks.md。genapi 内核只做规范 OpenAPI 的标准处理；
// 业务侧（如 ABP / legacy 后端的非标准 swagger 形态）通过 hooks 自定义。
//
// 每个 hook 接收 (content, ctx) → 返回（可能被修改的）content。
// 返回原值表示不处理；返回新值表示处理；抛错则生成流程中断。
//
// MVP 已接入：Hook 2 transformSwagger / Hook 3 transformTypes
// 暂未接入（设计稿已列）：Hook 1 transformSwaggerDownloaded /
//   Hook 4 transformApiTypes / Hook 5 transformIndex / Hook 6 onComplete

/** Hook 上下文（所有 hook 共用） */
export interface GenapiHookContext {
  projectId: string;
  serviceName: string;
  /** 原 swagger 文件绝对路径（hooks 仅读，不修改原文件） */
  swaggerPath: string;
  /** 类型产物绝对路径 types/<svc>.ts */
  typesPath: string;
}

/**
 * Hook 2 · 主钩子：swagger.json 读入后、openapi-typescript 调用前
 *
 * 用途：业务侧把后端的非标准 swagger（如 ABP / legacy 自定义格式）规范化为
 * 标准 OpenAPI 3.0。例如把 `"Alpha(选项一)=1"` 这种字符串枚举转成
 * `enum: [1] + x-enum-varnames: ["Alpha"] + x-enum-labels: ["选项一"]`，
 * 让 openapi-typescript 能正确生成 `1 | 2` 数字 union 类型。
 *
 * 返回值会被 genapi 写入临时文件交给 openapi-typescript，**不改原 swagger.json**。
 */
export type TransformSwaggerHook = (swagger: unknown, ctx: GenapiHookContext) => Promise<unknown>;

/**
 * Hook 3：类型生成后、写盘前
 *
 * 用途：对 openapi-typescript 的产物做后处理。例如根据 swagger 的
 * `x-enum-varnames` / `x-enum-labels` 注入 runtime enum map 常量，
 * 让业务侧既能用类型 `MessageType = 0 | 1 | 2`，也能用常量 `MessageType[1] === "New"`
 * 或反向 `MessageType.New === 1`。
 */
export type TransformTypesHook = (typesContent: string, ctx: GenapiHookContext) => Promise<string>;

export interface GenapiHooks {
  transformSwagger?: TransformSwaggerHook;
  transformTypes?: TransformTypesHook;
}

// ---------- generator 输入 ----------

export interface GenerateOptions {
  xapiForgeConfig: XApiForgeConfig;
  projectId: string;
  swaggerDir: string;
  outputDir: string;
  templateDir?: string;
  emitApiTypes?: boolean;
  /** 业务侧扩展点，见 docs/guides/genapi-hooks.md */
  hooks?: GenapiHooks;
}

export interface GenerateResult {
  projectId: string;
  outputDir: string;
  filesWritten: number;
  serviceNames: string[];
  totalEndpoints: number;
}

// ---------- 内部类型 ----------

interface TagInfo {
  method: string;
  path: string;
  summary?: string;
  opId: string | null;
}

interface ServiceInfo {
  name: string;
  tagMap: Record<string, TagInfo[]>;
  endpointCount: number;
}

// ---------- 入口 ----------

/**
 * 生成一个项目（{outputDir}/{projectId}/ 目录）。
 *
 * 1. 对每个 service 跑 openapi-typescript 生成 types.ts
 * 2. 抽 tag → 输出 (endpointCount) 给 banner 用
 * 3. 写 src/index.ts（按 service 拆 openapi-fetch client + re-export）
 * 4. 写 src/api-types.ts（按 components.schemas 导 alias）
 */
export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const project = opts.xapiForgeConfig.projects.find((p) => p.name === opts.projectId);
  if (!project) {
    throw new Error(`project '${opts.projectId}' not in xapiForgeConfig.projects`);
  }

  const swaggerDir = resolve(process.cwd(), opts.swaggerDir, project.name);
  if (!existsSync(swaggerDir)) {
    throw new Error(`swagger directory not found: ${swaggerDir}`);
  }

  const outDir = resolve(process.cwd(), opts.outputDir, project.name);
  const typesDir = join(outDir, "types");
  await mkdir(typesDir, { recursive: true });

  // hooks 合并策略：service 级覆盖项目级（`svc.hooks ?? config.hooks`）
  // - 不传 svc.hooks → 用顶层 config.hooks（同一后端框架场景）
  // - 传 svc.hooks = {} → 显式禁用所有 hook（跨框架特殊服务场景）
  // - 传 svc.hooks = { transformSwagger: ... } → 仅此 service 用自定义 hook
  const resolveHooks = (svc: ServiceConfig): GenapiHooks | undefined =>
    svc.hooks !== undefined ? svc.hooks : opts.hooks;

  // 1. openapi-typescript → types/<svc>.ts（社区工具，最精准的 path → response 类型推导）
  //
  // Hook 2 transformSwagger 接入点：在 openapi-typescript 调用前规范化 swagger。
  //   - 不改原 swagger.json（hooks 仅读）
  //   - 把 hook 返回的 swagger 写入临时文件交给 openapi-typescript
  //   - 生成完删临时文件
  //
  // Hook 3 transformTypes 接入点：openapi-typescript 生成后、写盘前。
  //   - 读回 typeFile 内容 → 过 hook → 写回
  //   - 用于注入 runtime enum map 等
  const serviceNames: string[] = [];
  for (const svc of project.services) {
    const swaggerFile = join(swaggerDir, `${svc.name}.json`);
    if (!existsSync(swaggerFile)) {
      console.warn(`  swagger/${project.name}/${svc.name}.json 缺失,跳过`);
      continue;
    }
    const typeFile = join(typesDir, `${svc.name}.ts`);
    const ctx: GenapiHookContext = {
      projectId: project.name,
      serviceName: svc.name,
      swaggerPath: swaggerFile,
      typesPath: typeFile,
    };
    const hooks = resolveHooks(svc);

    // Hook 2：transformSwagger（不传 hook 时直接用原文件）
    const inputFile = await applyTransformSwagger(swaggerFile, svc.name, hooks, ctx);
    try {
      await runOpenapiTypescript(inputFile, typeFile);
    } finally {
      // 如果 hook 写了临时文件，删除（原文件不动）
      if (inputFile !== swaggerFile) {
        await rm(inputFile, { force: true });
      }
    }

    // Hook 3：transformTypes（不传 hook 时跳过，直接读回写一遍也无意义）
    if (hooks?.transformTypes) {
      const original = await readFile(typeFile, "utf8");
      const transformed = await hooks.transformTypes(original, ctx);
      if (transformed !== original) {
        await writeFile(typeFile, transformed, "utf8");
      }
    }

    serviceNames.push(svc.name);
  }

  // 2. 抽 tag 给 banner/统计用
  const serviceInfos: ServiceInfo[] = [];
  for (const svcName of serviceNames) {
    const swaggerFile = join(swaggerDir, `${svcName}.json`);
    const text = await readFile(swaggerFile, "utf8");
    const j: { paths?: Record<string, Record<string, unknown>> } = JSON.parse(text) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const tagMap = extractTags(j);
    const endpointCount = Object.values(tagMap).reduce((n, arr) => n + arr.length, 0);
    serviceInfos.push({ name: svcName, tagMap, endpointCount });
  }

  // 3. 写 index.ts —— openapi-fetch 形式的业务对象
  const indexContent = renderIndex(
    project.name,
    project.displayName,
    project.baseHost,
    serviceInfos,
    serviceNames,
  );
  await writeFile(join(outDir, "index.ts"), indexContent, "utf8");

  // 4. 写 api-types.ts —— components.schemas 导 alias
  const emitTypes = opts.emitApiTypes !== false; // 默认 true
  const apiTypesPath = join(outDir, "api-types.ts");
  if (emitTypes) {
    const apiTypesContent = renderApiTypes(
      project.name,
      project.displayName,
      swaggerDir,
      serviceNames,
      opts.xapiForgeConfig.namespacePrefixAliases,
    );
    await writeFile(apiTypesPath, apiTypesContent, "utf8");
  } else if (existsSync(apiTypesPath)) {
    await import("node:fs/promises").then((m) => m.unlink(apiTypesPath));
  }

  const total = serviceInfos.reduce((n, s) => n + s.endpointCount, 0);
  const filesWritten = serviceNames.length + 1 + (emitTypes ? 1 : 0);
  return {
    projectId: project.name,
    outputDir: dirname(outDir),
    filesWritten,
    serviceNames,
    totalEndpoints: total,
  };
}

/**
 * 跑 openapi-typescript 生成 types.ts。
 */
async function runOpenapiTypescript(inputFile: string, outputFile: string): Promise<void> {
  // 直接调用依赖的程序 API，不依赖消费者项目是否把传递依赖的 bin 提升到
  // node_modules/.bin。这样 npm、pnpm（含 isolated linker）和 yarn 项目行为一致。
  const ast = await openapiTS(pathToFileURL(inputFile));
  await writeFile(outputFile, astToString(ast), "utf8");
}

/**
 * Hook 2 内核侧实现：读原 swagger → 过 hook → 写临时文件 → 返回临时路径。
 *
 * - 不传 hook 时直接返回原 swaggerFile 路径，openapi-typescript 用原文件。
 * - 传 hook 时把 hook 返回值 JSON.stringify 写入 OS 临时目录的随机文件。
 * - 临时文件由调用方在 finally 中删除（见 generate()）。
 */
async function applyTransformSwagger(
  swaggerFile: string,
  serviceName: string,
  hooks: GenapiHooks | undefined,
  ctx: GenapiHookContext,
): Promise<string> {
  if (!hooks?.transformSwagger) return swaggerFile;

  const original = await readFile(swaggerFile, "utf8");
  const parsed: unknown = JSON.parse(original);
  const transformed = await hooks.transformSwagger(parsed, ctx);
  if (transformed === undefined || transformed === null) {
    throw new Error(`transformSwagger(${serviceName}) 返回空值；应返回规范化后的 swagger 对象`);
  }

  const tmpName = `genapi-${projectSafeName(ctx.projectId)}-${serviceName}-${randomBytes(6).toString("hex")}.json`;
  const tmpFile = join(tmpdir(), tmpName);
  await writeFile(tmpFile, JSON.stringify(transformed, null, 2), "utf8");
  return tmpFile;
}

/** 项目名转文件名示例片段（仅用于临时文件名，不影响业务侧） */
function projectSafeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 从 swagger.json 抽 paths，按 tag 聚合。
 */
function extractTags(j: {
  paths?: Record<string, Record<string, unknown>>;
}): Record<string, TagInfo[]> {
  const tags: Record<string, TagInfo[]> = {};
  for (const [pathStr, methods] of Object.entries(j.paths ?? {})) {
    for (const [method, rawOp] of Object.entries(methods ?? {})) {
      if (!rawOp || typeof rawOp !== "object") continue;
      const op = rawOp as { tags?: string[]; operationId?: string; summary?: string };
      const tagList = op.tags?.length ? op.tags : ["(untagged)"];
      for (const t of tagList) {
        const list = tags[t] ?? (tags[t] = []);
        list.push({
          method: method.toUpperCase(),
          path: pathStr,
          summary: op.summary,
          opId: op.operationId ?? null,
        });
      }
    }
  }
  return tags;
}

// ---------- 模板渲染 ----------

function cap(s: string): string {
  // "my-service" → "MyService"
  return s
    .split(/[-_]/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : ""))
    .join("");
}

function safeKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function renderIndex(
  projectId: string,
  projectDisplay: string,
  projectBaseHost: string,
  services: ServiceInfo[],
  serviceNames: string[],
): string {
  const totalEndpoints = services.reduce((n, s) => n + s.endpointCount, 0);
  const now = new Date().toISOString();
  const firstServiceKey = safeKey(serviceNames[0] ?? "service");

  const parts: string[] = [];

  parts.push("/**");
  parts.push(` * ${projectDisplay} API 客户端（生成产物，自动生成勿手改）`);
  parts.push(" *");
  parts.push(
    " * 引擎：openapi-typescript（路径/schema 类型）+ @xapiforge/core createNet（data-or-throw/鉴权/重试）",
  );
  parts.push(" *");
  parts.push(` * 生成时间：${now}`);
  parts.push(` * 项目：${projectDisplay} (${projectId})`);
  parts.push(` * 服务数：${serviceNames.length}`);
  parts.push(` * 总 endpoint 数：${totalEndpoints}`);
  parts.push(" *");
  parts.push(" * 设计：");
  parts.push(
    " *   - 每个 service 用 createNet<paths> 创建独立 client（共享同一 authService + middleware）",
  );
  parts.push(" *   - createNet 成功返回 { data, response }；最终失败统一抛 ApiError");
  parts.push(
    " *   - 业务侧 middleware（envelope 解包等）由 config.middleware 传入，按 service 共享",
  );
  parts.push(" *   - retry loop（429 退避 / auth retry）由 createNet 统一管理");
  parts.push(" *");
  parts.push(" * 用法：");
  parts.push(
    ` *   import { create${cap(projectId)}Client } from "./api/gen/${projectId}/index.js";`,
  );
  parts.push(` *   const api = create${cap(projectId)}Client({`);
  parts.push(` *     baseURL: "${projectBaseHost}",`);
  parts.push(" *     authService,           // AuthService 实例");
  parts.push(" *     middleware: [abpUnwrapMw],  // 业务侧 envelope 解包");
  parts.push(" *     maxRetries: 3,         // 429 场景配 3");
  parts.push(" *   });");
  parts.push(
    ` *   await api.${firstServiceKey}.GET("/api/identity/users/{id}", { params: { path: { id } } });`,
  );
  parts.push(" *");
  parts.push(" * 重新生成：");
  parts.push(` *   pnpm generate:api ${projectId}`);
  parts.push(" */");
  parts.push("");

  // import createNet + AuthService 类型 + 每个 service paths
  parts.push("// @xapiforge/core createNet：封装 openapi-fetch + data-or-throw + auth/retry");
  parts.push('import { createNet } from "@xapiforge/core";');
  parts.push(
    'import type { AuthService, Middleware, FetchLike, NetClient, ValidateStatus, ResolveErrorMessage } from "@xapiforge/core";',
  );
  parts.push("");
  for (const svc of serviceNames) {
    parts.push(`import type { paths as ${cap(svc)}Paths } from "./types/${svc}.js";`);
  }
  parts.push("");

  // 暴露 service 自己的 paths 类型（业务侧偶尔需要按 path 字面量取 schema）
  for (const svc of serviceNames) {
    parts.push(`/** ${svc} service paths 类型（按 HTTP path 字面量索引） */`);
    parts.push(`export type ${cap(svc)}Path = ${cap(svc)}Paths;`);
  }
  parts.push("");

  // 业务对象：每个 service 一个 createNet client 字段
  parts.push("/**");
  parts.push(` * ${projectDisplay} 业务对象`);
  parts.push(" * - 顶层 key: service 英文短码（与 xapiforge.config.ts 服务名对应）");
  parts.push(" * - client: createNet 返回的强类型 client（GET/POST/PUT/DELETE/PATCH 强类型）");
  parts.push(" * - 内核自动注入：auth/retry + validateStatus；最终失败统一抛 ApiError");
  parts.push(
    " * - 业务侧 middleware（envelope 解包）通过 config.middleware 注入，所有 service 共享",
  );
  parts.push(" *");
  parts.push(" * 调用形式（method/path/body 全强类型）：");
  parts.push(
    ` *   api.${firstServiceKey}.GET("/api/identity/users/{id}", { params: { path: { id } } });`,
  );
  parts.push(
    ` *   api.${firstServiceKey}.POST("/api/identity/users", { body: { userName: "x", ... } });`,
  );
  parts.push(" */");
  parts.push(`export interface Api${cap(projectId)}ClientConfig {`);
  parts.push(`  baseURL: string;`);
  parts.push(`  /** AuthService 实例（管 token 存储 + refresh 单飞 + onAuthFailed） */`);
  parts.push(`  authService: AuthService;`);
  parts.push(`  /** 业务 middleware（envelope 解包 / 业务错误判定），所有 service 共享 */`);
  parts.push(`  middleware?: Middleware[];`);
  parts.push(`  /** 全局 HTTP 成功判定；默认 response.ok。单次请求可覆盖 */`);
  parts.push(`  validateStatus?: ValidateStatus;`);
  parts.push(`  /** 全局错误文案解析器；单次请求可覆盖 */`);
  parts.push(`  resolveErrorMessage?: ResolveErrorMessage;`);
  parts.push(`  /** retry loop 最大重试次数（不含首次请求），默认 1；429 场景建议 3 */`);
  parts.push(`  maxRetries?: number;`);
  parts.push(
    `  /** 自定义 fetch（默认 globalThis.fetch）；Capacitor 业务侧传 capacitorFetch 走原生 HTTP */`,
  );
  parts.push(`  fetch?: FetchLike;`);
  parts.push(`  /** 默认请求超时（毫秒），默认 15000 */`);
  parts.push(`  defaultTimeoutMs?: number;`);
  parts.push("}");
  parts.push("");

  parts.push(`export function create${cap(projectId)}Client(`);
  parts.push(`  config: Api${cap(projectId)}ClientConfig & { validateStatus: ValidateStatus },`);
  parts.push(`): Api${cap(projectId)}<true>;`);
  parts.push(`export function create${cap(projectId)}Client(`);
  parts.push(`  config: Api${cap(projectId)}ClientConfig,`);
  parts.push(`): Api${cap(projectId)}<false>;`);
  parts.push(`export function create${cap(projectId)}Client(`);
  parts.push(`  config: Api${cap(projectId)}ClientConfig,`);
  parts.push(`): Api${cap(projectId)}<boolean> {`);
  parts.push(`  // 每个 service 共享同一 authService + middleware + fetch 配置`);
  parts.push(`  const netConfig = {`);
  parts.push(`    baseURL: config.baseURL,`);
  parts.push(`    authService: config.authService,`);
  parts.push(`    middleware: config.middleware,`);
  parts.push(`    validateStatus: config.validateStatus,`);
  parts.push(`    resolveErrorMessage: config.resolveErrorMessage,`);
  parts.push(`    maxRetries: config.maxRetries,`);
  parts.push(`    fetch: config.fetch,`);
  parts.push(`    defaultTimeoutMs: config.defaultTimeoutMs,`);
  parts.push(`  };`);
  parts.push(`  return {`);

  for (const s of services) {
    parts.push(`    /** ${s.name}（${s.endpointCount} endpoints） */`);
    parts.push(`    ${safeKey(s.name)}: createNet<${cap(s.name)}Paths>(netConfig),`);
  }
  parts.push("  };");
  parts.push("}");
  parts.push("");

  // Api{Proj} 接口导出 —— 默认 data 仅含 2xx；自定义 validateStatus 时增加 error response 类型
  parts.push(`export interface Api${cap(projectId)}<HasCustomStatus extends boolean = false> {`);
  for (const s of services) {
    parts.push(`  /** ${s.name} */`);
    parts.push(`  ${safeKey(s.name)}: NetClient<${cap(s.name)}Paths, HasCustomStatus>;`);
  }
  parts.push("}");
  parts.push("");

  return parts.join("\n");
}

/**
 * 生成 api-types.ts —— 按 components.schemas 导 schema alias
 *
 * 命名策略：
 *   - `Volo.Abp.Identity.IdentityUserDto` → `IdentityUserDto`（取最后一段）
 *   - 短名冲突（如 `base.Account.AccountDto` 和 `monitor.Account.AccountDto` 都出 `AccountDto`）→
 *     `Identity_IdentityUserDto`（末二级，避免碰撞）
 *   - 同 service + 同 full 名重复出现 → 只导一次
 *
 * 业务侧：
 *   import type { IdentityUserDto, IdentityUserCreateDto } from "@/api/gen/demo/api-types";
 *   type Resp = paths["/api/identity/users/{id}"]["get"]["responses"]["200"]["content"]["application/json"];
 *   // 或直接：
 *   type Resp2 = IdentityUserDto;
 */
function renderApiTypes(
  projectId: string,
  projectDisplay: string,
  projectSwaggerDir: string,
  serviceNames: string[],
  namespacePrefixAliases?: NamespacePrefixAlias[],
): string {
  const lines: string[] = [];

  lines.push("/* eslint-disable */");
  lines.push("/**");
  lines.push(` * @${projectId}/api-types — 自动生成，别手改`);
  lines.push(" *");
  lines.push(` * 数据源：openapi-typescript 生成的 components.schemas（见 ./types/<service>.ts）`);
  lines.push(` * 项目：${projectDisplay}（${projectId}），service 数：${serviceNames.length}`);
  lines.push(" *");
  if (namespacePrefixAliases && namespacePrefixAliases.length > 0) {
    lines.push(" * 命名空间分组（namespacePrefixAliases 配置）：");
    for (const npa of namespacePrefixAliases) {
      lines.push(` *   ${npa.match} → namespace ${npa.namespace}`);
    }
    lines.push(" *");
  }
  lines.push(" * 字段拼错立刻报错；swagger 改了 → pnpm generate:api → 类型自动同步。");
  lines.push(" */");
  lines.push("");

  // 收集所有 schemas（每 service 一份 components，可能有同 full 名重复）
  type SchemaRef = { svc: string; full: string };
  const collected: SchemaRef[] = [];
  for (const svc of serviceNames) {
    const svcPath = join(projectSwaggerDir, `${svc}.json`);
    let j: { components?: { schemas?: Record<string, unknown> } } = {};
    try {
      j = JSON.parse(readFileSync(svcPath, "utf8")) as typeof j;
    } catch {
      continue;
    }
    const schemas = j.components?.schemas ?? {};
    for (const sn of Object.keys(schemas)) {
      collected.push({ svc, full: sn });
    }
  }

  // helper：取 schema 名最后一段"可作为 TS alias"的子串
  // .NET 泛型 schema 名带反引号 `ListResultDto`1[[...]]`，无法做 TS alias，直接跳
  // 0.1.42.0 之类的纯数字/点结尾段，跳过直到找到字母段
  function shortAlias(full: string): string {
    if (full.includes("`")) return ""; // 跳过 .NET 泛型 metadata schema
    const parts = full.split(/[.[\], ]+/).filter(Boolean);
    // 从末往前找一个"以字母或下划线开头"的段
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]!;
      if (/^[A-Za-z_$]/.test(p)) return p;
    }
    return "";
  }
  function safeAlias(raw: string): string {
    // 用 safeKey 过滤非法字符；如果仍以数字开头，前缀 _ 让它合法
    const k = raw.replace(/[^A-Za-z0-9_$]/g, "_");
    return /^[0-9]/.test(k) ? `_${k}` : k;
  }

  // 命名空间匹配：schema full-name 前缀 → namespace 名
  // 优先级：配置中先出现的优先（先匹配先生效）
  function matchNamespace(full: string): string | null {
    if (!namespacePrefixAliases || namespacePrefixAliases.length === 0) return null;
    for (const npa of namespacePrefixAliases) {
      if (full.startsWith(npa.match)) {
        return safeAlias(npa.namespace);
      }
    }
    return null;
  }

  // 校验 namespace 配置：safeAlias 后不得冲突，否则不同前缀的 schema 会静默合并
  if (namespacePrefixAliases && namespacePrefixAliases.length > 0) {
    const seen = new Map<string, string>();
    for (const npa of namespacePrefixAliases) {
      const safe = safeAlias(npa.namespace);
      const prev = seen.get(safe);
      if (prev) {
        throw new Error(
          `[genapi] namespacePrefixAliases 冲突："${prev}" 和 "${npa.namespace}" → 同一 safeAlias "${safe}"，` +
            "请检查 namespace 配置，避免不同前缀的 schema 被静默合并。",
        );
      }
      seen.set(safe, npa.namespace);
    }
  }

  // ---- 分类：namespace 内 vs 全局 ----
  // namespace 内：短名唯一（组内冲突 skip）
  // 全局：短名冲突检测（同现有逻辑）

  interface NamespacedEntry {
    namespace: string;
    alias: string;
    full: string;
    svc: string;
  }
  interface FlatEntry {
    alias: string;
    full: string;
    svc: string;
  }

  const byNamespace = new Map<string, NamespacedEntry[]>();
  const namespaceAliasUsed = new Map<string, Set<string>>(); // namespace → used aliases

  const flatEntries: FlatEntry[] = [];
  const flatAliasUsed = new Set<string>();
  const shortCount = new Map<string, number>();

  // 第一遍：计算每个 schema 的 namespace + short alias（只算一次），同时统计全局短名冲突数
  const enriched: Array<{ svc: string; full: string; ns: string | null; short: string }> = [];
  for (const r of collected) {
    const ns = matchNamespace(r.full);
    const short = shortAlias(r.full);
    enriched.push({ svc: r.svc, full: r.full, ns, short });
    if (!ns && short) {
      shortCount.set(short, (shortCount.get(short) ?? 0) + 1);
    }
  }

  // 第二遍：分类入库（直接用预计算的 ns + short，不再重复 matchNamespace）
  for (const r of enriched) {
    if (!r.short) continue;

    if (r.ns) {
      // namespace 内：短名唯一即可，冲突 skip
      const alias = safeAlias(r.short);
      let aliasSet = namespaceAliasUsed.get(r.ns);
      if (!aliasSet) {
        aliasSet = new Set();
        namespaceAliasUsed.set(r.ns, aliasSet);
      }
      if (aliasSet.has(alias)) continue;
      aliasSet.add(alias);
      if (!byNamespace.has(r.ns)) byNamespace.set(r.ns, []);
      byNamespace.get(r.ns)!.push({ namespace: r.ns, alias, full: r.full, svc: r.svc });
    } else {
      // 全局：保留原冲突检测逻辑
      let alias = safeAlias(r.short);
      if ((shortCount.get(r.short) ?? 0) > 1) {
        const parts = r.full.split(/[.[\], ]+/).filter(Boolean);
        const tail = parts.slice(-2).join("_");
        alias = safeAlias(tail);
      }
      if (flatAliasUsed.has(alias)) continue;
      flatAliasUsed.add(alias);
      flatEntries.push({ alias, full: r.full, svc: r.svc });
    }
  }

  // 收集所有用到的 service（import 用）
  const svcSet = new Set<string>();
  for (const entries of byNamespace.values()) {
    for (const e of entries) svcSet.add(e.svc);
  }
  for (const e of flatEntries) svcSet.add(e.svc);
  const servicesUsed = [...svcSet];

  // import 用到的 components（按 svc 单独 import —— 不交叉合并 components，
  // 因为 ABP swagger 不同 service 可能给同名 schema 写不同字段，`&` 后 `T[K]` 退化成 never
  // —— 策略：定位 alias 时锁回它原 service 的 components）
  for (const svc of serviceNames) {
    if (!svcSet.has(svc)) continue;
    lines.push(`import type { components as ${cap(svc)}Components } from "./types/${svc}.js";`);
  }
  lines.push("");

  // ---- AllSchemas ----
  if (servicesUsed.length > 0) {
    if (servicesUsed.length === 1) {
      const only = servicesUsed[0]!;
      lines.push(`export type AllSchemas = ${cap(only)}Components["schemas"];`);
    } else {
      lines.push(
        `export type AllSchemas = UnionToIntersection<${servicesUsed
          .map((s) => `${cap(s)}Components["schemas"]`)
          .join(" | ")}>;`,
      );
      lines.push("type UnionToIntersection<U> =");
      lines.push("  (U extends unknown ? (x: U) => void : never) extends");
      lines.push("    (x: infer I) => void");
      lines.push("    ? I");
      lines.push("    : never;");
    }
    lines.push("");
  } else {
    lines.push("// 项目下无 schema");
    lines.push("export type AllSchemas = Record<string, never>;");
    lines.push("");
  }

  // ---- namespace 分组输出 ----
  // 按 namespace 名排序，保证生成稳定
  const sortedNamespaces = [...byNamespace.keys()].sort();
  for (const ns of sortedNamespaces) {
    const entries = byNamespace.get(ns)!;
    lines.push(`/** namespace ${ns}（${entries.length} 个 schema）*/`);
    lines.push(`export namespace ${ns} {`);
    // 按 alias 排序，保证生成稳定
    entries.sort((a, b) => a.alias.localeCompare(b.alias));
    for (const e of entries) {
      lines.push(`  /** ${e.full}（原 service: ${e.svc}）*/`);
      lines.push(`  export type ${e.alias} = ${cap(e.svc)}Components["schemas"]["${e.full}"];`);
    }
    lines.push("}");
    lines.push("");
  }

  // ---- 全局 alias 输出 ----
  // 按 alias 排序，保证生成稳定
  flatEntries.sort((a, b) => a.alias.localeCompare(b.alias));
  for (const e of flatEntries) {
    lines.push(`/** ${e.full}（原 service: ${e.svc}）*/`);
    lines.push(`export type ${e.alias} = ${cap(e.svc)}Components["schemas"]["${e.full}"];`);
  }
  if (flatEntries.length > 0) lines.push("");

  return lines.join("\n");
}

// ---------- swagger-fetch re-export ----------
//
// 原独立 swagger-fetch 能力合入 genapi，避免类型双份维护。
// 业务侧从 "@xapiforge/genapi" 统一 import buildUrl / fetchSwaggerJson / formatBytes / 类型。
export { buildUrl, downloadJson, fetchSwaggerJson, formatBytes } from "./swagger-fetch.js";
export type { FetchOptions, FetchResult } from "./swagger-fetch.js";
