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
 *   - schema identity 包含 service + full name；短 alias 冲突直接失败并要求显式配置
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

import { mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

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
  /** project 级 hooks（service 未显式配置时优先于 root hooks）。 */
  hooks?: GenapiHooks;
  /** v2 schema 便利导出规则。 */
  typeExports?: ProjectTypeExportConfig;
  /** 临时兼容开关；新项目不应开启。 */
  compatibility?: GenapiCompatibilityConfig;
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

export interface NamespaceRule {
  /** 仅匹配指定 service；省略表示 project 内所有 service。 */
  service?: string;
  match: string;
  namespace: string;
}

export interface SchemaAliasRule {
  service: string;
  schema: string;
  exportAs: string;
  namespace?: string;
}

export interface ProjectTypeExportConfig {
  collisionPolicy?: "error";
  namespaces?: NamespaceRule[];
  aliases?: SchemaAliasRule[];
}

export interface GenapiCompatibilityConfig {
  /** @deprecated 多 service 下临时保留旧 AllSchemas；仅允许 schema full name 全局唯一。 */
  legacyAllSchemas?: boolean;
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
  /** 类型产物的逻辑最终路径；hook 执行时文件不保证已经存在。 */
  typesPath: string;
  /** hook 前的原始 OpenAPI 文档。 */
  originalDocument?: unknown;
  /** transformSwagger 后、供所有后续步骤复用的 OpenAPI 文档。 */
  normalizedDocument?: unknown;
}

/**
 * Hook 2 · 主钩子：swagger.json 读入后、openapi-typescript 调用前
 *
 * 用途：业务侧把后端的非标准 swagger（如 ABP / legacy 自定义格式）规范化为
 * 标准 OpenAPI 3.0。例如把 `"Alpha(选项一)=1"` 这种字符串枚举转成
 * `enum: [1] + x-enum-varnames: ["Alpha"] + x-enum-labels: ["选项一"]`，
 * 让 openapi-typescript 能正确生成 `1 | 2` 数字 union 类型。
 *
 * 返回值会直接交给 openapi-typescript，**不改原 swagger.json**。
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

export { createRuntimeEnumHooks } from "./runtime-enum.js";
export type { RuntimeEnumHooksOptions, RuntimeEnumMetadata } from "./runtime-enum.js";

// ---------- generator 输入 ----------

export interface GenerateOptions {
  xapiForgeConfig: XApiForgeConfig;
  projectId: string;
  swaggerDir: string;
  outputDir: string;
  templateDir?: string;
  emitApiTypes?: boolean;
  /** 仅比较 staging 与正式目录，不修改正式产物。 */
  check?: boolean;
  /** 业务侧扩展点，见 docs/guides/genapi-hooks.md */
  hooks?: GenapiHooks;
}

export interface GenerateResult {
  projectId: string;
  outputDir: string;
  filesWritten: number;
  serviceNames: string[];
  totalEndpoints: number;
  /** 本次输入是否会改变（check）或已经改变（generate）正式产物。 */
  changed: boolean;
  /** 相对 project 输出目录的差异文件清单。 */
  changedFiles: string[];
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

interface ServiceModel {
  config: ServiceConfig;
  originalDocument: OpenAPI3;
  document: OpenAPI3;
  schemas: Readonly<Record<string, unknown>>;
  serviceInfo: ServiceInfo;
  hooks?: GenapiHooks;
  hookContext: GenapiHookContext;
  normalizedDocumentHash: string;
}

interface ProjectArtifacts {
  result: Omit<GenerateResult, "changed" | "changedFiles">;
  outputDir: string;
  files: ReadonlyMap<string, string>;
}

interface TransactionProjectState {
  project: string;
  output: string;
  staging: string;
  backup: string;
  hadOutput: boolean;
}

interface TransactionState {
  formatVersion: 1;
  transactionId: string;
  phase: "committing" | "committed";
  projects: TransactionProjectState[];
}

const CONFIG_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TYPESCRIPT_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const TYPESCRIPT_RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string): Error {
  return new Error(`[genapi] 配置错误：${message}`);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${path} 必须是非空字符串`);
  }
}

function assertConfigId(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (!CONFIG_ID_PATTERN.test(value)) {
    throw configError(`${path} 必须匹配 ${CONFIG_ID_PATTERN.source}，实际为 "${value}"`);
  }
}

function assertTypeScriptIdentifier(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (!TYPESCRIPT_IDENTIFIER_PATTERN.test(value) || TYPESCRIPT_RESERVED_WORDS.has(value)) {
    throw configError(`${path} 必须是非保留的 TypeScript 标识符，实际为 "${value}"`);
  }
}

function validateHooks(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw configError(`${path} 必须是对象`);
  for (const key of ["transformSwagger", "transformTypes"] as const) {
    const hook = value[key];
    if (hook !== undefined && typeof hook !== "function") {
      throw configError(`${path}.${key} 必须是函数`);
    }
  }
}

/** 在 CLI 或 programmatic generate 写文件前执行完整运行时配置校验。 */
export function validateConfig(config: XApiForgeConfig): void {
  if (!isRecord(config)) throw configError("根配置必须是对象");
  assertNonEmptyString(config.defaultPath, "defaultPath");
  assertNonEmptyString(config.outputDir, "outputDir");
  if (config.genOutputDir !== undefined) {
    assertNonEmptyString(config.genOutputDir, "genOutputDir");
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw configError("timeoutMs 必须是大于 0 的有限数字");
  }
  if (config.mode !== undefined && config.mode !== "online" && config.mode !== "offline") {
    throw configError(`mode 只能是 "online" 或 "offline"，实际为 "${String(config.mode)}"`);
  }
  validateHooks(config.hooks, "hooks");

  if (!Array.isArray(config.projects)) throw configError("projects 必须是数组");
  const projectIds = new Set<string>();
  const projectTypeNames = new Map<string, string>();
  for (const [projectIndex, project] of config.projects.entries()) {
    const projectPath = `projects[${projectIndex}]`;
    if (!isRecord(project)) throw configError(`${projectPath} 必须是对象`);
    assertConfigId(project.name, `${projectPath}.name`);
    assertNonEmptyString(project.displayName, `${projectPath}.displayName`);
    assertNonEmptyString(project.baseHost, `${projectPath}.baseHost`);
    validateHooks(project.hooks, `${projectPath}.hooks`);

    if (projectIds.has(project.name)) {
      throw configError(`project ID 重复："${project.name}"`);
    }
    projectIds.add(project.name);
    const projectTypeName = cap(project.name);
    const previousProjectId = projectTypeNames.get(projectTypeName);
    if (previousProjectId) {
      throw configError(
        `project "${previousProjectId}" 与 "${project.name}" 生成相同 TypeScript 名称 "${projectTypeName}"`,
      );
    }
    projectTypeNames.set(projectTypeName, project.name);

    if (!Array.isArray(project.services) || project.services.length === 0) {
      throw configError(`${projectPath}.services 必须是非空数组`);
    }
    const serviceIds = new Set<string>();
    const serviceTypeNames = new Map<string, string>();
    const runtimeKeys = new Map<string, string>();
    for (const [serviceIndex, service] of project.services.entries()) {
      const servicePath = `${projectPath}.services[${serviceIndex}]`;
      if (!isRecord(service)) throw configError(`${servicePath} 必须是对象`);
      assertConfigId(service.name, `${servicePath}.name`);
      assertNonEmptyString(service.displayName, `${servicePath}.displayName`);
      if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65_535) {
        throw configError(`${servicePath}.port 必须是 1 到 65535 的整数`);
      }
      if (service.path !== undefined) assertNonEmptyString(service.path, `${servicePath}.path`);
      if (service.baseHost !== undefined) {
        assertNonEmptyString(service.baseHost, `${servicePath}.baseHost`);
      }
      validateHooks(service.hooks, `${servicePath}.hooks`);

      if (serviceIds.has(service.name)) {
        throw configError(`${projectPath} 下 service ID 重复："${service.name}"`);
      }
      serviceIds.add(service.name);

      const serviceTypeName = cap(service.name);
      const previousTypeId = serviceTypeNames.get(serviceTypeName);
      if (previousTypeId) {
        throw configError(
          `${projectPath} 下 service "${previousTypeId}" 与 "${service.name}" 生成相同 TypeScript 名称 "${serviceTypeName}"`,
        );
      }
      serviceTypeNames.set(serviceTypeName, service.name);

      const runtimeKey = safeKey(service.name);
      const previousRuntimeId = runtimeKeys.get(runtimeKey);
      if (previousRuntimeId) {
        throw configError(
          `${projectPath} 下 service "${previousRuntimeId}" 与 "${service.name}" 生成相同 runtime key "${runtimeKey}"`,
        );
      }
      runtimeKeys.set(runtimeKey, service.name);
    }

    if (project.compatibility !== undefined) {
      if (!isRecord(project.compatibility)) {
        throw configError(`${projectPath}.compatibility 必须是对象`);
      }
      if (
        project.compatibility.legacyAllSchemas !== undefined &&
        typeof project.compatibility.legacyAllSchemas !== "boolean"
      ) {
        throw configError(`${projectPath}.compatibility.legacyAllSchemas 必须是 boolean`);
      }
    }

    if (project.typeExports !== undefined) {
      if (!isRecord(project.typeExports)) {
        throw configError(`${projectPath}.typeExports 必须是对象`);
      }
      if (
        project.typeExports.collisionPolicy !== undefined &&
        project.typeExports.collisionPolicy !== "error"
      ) {
        throw configError(`${projectPath}.typeExports.collisionPolicy 目前只支持 "error"`);
      }

      const namespaceRules = project.typeExports.namespaces ?? [];
      if (!Array.isArray(namespaceRules)) {
        throw configError(`${projectPath}.typeExports.namespaces 必须是数组`);
      }
      const namespaceRuleKeys = new Set<string>();
      for (const [index, rule] of namespaceRules.entries()) {
        const rulePath = `${projectPath}.typeExports.namespaces[${index}]`;
        if (!isRecord(rule)) throw configError(`${rulePath} 必须是对象`);
        if (rule.service !== undefined) {
          assertConfigId(rule.service, `${rulePath}.service`);
          if (!serviceIds.has(rule.service)) {
            throw configError(
              `${rulePath}.service "${rule.service}" 不属于 project ${project.name}`,
            );
          }
        }
        assertNonEmptyString(rule.match, `${rulePath}.match`);
        assertTypeScriptIdentifier(rule.namespace, `${rulePath}.namespace`);
        const ruleKey = `${rule.service ?? "*"}\u0000${rule.match}`;
        if (namespaceRuleKeys.has(ruleKey)) {
          throw configError(
            `${rulePath} 重复匹配 service=${rule.service ?? "*"}, match=${rule.match}`,
          );
        }
        namespaceRuleKeys.add(ruleKey);
      }

      const aliasRules = project.typeExports.aliases ?? [];
      if (!Array.isArray(aliasRules)) {
        throw configError(`${projectPath}.typeExports.aliases 必须是数组`);
      }
      const aliasedSchemas = new Set<string>();
      const aliasTargets = new Set<string>();
      for (const [index, rule] of aliasRules.entries()) {
        const rulePath = `${projectPath}.typeExports.aliases[${index}]`;
        if (!isRecord(rule)) throw configError(`${rulePath} 必须是对象`);
        assertConfigId(rule.service, `${rulePath}.service`);
        if (!serviceIds.has(rule.service)) {
          throw configError(`${rulePath}.service "${rule.service}" 不属于 project ${project.name}`);
        }
        assertNonEmptyString(rule.schema, `${rulePath}.schema`);
        assertTypeScriptIdentifier(rule.exportAs, `${rulePath}.exportAs`);
        if (rule.namespace !== undefined) {
          assertTypeScriptIdentifier(rule.namespace, `${rulePath}.namespace`);
        }
        const schemaKey = `${rule.service}\u0000${rule.schema}`;
        if (aliasedSchemas.has(schemaKey)) {
          throw configError(`${rulePath} 重复配置 schema ${rule.service}/${rule.schema}`);
        }
        aliasedSchemas.add(schemaKey);
        const targetKey = `${rule.namespace ?? ""}\u0000${rule.exportAs}`;
        if (aliasTargets.has(targetKey)) {
          throw configError(
            `${rulePath} 的导出目标 ${rule.namespace ? `${rule.namespace}.` : ""}${rule.exportAs} 重复`,
          );
        }
        aliasTargets.add(targetKey);
      }
    }
  }

  if (config.namespacePrefixAliases !== undefined) {
    if (!Array.isArray(config.namespacePrefixAliases)) {
      throw configError("namespacePrefixAliases 必须是数组");
    }
    const matches = new Map<string, string>();
    const namespaces = new Map<string, string>();
    for (const [index, alias] of config.namespacePrefixAliases.entries()) {
      const aliasPath = `namespacePrefixAliases[${index}]`;
      if (!isRecord(alias)) throw configError(`${aliasPath} 必须是对象`);
      assertNonEmptyString(alias.match, `${aliasPath}.match`);
      assertTypeScriptIdentifier(alias.namespace, `${aliasPath}.namespace`);
      const previousNamespace = matches.get(alias.match);
      if (previousNamespace) {
        throw configError(
          `${aliasPath}.match "${alias.match}" 已映射到 namespace "${previousNamespace}"`,
        );
      }
      matches.set(alias.match, alias.namespace);
      const previousMatch = namespaces.get(alias.namespace);
      if (previousMatch) {
        throw configError(
          `namespace "${alias.namespace}" 同时匹配 "${previousMatch}" 和 "${alias.match}"`,
        );
      }
      namespaces.set(alias.namespace, alias.match);
    }
  }
}

function assertOpenApiDocument(value: unknown, label: string): asserts value is OpenAPI3 {
  if (!isRecord(value)) throw new Error(`[genapi] ${label} 必须是 JSON 对象`);
  if (typeof value.openapi !== "string" || !/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(value.openapi)) {
    throw new Error(`[genapi] ${label} 必须声明 OpenAPI 3.x，实际为 "${String(value.openapi)}"`);
  }
  if (!isRecord(value.info)) throw new Error(`[genapi] ${label}.info 必须是对象`);
  if (!isRecord(value.paths)) throw new Error(`[genapi] ${label}.paths 必须是对象`);
  if (value.components !== undefined && !isRecord(value.components)) {
    throw new Error(`[genapi] ${label}.components 必须是对象`);
  }
}

function assertInternalReferencesOnly(document: OpenAPI3, label: string): void {
  const pending: unknown[] = [document];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) pending.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        throw new Error(`[genapi] ${label} 暂不支持外部 $ref："${value}"`);
      }
      pending.push(value);
    }
  }
}

function resolveHooks(
  service: ServiceConfig,
  project: ProjectConfig,
  rootHooks: GenapiHooks | undefined,
): GenapiHooks | undefined {
  if (service.hooks !== undefined) return service.hooks;
  if (project.hooks !== undefined) return project.hooks;
  return rootHooks;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function loadServiceModels(
  project: ProjectConfig,
  swaggerDir: string,
  outDir: string,
  rootHooks: GenapiHooks | undefined,
): Promise<ServiceModel[]> {
  const models: ServiceModel[] = [];
  for (const service of project.services) {
    const swaggerFile = join(swaggerDir, `${service.name}.json`);
    if (!existsSync(swaggerFile)) {
      throw new Error(`[genapi] required Swagger 缺失：${swaggerFile}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(swaggerFile, "utf8"));
    } catch (cause) {
      throw new Error(`[genapi] 无法解析 ${swaggerFile}`, { cause });
    }
    assertOpenApiDocument(parsed, `${project.name}/${service.name} 原始文档`);
    const originalDocument = parsed;
    const hooks = resolveHooks(service, project, rootHooks);
    const hookContext: GenapiHookContext = {
      projectId: project.name,
      serviceName: service.name,
      swaggerPath: swaggerFile,
      typesPath: join(outDir, "types", `${service.name}.ts`),
      originalDocument,
    };
    const hookInput = structuredClone(originalDocument);
    const transformed = hooks?.transformSwagger
      ? await hooks.transformSwagger(hookInput, hookContext)
      : hookInput;
    if (transformed === undefined || transformed === null) {
      throw new Error(
        `[genapi] transformSwagger(${project.name}/${service.name}) 返回空值；应返回规范化后的 OpenAPI 对象`,
      );
    }
    assertOpenApiDocument(transformed, `${project.name}/${service.name} 规范化文档`);
    assertInternalReferencesOnly(transformed, `${project.name}/${service.name}`);
    hookContext.normalizedDocument = transformed;
    const tagMap = extractTags(transformed);
    const endpointCount = Object.values(tagMap).reduce(
      (count, operations) => count + operations.length,
      0,
    );
    const components = transformed.components as { schemas?: Record<string, unknown> } | undefined;
    models.push({
      config: service,
      originalDocument,
      document: transformed,
      schemas: components?.schemas ?? {},
      serviceInfo: { name: service.name, tagMap, endpointCount },
      hooks,
      hookContext,
      normalizedDocumentHash: sha256(JSON.stringify(transformed)),
    });
  }
  return models;
}

function assertPathInside(root: string, target: string, label: string): void {
  const relativePath = relative(root, target);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return;
  throw new Error(`[genapi] ${label} 越过配置根目录：${target}`);
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
async function buildProjectArtifacts(opts: GenerateOptions): Promise<ProjectArtifacts> {
  validateConfig(opts.xapiForgeConfig);
  const project = opts.xapiForgeConfig.projects.find((p) => p.name === opts.projectId);
  if (!project) {
    throw new Error(`project '${opts.projectId}' not in xapiForgeConfig.projects`);
  }

  assertNonEmptyString(opts.swaggerDir, "GenerateOptions.swaggerDir");
  assertNonEmptyString(opts.outputDir, "GenerateOptions.outputDir");
  const swaggerRoot = resolve(process.cwd(), opts.swaggerDir);
  const swaggerDir = resolve(swaggerRoot, project.name);
  assertPathInside(swaggerRoot, swaggerDir, `project ${project.name} Swagger 路径`);
  if (!existsSync(swaggerDir)) {
    throw new Error(`swagger directory not found: ${swaggerDir}`);
  }

  const outputRoot = resolve(process.cwd(), opts.outputDir);
  const outDir = resolve(outputRoot, project.name);
  assertPathInside(outputRoot, outDir, `project ${project.name} 输出路径`);
  const rootHooks = opts.hooks !== undefined ? opts.hooks : opts.xapiForgeConfig.hooks;

  // 所有 service 和文件内容先在内存中准备完成；失败时不创建正式输出目录。
  const serviceModels = await loadServiceModels(project, swaggerDir, outDir, rootHooks);
  const files = new Map<string, string>();

  // 1. openapi-typescript → types/<svc>.ts。所有步骤复用同一份 hook 后文档。
  for (const model of serviceModels) {
    let typesContent = await runOpenapiTypescript(model.document);
    if (model.hooks?.transformTypes) {
      typesContent = await model.hooks.transformTypes(typesContent, model.hookContext);
    }
    files.set(`types/${model.config.name}.ts`, normalizeLineEndings(typesContent));
  }

  const serviceNames = serviceModels.map((model) => model.config.name);
  const serviceInfos = serviceModels.map((model) => model.serviceInfo);

  // 3. 写 index.ts —— openapi-fetch 形式的业务对象
  const indexContent = renderIndex(
    project.name,
    project.displayName,
    project.baseHost,
    serviceInfos,
    serviceNames,
  );
  files.set("index.ts", normalizeLineEndings(indexContent));

  // 4. 写 api-types.ts —— components.schemas 导 alias
  const emitTypes = opts.emitApiTypes !== false; // 默认 true
  if (emitTypes) {
    const apiTypesContent = renderApiTypes(
      project.name,
      project.displayName,
      serviceModels,
      project.typeExports,
      project.compatibility,
      opts.xapiForgeConfig.namespacePrefixAliases,
    );
    files.set("api-types.ts", normalizeLineEndings(apiTypesContent));
  }

  files.set("manifest.json", await renderManifest(project.name, serviceModels));

  const total = serviceInfos.reduce((n, s) => n + s.endpointCount, 0);
  const filesWritten = files.size;
  return {
    result: {
      projectId: project.name,
      outputDir: outDir,
      filesWritten,
      serviceNames,
      totalEndpoints: total,
    },
    outputDir: outDir,
    files,
  };
}

/** 一次准备一个或多个 project；全部准备成功后才开始写文件。 */
export async function generateMany(options: GenerateOptions[]): Promise<GenerateResult[]> {
  if (options.length === 0) return [];
  const checkMode = options[0]!.check === true;
  if (options.some((option) => (option.check === true) !== checkMode)) {
    throw new Error("[genapi] generateMany 的 check 模式必须一致");
  }

  const projects: ProjectArtifacts[] = [];
  for (const option of options) {
    const next = await buildProjectArtifacts(option);
    if (projects.some((project) => project.outputDir === next.outputDir)) {
      throw new Error(`[genapi] 同一输出目录被重复生成：${next.outputDir}`);
    }
    projects.push(next);
  }

  if (checkMode) {
    const results: GenerateResult[] = [];
    for (const project of projects) {
      const changedFiles = await compareArtifacts(project.outputDir, project.files);
      results.push({
        ...project.result,
        changed: changedFiles.length > 0,
        changedFiles,
      });
    }
    return results;
  }

  const outputRoots = [...new Set(projects.map((project) => dirname(project.outputDir)))];
  if (outputRoots.length !== 1) {
    throw new Error("[genapi] 一次 generateMany 事务中的 project 必须使用同一 outputDir 根目录");
  }
  const outputRoot = outputRoots[0]!;
  const releaseLock = await acquireGenerationLock(outputRoot);
  try {
    await recoverInterruptedTransactions(outputRoot);
    for (const project of projects) await recoverOrphanProjectDirectories(project.outputDir);

    const evaluated: Array<{ project: ProjectArtifacts; changedFiles: string[] }> = [];
    for (const project of projects) {
      evaluated.push({
        project,
        changedFiles: await compareArtifacts(project.outputDir, project.files),
      });
    }
    await commitProjectArtifacts(
      outputRoot,
      evaluated.filter((item) => item.changedFiles.length > 0).map((item) => item.project),
    );
    return evaluated.map(({ project, changedFiles }) => ({
      ...project.result,
      changed: changedFiles.length > 0,
      changedFiles,
    }));
  } finally {
    await releaseLock();
  }
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const [result] = await generateMany([opts]);
  return result!;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function loadGeneratorMetadata(): Promise<{
  generatorVersion: string;
  openapiTypescriptVersion: string;
  typescriptVersion: string;
  esbuildVersion: string;
}> {
  const raw = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const dependency = (name: string): string => {
    const value = raw.dependencies?.[name];
    if (typeof value !== "string") throw new Error(`[genapi] package.json 缺少依赖版本：${name}`);
    return value;
  };
  if (typeof raw.version !== "string") throw new Error("[genapi] package.json 缺少 version");
  return {
    generatorVersion: raw.version,
    openapiTypescriptVersion: dependency("openapi-typescript"),
    typescriptVersion: dependency("typescript"),
    esbuildVersion: dependency("esbuild"),
  };
}

async function renderManifest(projectId: string, serviceModels: ServiceModel[]): Promise<string> {
  const metadata = await loadGeneratorMetadata();
  const services = Object.fromEntries(
    serviceModels.map((model) => [
      model.config.name,
      { normalizedDocumentHash: model.normalizedDocumentHash },
    ]),
  );
  return `${JSON.stringify(
    {
      formatVersion: 2,
      generator: "@xapiforge/genapi",
      ...metadata,
      project: projectId,
      services,
    },
    null,
    2,
  )}\n`;
}

async function listRelativeFiles(root: string, prefix = ""): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function compareArtifacts(
  outputDir: string,
  expectedFiles: ReadonlyMap<string, string>,
): Promise<string[]> {
  const existingFiles = await listRelativeFiles(outputDir);
  const candidates = new Set([...existingFiles, ...expectedFiles.keys()]);
  const changed: string[] = [];
  for (const relativePath of [...candidates].sort()) {
    const expected = expectedFiles.get(relativePath);
    if (expected === undefined || !existsSync(join(outputDir, relativePath))) {
      changed.push(relativePath);
      continue;
    }
    const actual = normalizeLineEndings(await readFile(join(outputDir, relativePath), "utf8"));
    if (actual !== expected) changed.push(relativePath);
  }
  return changed;
}

async function writeArtifacts(
  outputDir: string,
  files: ReadonlyMap<string, string>,
): Promise<void> {
  const staleFiles = (await listRelativeFiles(outputDir)).filter((file) => !files.has(file));
  if (staleFiles.length > 0) {
    throw new Error(
      `[genapi] 输出目录包含本次 manifest 之外的旧文件，拒绝静默删除：${staleFiles.join(", ")}`,
    );
  }
  for (const [relativePath, content] of [...files.entries()].sort(([a], [b]) =>
    lexicalCompare(a, b),
  )) {
    const target = join(outputDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function fileSystemErrorCode(cause: unknown): string | undefined {
  return isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
}

async function acquireGenerationLock(outputRoot: string): Promise<() => Promise<void>> {
  await mkdir(outputRoot, { recursive: true });
  const lockPath = join(outputRoot, ".xapiforge-generation.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ formatVersion: 1, pid: process.pid })}\n`, "utf8");
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((cause: unknown) => {
          if (fileSystemErrorCode(cause) !== "ENOENT") throw cause;
        });
      };
    } catch (cause) {
      if (fileSystemErrorCode(cause) !== "EEXIST") throw cause;
      let lock: { pid?: unknown };
      try {
        lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
      } catch (readCause) {
        throw new Error(`[genapi] 无法读取生成锁：${lockPath}`, { cause: readCause });
      }
      if (!Number.isInteger(lock.pid) || Number(lock.pid) <= 0) {
        throw new Error(`[genapi] 生成锁内容无效，请人工确认后处理：${lockPath}`);
      }
      let processAlive = true;
      try {
        process.kill(Number(lock.pid), 0);
      } catch (processCause) {
        processAlive = fileSystemErrorCode(processCause) !== "ESRCH";
      }
      if (processAlive) {
        throw new Error(`[genapi] 生成目录正被 PID ${String(lock.pid)} 使用：${outputRoot}`);
      }
      await unlink(lockPath);
    }
  }
  throw new Error(`[genapi] 无法获取生成锁：${lockPath}`);
}

function transactionStatePath(outputRoot: string, transactionId: string): string {
  return join(outputRoot, `.xapiforge-transaction-${transactionId}.json`);
}

function validateTransactionState(
  value: unknown,
  statePath: string,
): asserts value is TransactionState {
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.transactionId !== "string") {
    throw new Error(`[genapi] transaction state 无效：${statePath}`);
  }
  if (value.phase !== "committing" && value.phase !== "committed") {
    throw new Error(`[genapi] transaction phase 无效：${statePath}`);
  }
  if (!Array.isArray(value.projects))
    throw new Error(`[genapi] transaction projects 无效：${statePath}`);
  for (const project of value.projects) {
    if (
      !isRecord(project) ||
      typeof project.project !== "string" ||
      !CONFIG_ID_PATTERN.test(project.project) ||
      typeof project.output !== "string" ||
      typeof project.staging !== "string" ||
      typeof project.backup !== "string" ||
      typeof project.hadOutput !== "boolean"
    ) {
      throw new Error(`[genapi] transaction project 无效：${statePath}`);
    }
  }
}

function resolveTransactionEntryPath(
  outputRoot: string,
  name: string,
  expectedPrefix: string,
  statePath: string,
): string {
  const prefixMatches = expectedPrefix.startsWith(".")
    ? name.startsWith(expectedPrefix)
    : name === expectedPrefix;
  if (basename(name) !== name || !prefixMatches) {
    throw new Error(`[genapi] transaction 路径不合法：${statePath} -> ${name}`);
  }
  const resolved = resolve(outputRoot, name);
  assertPathInside(outputRoot, resolved, "transaction 路径");
  return resolved;
}

async function recoverTransactionState(
  outputRoot: string,
  state: TransactionState,
  statePath: string,
): Promise<void> {
  for (const project of [...state.projects].reverse()) {
    const outputDir = resolveTransactionEntryPath(
      outputRoot,
      project.output,
      project.project,
      statePath,
    );
    const stagingDir = resolveTransactionEntryPath(
      outputRoot,
      project.staging,
      `.${project.project}.xapiforge-tmp-`,
      statePath,
    );
    const backupDir = resolveTransactionEntryPath(
      outputRoot,
      project.backup,
      `.${project.project}.xapiforge-backup-`,
      statePath,
    );

    if (state.phase === "committing") {
      if (existsSync(backupDir)) {
        if (existsSync(outputDir)) await rm(outputDir, { recursive: true, force: true });
        await rename(backupDir, outputDir);
      } else if (!project.hadOutput && existsSync(outputDir) && !existsSync(stagingDir)) {
        await rm(outputDir, { recursive: true, force: true });
      }
    } else if (existsSync(backupDir)) {
      await rm(backupDir, { recursive: true, force: true });
    }
    await rm(stagingDir, { recursive: true, force: true });
  }
  await unlink(statePath).catch((cause: unknown) => {
    if (fileSystemErrorCode(cause) !== "ENOENT") throw cause;
  });
}

async function recoverInterruptedTransactions(outputRoot: string): Promise<void> {
  if (!existsSync(outputRoot)) return;
  const stateFiles = (await readdir(outputRoot))
    .filter((name) => /^\.xapiforge-transaction-[A-Za-z0-9-]+\.json$/.test(name))
    .sort();
  for (const stateFile of stateFiles) {
    const statePath = join(outputRoot, stateFile);
    let state: unknown;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (cause) {
      throw new Error(`[genapi] 无法解析 transaction state，请人工确认：${statePath}`, { cause });
    }
    validateTransactionState(state, statePath);
    await recoverTransactionState(outputRoot, state, statePath);
  }
}

async function recoverOrphanProjectDirectories(outputDir: string): Promise<void> {
  const outputRoot = dirname(outputDir);
  if (!existsSync(outputRoot)) return;
  const project = basename(outputDir);
  const entries = await readdir(outputRoot);
  const backups = entries.filter((name) => name.startsWith(`.${project}.xapiforge-backup-`)).sort();
  const stagings = entries.filter((name) => name.startsWith(`.${project}.xapiforge-tmp-`)).sort();
  if (backups.length > 1) {
    throw new Error(
      `[genapi] project ${project} 存在多个孤立 backup，请人工确认：${backups.join(", ")}`,
    );
  }
  if (backups.length === 1) {
    const backupDir = join(outputRoot, backups[0]!);
    if (existsSync(outputDir)) await rm(backupDir, { recursive: true, force: true });
    else await rename(backupDir, outputDir);
  }
  for (const staging of stagings) {
    await rm(join(outputRoot, staging), { recursive: true, force: true });
  }
}

async function writeTransactionState(outputRoot: string, state: TransactionState): Promise<string> {
  const statePath = transactionStatePath(outputRoot, state.transactionId);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return statePath;
}

async function commitProjectArtifacts(
  outputRoot: string,
  projects: ProjectArtifacts[],
): Promise<void> {
  if (projects.length === 0) return;
  const transactionId = randomUUID();
  const state: TransactionState = {
    formatVersion: 1,
    transactionId,
    phase: "committing",
    projects: projects.map((project) => {
      const projectName = basename(project.outputDir);
      return {
        project: projectName,
        output: projectName,
        staging: `.${projectName}.xapiforge-tmp-${transactionId}`,
        backup: `.${projectName}.xapiforge-backup-${transactionId}`,
        hadOutput: existsSync(project.outputDir),
      };
    }),
  };

  try {
    for (const [index, project] of projects.entries()) {
      const entry = state.projects[index]!;
      await writeArtifacts(join(outputRoot, entry.staging), project.files);
    }
  } catch (cause) {
    await Promise.all(
      state.projects.map((entry) =>
        rm(join(outputRoot, entry.staging), { recursive: true, force: true }),
      ),
    );
    throw cause;
  }

  const statePath = await writeTransactionState(outputRoot, state);
  try {
    for (const entry of state.projects) {
      const outputDir = join(outputRoot, entry.output);
      if (entry.hadOutput) await rename(outputDir, join(outputRoot, entry.backup));
    }
    for (const entry of state.projects) {
      await rename(join(outputRoot, entry.staging), join(outputRoot, entry.output));
    }
    const committedState: TransactionState = { ...state, phase: "committed" };
    await writeTransactionState(outputRoot, committedState);
    state.phase = "committed";
  } catch (cause) {
    try {
      await recoverTransactionState(outputRoot, state, statePath);
    } catch (rollbackCause) {
      throw new Error(`[genapi] 提交失败且自动回滚未完成，transaction state：${statePath}`, {
        cause: new AggregateError([cause, rollbackCause]),
      });
    }
    throw new Error("[genapi] 提交生成目录失败，旧产物已恢复", { cause });
  }

  await recoverTransactionState(outputRoot, state, statePath);
}

/**
 * 跑 openapi-typescript 生成 types.ts。
 */
async function runOpenapiTypescript(document: OpenAPI3): Promise<string> {
  // 直接调用依赖的程序 API，不依赖消费者项目是否把传递依赖的 bin 提升到
  // node_modules/.bin。这样 npm、pnpm（含 isolated linker）和 yarn 项目行为一致。
  const ast = await openapiTS(document);
  return astToString(ast);
}

/**
 * 从 swagger.json 抽 paths，按 tag 聚合。
 */
function extractTags(document: OpenAPI3): Record<string, TagInfo[]> {
  const tags: Record<string, TagInfo[]> = {};
  for (const [pathStr, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, rawOp] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
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
  const firstServiceKey = safeKey(serviceNames[0] ?? "service");

  const parts: string[] = [];

  parts.push("/**");
  parts.push(` * ${projectDisplay} API 客户端（生成产物，自动生成勿手改）`);
  parts.push(" *");
  parts.push(
    " * 引擎：openapi-typescript（路径/schema 类型）+ @xapiforge/core createNet（data-or-throw/鉴权/重试）",
  );
  parts.push(" *");
  parts.push(` * 项目：${projectDisplay} (${projectId})`);
  parts.push(` * 服务数：${serviceNames.length}`);
  parts.push(` * 总 endpoint 数：${totalEndpoints}`);
  parts.push(" *");
  parts.push(" * 设计：");
  parts.push(
    " *   - 每个 service 用 createNet<paths> 创建独立 client（service override > project defaults）",
  );
  parts.push(" *   - createNet 成功返回 { data, response }；最终失败统一抛 ApiError");
  parts.push(
    " *   - 业务侧 middleware（envelope 解包等）可由 defaults 共享，也可由 service 整体替换",
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

  // import createNet + Core 配置类型 + 每个 service paths
  parts.push("// @xapiforge/core createNet：封装 openapi-fetch + data-or-throw + auth/retry");
  parts.push('import { createNet } from "@xapiforge/core";');
  parts.push('import type { NetClient, NetConfig, ValidateStatus } from "@xapiforge/core";');
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
  parts.push(" * - 业务侧 middleware（envelope 解包）通过 defaults 注入，service 可显式整体替换");
  parts.push(" *");
  parts.push(" * 调用形式（method/path/body 全强类型）：");
  parts.push(
    ` *   api.${firstServiceKey}.GET("/api/identity/users/{id}", { params: { path: { id } } });`,
  );
  parts.push(
    ` *   api.${firstServiceKey}.POST("/api/identity/users", { body: { userName: "x", ... } });`,
  );
  parts.push(" */");
  parts.push(
    `export type Api${cap(projectId)}ServiceName = ${serviceNames.map((name) => JSON.stringify(name)).join(" | ")};`,
  );
  parts.push("");
  parts.push("/** service 级允许覆盖的 Core 配置；middleware 数组为替换语义，不会自动拼接。 */");
  parts.push(`export type Api${cap(projectId)}ServiceOverrides = Partial<`);
  parts.push(`  Pick<`);
  parts.push(`    NetConfig,`);
  parts.push(
    `    | "baseURL" | "authService" | "middleware" | "fetch" | "defaultTimeoutMs" | "maxRetries" | "retryDelayMs" | "logger"`,
  );
  parts.push(`  >`);
  parts.push(`>;`);
  parts.push("");
  parts.push(`export interface Api${cap(projectId)}LayeredClientConfig {`);
  parts.push(`  /** project 默认配置；validateStatus 与 resolveErrorMessage 保持 project 级。 */`);
  parts.push(`  defaults: NetConfig;`);
  parts.push(`  /** service override 仅覆盖值不为 undefined 的字段。 */`);
  parts.push(`  services?: Partial<`);
  parts.push(`    Record<Api${cap(projectId)}ServiceName, Api${cap(projectId)}ServiceOverrides>`);
  parts.push(`  >;`);
  parts.push("}");
  parts.push("");
  parts.push(`/** 兼容旧的平铺 NetConfig，也支持 defaults/services 分层配置。 */`);
  parts.push(
    `export type Api${cap(projectId)}ClientConfig = NetConfig | Api${cap(projectId)}LayeredClientConfig;`,
  );
  parts.push("");
  parts.push(`export type Api${cap(projectId)}ClientConfigWithCustomStatus =`);
  parts.push(`  | (NetConfig & { validateStatus: ValidateStatus })`);
  parts.push(`  | (Omit<Api${cap(projectId)}LayeredClientConfig, "defaults"> & {`);
  parts.push(`      defaults: NetConfig & { validateStatus: ValidateStatus };`);
  parts.push(`    });`);
  parts.push("");
  parts.push(`function merge${cap(projectId)}ServiceConfig(`);
  parts.push(`  defaults: NetConfig,`);
  parts.push(`  override: Api${cap(projectId)}ServiceOverrides | undefined,`);
  parts.push(`): NetConfig {`);
  parts.push(`  if (!override) return defaults;`);
  parts.push(`  return {`);
  parts.push(`    baseURL: override.baseURL === undefined ? defaults.baseURL : override.baseURL,`);
  parts.push(
    `    authService: override.authService === undefined ? defaults.authService : override.authService,`,
  );
  parts.push(
    `    middleware: override.middleware === undefined ? defaults.middleware : override.middleware,`,
  );
  parts.push(`    validateStatus: defaults.validateStatus,`);
  parts.push(`    resolveErrorMessage: defaults.resolveErrorMessage,`);
  parts.push(`    fetch: override.fetch === undefined ? defaults.fetch : override.fetch,`);
  parts.push(
    `    defaultTimeoutMs: override.defaultTimeoutMs === undefined ? defaults.defaultTimeoutMs : override.defaultTimeoutMs,`,
  );
  parts.push(
    `    maxRetries: override.maxRetries === undefined ? defaults.maxRetries : override.maxRetries,`,
  );
  parts.push(
    `    retryDelayMs: override.retryDelayMs === undefined ? defaults.retryDelayMs : override.retryDelayMs,`,
  );
  parts.push(`    logger: override.logger === undefined ? defaults.logger : override.logger,`);
  parts.push(`  };`);
  parts.push(`}`);
  parts.push("");

  parts.push(`export function create${cap(projectId)}Client(`);
  parts.push(`  config: Api${cap(projectId)}ClientConfigWithCustomStatus,`);
  parts.push(`): Api${cap(projectId)}<true>;`);
  parts.push(`export function create${cap(projectId)}Client(`);
  parts.push(`  config: Api${cap(projectId)}ClientConfig,`);
  parts.push(`): Api${cap(projectId)}<false>;`);
  parts.push(`export function create${cap(projectId)}Client(`);
  parts.push(`  config: Api${cap(projectId)}ClientConfig,`);
  parts.push(`): Api${cap(projectId)}<boolean> {`);
  parts.push(`  const layered = "defaults" in config;`);
  parts.push(`  const defaults = layered ? config.defaults : config;`);
  parts.push(`  const serviceOverrides = layered ? config.services : undefined;`);
  parts.push(`  return {`);

  for (const s of services) {
    parts.push(`    /** ${s.name}（${s.endpointCount} endpoints） */`);
    parts.push(
      `    ${safeKey(s.name)}: createNet<${cap(s.name)}Paths>(merge${cap(projectId)}ServiceConfig(defaults, serviceOverrides?.[${JSON.stringify(s.name)}])),`,
    );
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
 *   - 默认取 full schema name 最后一段作为便利 alias
 *   - alias 或 namespace 冲突直接失败，不按 service 顺序静默跳过或自动改名
 *   - `typeExports.aliases` 可给指定 service/full schema 配置稳定公开名
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
  serviceModels: ServiceModel[],
  typeExports?: ProjectTypeExportConfig,
  compatibility?: GenapiCompatibilityConfig,
  namespacePrefixAliases?: NamespacePrefixAlias[],
): string {
  const lines: string[] = [];
  const serviceNames = serviceModels.map((model) => model.config.name);

  lines.push("/* eslint-disable */");
  lines.push("/**");
  lines.push(` * @${projectId}/api-types — 自动生成，别手改`);
  lines.push(" *");
  lines.push(` * 数据源：openapi-typescript 生成的 components.schemas（见 ./types/<service>.ts）`);
  lines.push(` * 项目：${projectDisplay}（${projectId}），service 数：${serviceNames.length}`);
  lines.push(" *");
  const namespaceRules = typeExports?.namespaces ?? [];
  if (namespaceRules.length > 0 || (namespacePrefixAliases?.length ?? 0) > 0) {
    lines.push(" * 命名空间分组：");
    for (const rule of namespaceRules) {
      lines.push(
        ` *   ${rule.service ? `${rule.service}: ` : ""}${rule.match} → namespace ${rule.namespace}`,
      );
    }
    for (const rule of namespacePrefixAliases ?? []) {
      lines.push(` *   [legacy] ${rule.match} → namespace ${rule.namespace}`);
    }
    lines.push(" *");
  }
  lines.push(" * 字段拼错立刻报错；swagger 改了 → pnpm generate:api → 类型自动同步。");
  lines.push(" */");
  lines.push("");

  // 收集所有 schemas（每 service 一份 components，可能有同 full 名重复）
  type SchemaRef = { svc: string; full: string };
  const collected: SchemaRef[] = [];
  for (const model of serviceModels) {
    for (const schemaName of Object.keys(model.schemas)) {
      collected.push({ svc: model.config.name, full: schemaName });
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
    // 用 safeKey 过滤非法字符；数字开头或 TypeScript 保留字统一前缀 _。
    const k = raw.replace(/[^A-Za-z0-9_$]/g, "_");
    return /^[0-9]/.test(k) || TYPESCRIPT_RESERVED_WORDS.has(k) ? `_${k}` : k;
  }

  // 命名空间匹配按配置顺序执行；project 级规则优先于 legacy root 规则。
  function matchNamespace(service: string, full: string): string | null {
    for (const rule of namespaceRules) {
      if ((rule.service === undefined || rule.service === service) && full.startsWith(rule.match)) {
        return rule.namespace;
      }
    }
    for (const rule of namespacePrefixAliases ?? []) {
      if (full.startsWith(rule.match)) return rule.namespace;
    }
    return null;
  }

  interface ExportEntry {
    namespace: string | null;
    alias: string;
    full: string;
    svc: string;
  }

  const explicitAliases = new Map(
    (typeExports?.aliases ?? []).map((rule) => [`${rule.service}\u0000${rule.schema}`, rule]),
  );
  for (const rule of typeExports?.aliases ?? []) {
    const model = serviceModels.find((candidate) => candidate.config.name === rule.service)!;
    if (!(rule.schema in model.schemas)) {
      throw new Error(
        `[genapi] 显式 alias 指向不存在的 schema：${rule.service}/${rule.schema} → ${rule.exportAs}`,
      );
    }
  }

  const exportTargets = new Map<string, ExportEntry>();
  const byNamespace = new Map<string, ExportEntry[]>();
  const flatEntries: ExportEntry[] = [];
  const addExport = (entry: ExportEntry): void => {
    const target = `${entry.namespace ?? ""}\u0000${entry.alias}`;
    const previous = exportTargets.get(target);
    if (previous) {
      const qualified = entry.namespace ? `${entry.namespace}.${entry.alias}` : entry.alias;
      throw new Error(
        `[genapi] schema alias 冲突：${qualified}\n` +
          `  - ${previous.svc}/${previous.full}\n` +
          `  - ${entry.svc}/${entry.full}\n` +
          "请在 projects[].typeExports.aliases 中为至少一个 schema 配置唯一 exportAs，例如：\n" +
          `  { service: ${JSON.stringify(entry.svc)}, schema: ${JSON.stringify(entry.full)}, exportAs: ${JSON.stringify(`${cap(entry.svc)}${entry.alias}`)} }`,
      );
    }
    if (entry.namespace === null && byNamespace.has(entry.alias)) {
      throw new Error(`[genapi] 顶层 alias "${entry.alias}" 与同名 namespace 冲突`);
    }
    if (
      entry.namespace !== null &&
      flatEntries.some((candidate) => candidate.alias === entry.namespace)
    ) {
      throw new Error(`[genapi] namespace "${entry.namespace}" 与同名顶层 alias 冲突`);
    }
    exportTargets.set(target, entry);
    if (entry.namespace === null) flatEntries.push(entry);
    else {
      const entries = byNamespace.get(entry.namespace) ?? [];
      entries.push(entry);
      byNamespace.set(entry.namespace, entries);
    }
  };

  for (const schema of collected) {
    const explicit = explicitAliases.get(`${schema.svc}\u0000${schema.full}`);
    const automaticAlias = shortAlias(schema.full);
    const alias = explicit?.exportAs ?? (automaticAlias ? safeAlias(automaticAlias) : "");
    if (!alias) continue;
    addExport({
      namespace: explicit?.namespace ?? matchNamespace(schema.svc, schema.full),
      alias,
      full: schema.full,
      svc: schema.svc,
    });
  }

  // 每个 service 的 components 都是 canonical schema 来源，不跨 service 合并。
  for (const svc of serviceNames) {
    lines.push(`import type { components as ${cap(svc)}Components } from "./types/${svc}.js";`);
  }
  lines.push("");

  lines.push("export interface SchemasByService {");
  for (const svc of serviceNames) {
    lines.push(`  ${JSON.stringify(svc)}: ${cap(svc)}Components["schemas"];`);
  }
  lines.push("}");
  lines.push("");
  lines.push("export type ServiceName = keyof SchemasByService;");
  lines.push("export type SchemaOf<");
  lines.push("  Service extends ServiceName,");
  lines.push("  Name extends keyof SchemasByService[Service],");
  lines.push("> = SchemasByService[Service][Name];");
  lines.push("");

  if (serviceNames.length === 1) {
    lines.push(`export type AllSchemas = ${cap(serviceNames[0]!)}Components["schemas"];`);
    lines.push("");
  } else if (compatibility?.legacyAllSchemas === true) {
    const schemaOwners = new Map<string, string>();
    for (const schema of collected) {
      const previousService = schemaOwners.get(schema.full);
      if (previousService) {
        throw new Error(
          `[genapi] compatibility.legacyAllSchemas 无法安全生成：schema "${schema.full}" 同时存在于 ${previousService} 和 ${schema.svc}`,
        );
      }
      schemaOwners.set(schema.full, schema.svc);
    }
    lines.push("/** @deprecated 多 service 请改用 SchemasByService / SchemaOf。 */");
    lines.push(
      `export type AllSchemas = UnionToIntersection<${serviceNames
        .map((service) => `${cap(service)}Components["schemas"]`)
        .join(" | ")}>;`,
    );
    lines.push("type UnionToIntersection<U> =");
    lines.push("  (U extends unknown ? (value: U) => void : never) extends");
    lines.push("    (value: infer Intersection) => void");
    lines.push("    ? Intersection");
    lines.push("    : never;");
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
    entries.sort((a, b) => lexicalCompare(a.alias, b.alias));
    for (const e of entries) {
      lines.push(`  /** ${e.full}（原 service: ${e.svc}）*/`);
      lines.push(
        `  export type ${e.alias} = SchemaOf<${JSON.stringify(e.svc)}, ${JSON.stringify(e.full)}>;`,
      );
    }
    lines.push("}");
    lines.push("");
  }

  // ---- 全局 alias 输出 ----
  // 按 alias 排序，保证生成稳定
  flatEntries.sort((a, b) => lexicalCompare(a.alias, b.alias));
  for (const e of flatEntries) {
    lines.push(`/** ${e.full}（原 service: ${e.svc}）*/`);
    lines.push(
      `export type ${e.alias} = SchemaOf<${JSON.stringify(e.svc)}, ${JSON.stringify(e.full)}>;`,
    );
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
