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
 *   - 调用形式：api.<service>.GET/POST；path、参数和 body 由该 service OpenAPI 约束
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

import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";
import { canonicalizeOpenApi, canonicalOpenApiHash, freezeOpenApi } from "./canonical-openapi.js";
import {
  lexicalCompare,
  pascalCaseConfigId,
  safeCommentText,
  safeRuntimeKey,
  TYPESCRIPT_RESERVED_WORDS,
} from "./naming.js";
import { parseJsonInput } from "./json-input.js";
import {
  createOpenApiTypescriptInput,
  referenceChildRole,
  type ReferenceWalkRole,
} from "./reference-context.js";
import {
  DEFAULT_MAX_SWAGGER_BYTES,
  isValidFetchTimeout,
  isValidSwaggerSize,
} from "./swagger-fetch.js";
import { isPathInside, resolvePhysicalPath } from "./filesystem-path.js";
import { resolveSwaggerInputPath, type SwaggerSource } from "./swagger-source.js";
import { renderApiTypes, type ProjectTypeExportConfig } from "./type-exports.js";

export type { SwaggerFileSource, SwaggerSource, SwaggerUrlSource } from "./swagger-source.js";
export type {
  NamespaceRule,
  ProjectTypeExportConfig,
  SchemaAliasRule,
  TypeExportStrategy,
} from "./type-exports.js";

// ---------- 语义类型 ----------

export function defineConfig(config: XApiForgeConfig): XApiForgeConfig {
  return config;
}

export interface ServiceConfig {
  name: string;
  displayName: string;
  /** OpenAPI 来源。file 相对配置文件所在目录；url 必须是完整 HTTP(S) URL。 */
  source: SwaggerSource;
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
  services: ServiceConfig[];
  /** project 级 hooks（service 未显式配置时优先于 root hooks）。 */
  hooks?: GenapiHooks;
  /** v2 schema 便利导出规则。 */
  typeExports?: ProjectTypeExportConfig;
}

export interface XApiForgeConfig {
  timeoutMs: number;
  /** 单个本地文件、离线缓存或远程响应的最大字节数；默认 64 MiB。 */
  maxSwaggerBytes?: number;
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
  /** source.file 相对路径的解析目录；默认当前工作目录（CLI 的配置文件目录）。 */
  configDirectory?: string;
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

function validateGenerateOptions(value: unknown, path: string): asserts value is GenerateOptions {
  if (!isRecord(value)) throw configError(`${path} 必须是对象`);
  assertAllowedFields(value, path, [
    "check",
    "configDirectory",
    "emitApiTypes",
    "hooks",
    "outputDir",
    "projectId",
    "swaggerDir",
    "xapiForgeConfig",
  ]);
  assertConfigId(value.projectId, `${path}.projectId`);
  assertFileSystemPath(value.swaggerDir, `${path}.swaggerDir`);
  assertFileSystemPath(value.outputDir, `${path}.outputDir`);
  if (value.configDirectory !== undefined) {
    assertFileSystemPath(value.configDirectory, `${path}.configDirectory`);
  }
  for (const field of ["check", "emitApiTypes"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw configError(`${path}.${field} 必须是 boolean`);
    }
  }
  validateHooks(value.hooks, `${path}.hooks`);
  if (!isRecord(value.xapiForgeConfig)) {
    throw configError(`${path}.xapiForgeConfig 必须是对象`);
  }
}

// ---------- 内部类型 ----------

interface ServiceInfo {
  name: string;
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
const JSON_SCHEMA_ANCHOR_PATTERN = /^[A-Za-z_][-A-Za-z0-9._]*$/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string): Error {
  return new Error(`[genapi] 配置错误：${message}`);
}

function rejectRemovedFields(
  value: Record<string, unknown>,
  path: string,
  fields: readonly string[],
): void {
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length > 0) {
    throw configError(`${path} 包含 v2 已移除字段：${present.join(", ")}`);
  }
}

function assertAllowedFields(
  value: Record<string, unknown>,
  path: string,
  allowedFields: readonly string[],
): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value)
    .filter((field) => !allowed.has(field))
    .sort(lexicalCompare);
  if (unknown.length > 0) {
    throw configError(`${path} 包含未知字段：${unknown.join(", ")}`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(`${path} 必须是非空字符串`);
  }
}

function assertFileSystemPath(value: unknown, path: string): asserts value is string {
  assertNonEmptyString(value, path);
  if (value.includes("\0")) throw configError(`${path} 不得包含 NUL 字符`);
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
  assertAllowedFields(value, path, ["transformSwagger", "transformTypes"]);
  for (const key of ["transformSwagger", "transformTypes"] as const) {
    const hook = value[key];
    if (hook !== undefined && typeof hook !== "function") {
      throw configError(`${path}.${key} 必须是函数`);
    }
  }
}

function validateSwaggerSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw configError(`${path} 必须是对象`);
  const unknownKeys = Object.keys(value).filter((key) => key !== "file" && key !== "url");
  if (unknownKeys.length > 0) {
    throw configError(`${path} 包含未知字段：${unknownKeys.sort().join(", ")}`);
  }
  const hasFile = value.file !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasFile === hasUrl) {
    throw configError(`${path} 必须且只能配置 file 或 url 其中一个`);
  }
  if (hasFile) {
    assertFileSystemPath(value.file, `${path}.file`);
    if (!value.file.toLowerCase().endsWith(".json")) {
      throw configError(`${path}.file 必须指向 .json 文件`);
    }
    return;
  }

  assertNonEmptyString(value.url, `${path}.url`);
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    throw configError(`${path}.url 必须是完整 URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configError(`${path}.url 只支持 http: 或 https:`);
  }
  if (parsed.username || parsed.password) {
    throw configError(`${path}.url 不得包含用户名或密码`);
  }
  if (parsed.hash) {
    throw configError(`${path}.url 不得包含 fragment；HTTP 请求不会发送 # 后内容`);
  }
}

/** 在 CLI 或 programmatic generate 写文件前执行完整运行时配置校验。 */
export function validateConfig(config: XApiForgeConfig): void {
  if (!isRecord(config)) throw configError("根配置必须是对象");
  rejectRemovedFields(config, "根配置", ["defaultPath", "namespacePrefixAliases"]);
  assertAllowedFields(config, "根配置", [
    "genOutputDir",
    "hooks",
    "maxSwaggerBytes",
    "mode",
    "outputDir",
    "projects",
    "timeoutMs",
  ]);
  assertFileSystemPath(config.outputDir, "outputDir");
  if (config.genOutputDir !== undefined) {
    assertFileSystemPath(config.genOutputDir, "genOutputDir");
  }
  if (!isValidFetchTimeout(config.timeoutMs)) {
    throw configError("timeoutMs 必须是 1..2147483647 范围内的整数毫秒");
  }
  if (config.maxSwaggerBytes !== undefined && !isValidSwaggerSize(config.maxSwaggerBytes)) {
    throw configError("maxSwaggerBytes 必须是正安全整数");
  }
  if (config.mode !== undefined && config.mode !== "online" && config.mode !== "offline") {
    throw configError(`mode 只能是 "online" 或 "offline"，实际为 "${String(config.mode)}"`);
  }
  validateHooks(config.hooks, "hooks");

  if (!Array.isArray(config.projects) || config.projects.length === 0) {
    throw configError("projects 必须是非空数组");
  }
  const projectIds = new Set<string>();
  const projectTypeNames = new Map<string, string>();
  for (const [projectIndex, project] of config.projects.entries()) {
    const projectPath = `projects[${projectIndex}]`;
    if (!isRecord(project)) throw configError(`${projectPath} 必须是对象`);
    rejectRemovedFields(project, projectPath, ["baseHost", "compatibility"]);
    assertAllowedFields(project, projectPath, [
      "displayName",
      "hooks",
      "name",
      "services",
      "typeExports",
    ]);
    assertConfigId(project.name, `${projectPath}.name`);
    assertNonEmptyString(project.displayName, `${projectPath}.displayName`);
    validateHooks(project.hooks, `${projectPath}.hooks`);

    if (projectIds.has(project.name)) {
      throw configError(`project ID 重复："${project.name}"`);
    }
    projectIds.add(project.name);
    const projectTypeName = pascalCaseConfigId(project.name);
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
      rejectRemovedFields(service, servicePath, ["baseHost", "port", "path"]);
      assertAllowedFields(service, servicePath, ["displayName", "hooks", "name", "source"]);
      assertConfigId(service.name, `${servicePath}.name`);
      assertNonEmptyString(service.displayName, `${servicePath}.displayName`);
      validateSwaggerSource(service.source, `${servicePath}.source`);
      validateHooks(service.hooks, `${servicePath}.hooks`);

      if (serviceIds.has(service.name)) {
        throw configError(`${projectPath} 下 service ID 重复："${service.name}"`);
      }
      serviceIds.add(service.name);

      const serviceTypeName = pascalCaseConfigId(service.name);
      const previousTypeId = serviceTypeNames.get(serviceTypeName);
      if (previousTypeId) {
        throw configError(
          `${projectPath} 下 service "${previousTypeId}" 与 "${service.name}" 生成相同 TypeScript 名称 "${serviceTypeName}"`,
        );
      }
      serviceTypeNames.set(serviceTypeName, service.name);

      const runtimeKey = safeRuntimeKey(service.name);
      const previousRuntimeId = runtimeKeys.get(runtimeKey);
      if (previousRuntimeId) {
        throw configError(
          `${projectPath} 下 service "${previousRuntimeId}" 与 "${service.name}" 生成相同 runtime key "${runtimeKey}"`,
        );
      }
      runtimeKeys.set(runtimeKey, service.name);
    }

    if (project.typeExports !== undefined) {
      if (!isRecord(project.typeExports)) {
        throw configError(`${projectPath}.typeExports 必须是对象`);
      }
      rejectRemovedFields(project.typeExports, `${projectPath}.typeExports`, ["collisionPolicy"]);
      assertAllowedFields(project.typeExports, `${projectPath}.typeExports`, [
        "aliases",
        "namespaces",
        "strategy",
      ]);
      const strategy = project.typeExports.strategy ?? "service-namespace";
      if (
        strategy !== "canonical-only" &&
        strategy !== "flat-strict" &&
        strategy !== "service-namespace"
      ) {
        throw configError(
          `${projectPath}.typeExports.strategy 只能是 canonical-only、flat-strict 或 service-namespace`,
        );
      }

      const namespaceRules = project.typeExports.namespaces ?? [];
      if (!Array.isArray(namespaceRules)) {
        throw configError(`${projectPath}.typeExports.namespaces 必须是数组`);
      }
      const namespaceRuleKeys = new Set<string>();
      for (const [index, rule] of namespaceRules.entries()) {
        const rulePath = `${projectPath}.typeExports.namespaces[${index}]`;
        if (!isRecord(rule)) throw configError(`${rulePath} 必须是对象`);
        assertAllowedFields(rule, rulePath, ["match", "namespace", "service"]);
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
        assertAllowedFields(rule, rulePath, ["exportAs", "namespace", "schema", "service"]);
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
        const targetScope = strategy === "service-namespace" ? rule.service : "*";
        const targetKey = `${targetScope}\u0000${rule.namespace ?? ""}\u0000${rule.exportAs}`;
        if (aliasTargets.has(targetKey)) {
          throw configError(
            `${rulePath} 的导出目标 ${rule.namespace ? `${rule.namespace}.` : ""}${rule.exportAs} 重复`,
          );
        }
        aliasTargets.add(targetKey);
      }
      if (strategy === "canonical-only" && (namespaceRules.length > 0 || aliasRules.length > 0)) {
        throw configError(
          `${projectPath}.typeExports.strategy=canonical-only 不能同时配置 namespace 或 alias`,
        );
      }
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
  if (
    isRecord(value.components) &&
    value.components.schemas !== undefined &&
    !isRecord(value.components.schemas)
  ) {
    throw new Error(`[genapi] ${label}.components.schemas 必须是对象`);
  }
}

function decodeReferenceFragment(reference: string, label: string): string {
  try {
    return decodeURIComponent(reference.slice(1));
  } catch {
    throw new Error(`[genapi] ${label} 的内部 $ref URI fragment 无效："${reference}"`);
  }
}

function resolveJsonPointer(
  document: OpenAPI3,
  fragment: string,
  reference: string,
  label: string,
): unknown {
  let current: unknown = document;
  for (const encodedToken of fragment.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encodedToken)) {
      throw new Error(`[genapi] ${label} 的内部 $ref JSON Pointer 转义无效："${reference}"`);
    }
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      throw new Error(`[genapi] ${label} 的内部 $ref 无法解析："${reference}"`);
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function resolveInternalReference(
  document: OpenAPI3,
  anchors: ReadonlyMap<string, unknown>,
  reference: string,
  label: string,
): unknown {
  if (reference === "#") return document;
  const fragment = decodeReferenceFragment(reference, label);
  if (fragment.startsWith("/")) {
    return resolveJsonPointer(document, fragment, reference, label);
  }
  const target = anchors.get(fragment);
  if (target === undefined) {
    throw new Error(`[genapi] ${label} 的内部 $ref anchor 无法解析："${reference}"`);
  }
  return target;
}

/** 拒绝外部引用，并确保内部 JSON Pointer/OpenAPI 3.1 anchor 均可解析。 */
function assertReferencesResolvable(
  document: OpenAPI3,
  label: string,
): ReadonlyMap<string, unknown> {
  const pending: Array<{ value: unknown; role: ReferenceWalkRole }> = [
    { value: document, role: "object" },
  ];
  const visited = new Set<object>();
  const references: string[] = [];
  const anchors = new Map<string, unknown>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    const current = next.value;
    if (typeof current !== "object" || current === null || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) pending.push({ value: item, role: "object" });
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (next.role !== "map" && key === "$ref") {
        if (typeof value !== "string") {
          throw new Error(`[genapi] ${label} 的 $ref 必须是字符串`);
        }
        references.push(value);
      }
      if (next.role !== "map" && (key === "$dynamicRef" || key === "$recursiveRef")) {
        throw new Error(
          `[genapi] ${label} 暂不支持 ${key}；当前 openapi-typescript 会将其静默降级为 unknown`,
        );
      }
      if (next.role !== "map" && key === "$anchor") {
        if (typeof value !== "string") {
          throw new Error(`[genapi] ${label} 的 OpenAPI 3.1 $anchor 必须是字符串`);
        }
        if (!JSON_SCHEMA_ANCHOR_PATTERN.test(value)) {
          throw new Error(
            `[genapi] ${label} 的 OpenAPI 3.1 $anchor 格式无效：${JSON.stringify(value)}`,
          );
        }
        if (anchors.has(value)) {
          throw new Error(`[genapi] ${label} 包含重复的 OpenAPI 3.1 $anchor："${value}"`);
        }
        anchors.set(value, current);
      }
      const childRole = referenceChildRole(next.role, key, value);
      if (childRole !== null) pending.push({ value, role: childRole });
    }
  }

  for (const reference of references) {
    if (!reference.startsWith("#")) {
      throw new Error(`[genapi] ${label} 暂不支持外部 $ref："${reference}"`);
    }
    resolveInternalReference(document, anchors, reference, label);
  }
  return anchors;
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

async function loadServiceModels(
  project: ProjectConfig,
  swaggerRoot: string,
  configDirectory: string,
  outDir: string,
  rootHooks: GenapiHooks | undefined,
  maxSwaggerBytes: number,
): Promise<ServiceModel[]> {
  const models: ServiceModel[] = [];
  const services = [...project.services].sort((left, right) =>
    lexicalCompare(left.name, right.name),
  );
  for (const service of services) {
    const swaggerFile = resolveSwaggerInputPath({
      configDirectory,
      swaggerRoot,
      projectId: project.name,
      service,
    });
    assertPathOutside(outDir, swaggerFile, `${project.name}/${service.name} Swagger 输入文件`);
    let swaggerStats: Awaited<ReturnType<typeof stat>>;
    try {
      swaggerStats = await stat(swaggerFile);
    } catch (cause) {
      if (fileSystemErrorCode(cause) === "ENOENT") {
        throw new Error(`[genapi] required Swagger 缺失：${swaggerFile}`, { cause });
      }
      throw new Error(`[genapi] 无法检查 Swagger：${swaggerFile}`, { cause });
    }
    if (!swaggerStats.isFile()) {
      throw new Error(`[genapi] Swagger 必须是普通文件或指向普通文件的 symlink：${swaggerFile}`);
    }
    if (swaggerStats.size > maxSwaggerBytes) {
      throw new Error(`[genapi] Swagger 超过 maxSwaggerBytes (${maxSwaggerBytes})：${swaggerFile}`);
    }

    let parsed: unknown;
    try {
      parsed = parseJsonInput(await readFile(swaggerFile, "utf8"));
    } catch (cause) {
      throw new Error(`[genapi] 无法解析 ${swaggerFile}`, { cause });
    }
    assertOpenApiDocument(parsed, `${project.name}/${service.name} 原始文档`);
    const originalDocument = freezeOpenApi(parsed);
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
    const normalizedDocument = freezeOpenApi(canonicalizeOpenApi(transformed));
    const anchors = assertReferencesResolvable(
      normalizedDocument,
      `${project.name}/${service.name}`,
    );
    hookContext.normalizedDocument = normalizedDocument;
    const endpointCount = countOperations(normalizedDocument, anchors);
    const components = normalizedDocument.components as
      { schemas?: Record<string, unknown> } | undefined;
    models.push({
      config: service,
      originalDocument,
      document: normalizedDocument,
      schemas: components?.schemas ?? {},
      serviceInfo: { name: service.name, endpointCount },
      hooks,
      hookContext,
      normalizedDocumentHash: canonicalOpenApiHash(normalizedDocument),
    });
  }
  return models;
}

function assertPathInside(root: string, target: string, label: string): void {
  if (isPathInside(root, target)) return;
  throw new Error(`[genapi] ${label} 越过配置根目录：${target}`);
}

function assertPathOutside(root: string, target: string, label: string): void {
  if (!isPathInside(root, target)) return;
  throw new Error(`[genapi] ${label} 位于生成输出目录内，生成会覆盖输入：${target}`);
}

async function assertConfiguredSourcesOutsideOutput(options: {
  config: XApiForgeConfig;
  configDirectory: string;
  swaggerRoot: string;
  outDir: string;
}): Promise<void> {
  const physicalOutDir = await resolvePhysicalPath(options.outDir);
  for (const project of options.config.projects) {
    for (const service of project.services) {
      const inputPath = resolveSwaggerInputPath({
        configDirectory: options.configDirectory,
        swaggerRoot: options.swaggerRoot,
        projectId: project.name,
        service,
      });
      assertPathOutside(
        options.outDir,
        inputPath,
        `${project.name}/${service.name} Swagger 输入文件`,
      );
      let physicalInput: string | undefined;
      try {
        physicalInput = await resolvePhysicalPath(inputPath);
      } catch {
        // 未选项目的来源可能暂时不可访问；选中项目稍后仍会严格 stat/read。
      }
      if (physicalInput !== undefined) {
        assertPathOutside(
          physicalOutDir,
          physicalInput,
          `${project.name}/${service.name} Swagger 输入文件物理路径`,
        );
      }
    }
  }
}

// ---------- 入口 ----------

/**
 * 生成一个项目（{outputDir}/{projectId}/ 目录）。
 *
 * 1. 对每个 service 跑 openapi-typescript 生成 types.ts
 * 2. 解析 PathItem → 输出唯一 operation 数量给 banner 用
 * 3. 写 src/index.ts（按 service 拆 openapi-fetch client + re-export）
 * 4. 写 src/api-types.ts（按 components.schemas 导 alias）
 */
async function buildProjectArtifacts(opts: GenerateOptions): Promise<ProjectArtifacts> {
  validateConfig(opts.xapiForgeConfig);
  const project = opts.xapiForgeConfig.projects.find((p) => p.name === opts.projectId);
  if (!project) {
    throw new Error(`project '${opts.projectId}' not in xapiForgeConfig.projects`);
  }

  assertFileSystemPath(opts.swaggerDir, "GenerateOptions.swaggerDir");
  assertFileSystemPath(opts.outputDir, "GenerateOptions.outputDir");
  if (opts.configDirectory !== undefined) {
    assertFileSystemPath(opts.configDirectory, "GenerateOptions.configDirectory");
  }
  const swaggerRoot = resolve(process.cwd(), opts.swaggerDir);
  const swaggerProjectDir = resolve(swaggerRoot, project.name);
  assertPathInside(swaggerRoot, swaggerProjectDir, `project ${project.name} Swagger 路径`);

  const outputRoot = resolve(process.cwd(), opts.outputDir);
  const outDir = resolve(outputRoot, project.name);
  assertPathInside(outputRoot, outDir, `project ${project.name} 输出路径`);
  const configDirectory = resolve(process.cwd(), opts.configDirectory ?? ".");
  await assertConfiguredSourcesOutsideOutput({
    config: opts.xapiForgeConfig,
    configDirectory,
    swaggerRoot,
    outDir,
  });
  const rootHooks = opts.hooks !== undefined ? opts.hooks : opts.xapiForgeConfig.hooks;

  // 所有 service 和文件内容先在内存中准备完成；失败时不创建正式输出目录。
  const serviceModels = await loadServiceModels(
    project,
    swaggerRoot,
    configDirectory,
    outDir,
    rootHooks,
    opts.xapiForgeConfig.maxSwaggerBytes ?? DEFAULT_MAX_SWAGGER_BYTES,
  );
  const files = new Map<string, string>();

  // 1. openapi-typescript → types/<svc>.ts。所有步骤复用同一份 hook 后文档。
  for (const model of serviceModels) {
    let typesContent = await runOpenapiTypescript(model.document);
    if (model.hooks?.transformTypes) {
      const transformedTypes = await model.hooks.transformTypes(typesContent, model.hookContext);
      if (typeof transformedTypes !== "string") {
        throw new Error(
          `[genapi] transformTypes(${project.name}/${model.config.name}) 必须返回字符串`,
        );
      }
      typesContent = transformedTypes;
    }
    files.set(`types/${model.config.name}.ts`, normalizeLineEndings(typesContent));
  }

  const serviceNames = serviceModels.map((model) => model.config.name);
  const serviceInfos = serviceModels.map((model) => model.serviceInfo);

  // 3. 写 index.ts —— openapi-fetch 形式的业务对象
  const indexContent = renderIndex(project.name, project.displayName, serviceInfos, serviceNames);
  files.set("index.ts", normalizeLineEndings(indexContent));

  // 4. 写 api-types.ts —— components.schemas 导 alias
  const emitTypes = opts.emitApiTypes !== false; // 默认 true
  if (emitTypes) {
    const apiTypesContent = renderApiTypes({
      projectId: project.name,
      projectDisplay: project.displayName,
      services: serviceModels.map((model) => ({
        name: model.config.name,
        schemas: model.schemas,
      })),
      typeExports: project.typeExports,
    });
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
  if (!Array.isArray(options)) throw configError("generateMany options 必须是数组");
  for (const [index, option] of options.entries()) {
    validateGenerateOptions(option, `generateMany options[${index}]`);
  }
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
  let results: GenerateResult[];
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
    results = evaluated.map(({ project, changedFiles }) => ({
      ...project.result,
      changed: changedFiles.length > 0,
      changedFiles,
    }));
  } catch (cause) {
    try {
      await releaseLock();
    } catch (releaseCause) {
      throw new AggregateError([cause, releaseCause], "[genapi] 生成失败且生成锁清理失败");
    }
    throw cause;
  }
  await releaseLock();
  return results;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const [result] = await generateMany([opts]);
  return result!;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
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
    if (entry.isDirectory()) {
      const nested = await listRelativeFiles(root, relativePath);
      if (nested.length === 0) files.push(`${relativePath}/`);
      else files.push(...nested);
    } else {
      // symlink、FIFO 等也属于输出漂移；不能让 --check 静默忽略。
      files.push(relativePath);
    }
  }
  return files.sort();
}

/** 确保目标及其每一级父路径都是普通目录/文件，不跟随中间 symlink。 */
async function isRegularOutputFile(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (cause) {
      if (fileSystemErrorCode(cause) === "ENOENT") return false;
      throw cause;
    }
    if (index === segments.length - 1) return stats.isFile();
    if (!stats.isDirectory()) return false;
  }
  return false;
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
    if (expected === undefined || !(await isRegularOutputFile(outputDir, relativePath))) {
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

async function cleanupGenerationLock(
  handle: Awaited<ReturnType<typeof open>>,
  lockPath: string,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await handle.close();
  } catch (cause) {
    errors.push(cause);
  }
  try {
    await unlink(lockPath);
  } catch (cause) {
    if (fileSystemErrorCode(cause) !== "ENOENT") errors.push(cause);
  }
  if (errors.length > 0) throw new AggregateError(errors, `无法清理生成锁：${lockPath}`);
}

async function acquireGenerationLock(outputRoot: string): Promise<() => Promise<void>> {
  await mkdir(outputRoot, { recursive: true });
  const lockPath = join(outputRoot, ".xapiforge-generation.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          `${JSON.stringify({ formatVersion: 1, pid: process.pid })}\n`,
          "utf8",
        );
      } catch (cause) {
        try {
          await cleanupGenerationLock(handle, lockPath);
        } catch (cleanupCause) {
          throw new Error(`[genapi] 无法初始化且无法清理生成锁：${lockPath}`, {
            cause: new AggregateError([cause, cleanupCause]),
          });
        }
        throw cause;
      }
      return () => cleanupGenerationLock(handle, lockPath);
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

function transactionCommitMarkerPath(statePath: string): string {
  return `${statePath}.committed`;
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
  await unlink(transactionCommitMarkerPath(statePath)).catch((cause: unknown) => {
    if (fileSystemErrorCode(cause) !== "ENOENT") throw cause;
  });
}

async function recoverInterruptedTransactions(outputRoot: string): Promise<void> {
  if (!existsSync(outputRoot)) return;
  const entries = await readdir(outputRoot);
  const partialStateFiles = entries.filter((name) =>
    /^\.xapiforge-transaction-[A-Za-z0-9-]+\.json(?:\.committed)?\.partial-[A-Za-z0-9-]+$/.test(
      name,
    ),
  );
  await Promise.all(partialStateFiles.map((name) => rm(join(outputRoot, name), { force: true })));
  const stateFiles = entries
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
    const recoveryState: TransactionState = existsSync(transactionCommitMarkerPath(statePath))
      ? { ...state, phase: "committed" }
      : state;
    await recoverTransactionState(outputRoot, recoveryState, statePath);
  }
  const remainingEntries = await readdir(outputRoot);
  const orphanMarkers = remainingEntries.filter((name) =>
    /^\.xapiforge-transaction-[A-Za-z0-9-]+\.json\.committed$/.test(name),
  );
  await Promise.all(orphanMarkers.map((name) => rm(join(outputRoot, name), { force: true })));
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
  const partialPath = `${statePath}.partial-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(partialPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(partialPath, statePath);
  } finally {
    await rm(partialPath, { force: true });
  }
  return statePath;
}

async function writeTransactionCommitMarker(statePath: string): Promise<void> {
  const markerPath = transactionCommitMarkerPath(statePath);
  const partialPath = `${markerPath}.partial-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(partialPath, `${JSON.stringify({ formatVersion: 1, committed: true })}\n`);
    await rename(partialPath, markerPath);
  } finally {
    await rm(partialPath, { force: true });
  }
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
    await writeTransactionCommitMarker(statePath);
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
  // Redocly bundler 会改写输入，并会误解 literal JSON 中的引用样式 key。
  // 因此只给它从权威 normalized document 派生的一次性安全视图；不重新读取、
  // 规范化或执行 hook，endpoint/alias/manifest 仍只读取权威冻结对象。
  const ast = await openapiTS(createOpenApiTypescriptInput(document));
  return astToString(ast);
}

/** 解析 PathItem 的内部引用；本地字段覆盖被引用字段。 */
function resolvePathItem(
  document: OpenAPI3,
  anchors: ReadonlyMap<string, unknown>,
  pathStr: string,
  value: unknown,
  referenceChain = new Set<string>(),
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`[genapi] path item ${pathStr} 必须是对象`);
  if (value.$ref === undefined) return value;
  if (typeof value.$ref !== "string") {
    throw new Error(`[genapi] path item ${pathStr} 的 $ref 必须是字符串`);
  }
  const reference = value.$ref;
  if (referenceChain.has(reference)) {
    throw new Error(`[genapi] path item ${pathStr} 包含循环 $ref：${reference}`);
  }
  referenceChain.add(reference);
  try {
    const referenced = resolveInternalReference(
      document,
      anchors,
      reference,
      `path item ${pathStr}`,
    );
    const inherited = resolvePathItem(document, anchors, pathStr, referenced, referenceChain);
    return Object.assign(Object.create(null) as Record<string, unknown>, inherited, value);
  } finally {
    referenceChain.delete(reference);
  }
}

/** 从 OpenAPI paths 统计唯一 operation；多 tag 不得重复计数。 */
function countOperations(document: OpenAPI3, anchors: ReadonlyMap<string, unknown>): number {
  let endpointCount = 0;
  for (const [pathStr, methods] of Object.entries(document.paths ?? {})) {
    if (pathStr.startsWith("x-")) continue;
    if (!pathStr.startsWith("/")) {
      throw new Error(`[genapi] paths key 必须以 / 开头或是 x- 扩展：${JSON.stringify(pathStr)}`);
    }
    const pathItem = resolvePathItem(document, anchors, pathStr, methods);
    for (const [method, rawOp] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (!HTTP_METHODS.has(normalizedMethod)) continue;
      if (method !== normalizedMethod) {
        throw new Error(
          `[genapi] operation method 必须使用小写：${JSON.stringify(method)} ${pathStr}`,
        );
      }
      if (!isRecord(rawOp)) {
        throw new Error(`[genapi] operation ${method.toUpperCase()} ${pathStr} 必须是对象`);
      }
      const op = rawOp as { tags?: unknown };
      if (
        op.tags !== undefined &&
        (!Array.isArray(op.tags) || op.tags.some((tag) => typeof tag !== "string"))
      ) {
        throw new Error(
          `[genapi] operation ${method.toUpperCase()} ${pathStr} 的 tags 必须是字符串数组`,
        );
      }
      endpointCount += 1;
    }
  }
  return endpointCount;
}

// ---------- 模板渲染 ----------

function renderIndex(
  projectId: string,
  projectDisplay: string,
  services: ServiceInfo[],
  serviceNames: string[],
): string {
  const totalEndpoints = services.reduce((n, s) => n + s.endpointCount, 0);
  const firstServiceKey = safeRuntimeKey(serviceNames[0] ?? "service");
  const projectTypeName = pascalCaseConfigId(projectId);
  const projectDisplayComment = safeCommentText(projectDisplay);

  const parts: string[] = [];

  parts.push("/**");
  parts.push(` * ${projectDisplayComment} API 客户端（生成产物，自动生成勿手改）`);
  parts.push(" *");
  parts.push(
    " * 引擎：openapi-typescript（路径/schema 类型）+ @xapiforge/core createNet（data-or-throw/鉴权/重试）",
  );
  parts.push(" *");
  parts.push(` * 项目：${projectDisplayComment} (${projectId})`);
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
    ` *   import { create${projectTypeName}Client } from "./api/gen/${projectId}/index.js";`,
  );
  parts.push(` *   const api = create${projectTypeName}Client({`);
  parts.push(' *     baseURL: "https://api.example.invalid",');
  parts.push(" *     authService,           // AuthService 实例");
  parts.push(" *     middleware: [abpUnwrapMw],  // 业务侧 envelope 解包");
  parts.push(" *     maxRetries: 3,         // 429 场景配 3");
  parts.push(" *   });");
  parts.push(` *   const service = api.${firstServiceKey};`);
  parts.push(" *   // service.GET/POST 的 path、参数和 body 均由该 service OpenAPI 约束。");
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
    parts.push(
      `import type { paths as ${pascalCaseConfigId(svc)}Paths } from "./types/${svc}.js";`,
    );
  }
  parts.push("");

  // 暴露 service 自己的 paths 类型（业务侧偶尔需要按 path 字面量取 schema）
  for (const svc of serviceNames) {
    parts.push(`/** ${svc} service paths 类型（按 HTTP path 字面量索引） */`);
    parts.push(`export type ${pascalCaseConfigId(svc)}Path = ${pascalCaseConfigId(svc)}Paths;`);
  }
  parts.push("");

  // 业务对象：每个 service 一个 createNet client 字段
  parts.push("/**");
  parts.push(` * ${projectDisplayComment} 业务对象`);
  parts.push(" * - 顶层 key: service 英文短码（与 xapiforge.config.ts 服务名对应）");
  parts.push(" * - client: createNet 返回的强类型 client（GET/POST/PUT/DELETE/PATCH 强类型）");
  parts.push(" * - 内核自动注入：auth/retry + validateStatus；最终失败统一抛 ApiError");
  parts.push(" * - 业务侧 middleware（envelope 解包）通过 defaults 注入，service 可显式整体替换");
  parts.push(" *");
  parts.push(" * 调用形式：api.<service>.GET/POST；method/path/body 均由对应 OpenAPI 强类型约束。");
  parts.push(" */");
  parts.push(
    `export type Api${projectTypeName}ServiceName = ${serviceNames.map((name) => JSON.stringify(name)).join(" | ")};`,
  );
  parts.push("");
  parts.push("/** service 级允许覆盖的 Core 配置；middleware 数组为替换语义，不会自动拼接。 */");
  parts.push(`export type Api${projectTypeName}ServiceOverrides = Partial<`);
  parts.push(`  Pick<`);
  parts.push(`    NetConfig,`);
  parts.push(
    `    | "baseURL" | "authService" | "middleware" | "fetch" | "defaultTimeoutMs" | "maxRetries" | "retryDelayMs" | "logger"`,
  );
  parts.push(`  >`);
  parts.push(`>;`);
  parts.push("");
  parts.push(`export interface Api${projectTypeName}LayeredClientConfig {`);
  parts.push(`  /** project 默认配置；validateStatus 与 resolveErrorMessage 保持 project 级。 */`);
  parts.push(`  defaults: NetConfig;`);
  parts.push(`  /** service override 仅覆盖值不为 undefined 的字段。 */`);
  parts.push(`  services?: Partial<`);
  parts.push(`    Record<Api${projectTypeName}ServiceName, Api${projectTypeName}ServiceOverrides>`);
  parts.push(`  >;`);
  parts.push("}");
  parts.push("");
  parts.push(`/** 支持直接传 NetConfig，或按 defaults/services 分层配置。 */`);
  parts.push(
    `export type Api${projectTypeName}ClientConfig = NetConfig | Api${projectTypeName}LayeredClientConfig;`,
  );
  parts.push("");
  parts.push(`export type Api${projectTypeName}ClientConfigWithCustomStatus =`);
  parts.push(`  | (NetConfig & { validateStatus: ValidateStatus })`);
  parts.push(`  | (Omit<Api${projectTypeName}LayeredClientConfig, "defaults"> & {`);
  parts.push(`      defaults: NetConfig & { validateStatus: ValidateStatus };`);
  parts.push(`    });`);
  parts.push("");
  parts.push(`function merge${projectTypeName}ServiceConfig(`);
  parts.push(`  defaults: NetConfig,`);
  parts.push(`  override: Api${projectTypeName}ServiceOverrides | undefined,`);
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

  parts.push(`export function create${projectTypeName}Client(`);
  parts.push(`  config: Api${projectTypeName}ClientConfigWithCustomStatus,`);
  parts.push(`): Api${projectTypeName}<true>;`);
  parts.push(`export function create${projectTypeName}Client(`);
  parts.push(`  config: Api${projectTypeName}ClientConfig,`);
  parts.push(`): Api${projectTypeName}<false>;`);
  parts.push(`export function create${projectTypeName}Client(`);
  parts.push(`  config: Api${projectTypeName}ClientConfig,`);
  parts.push(`): Api${projectTypeName}<boolean> {`);
  parts.push(`  const layered = "defaults" in config;`);
  parts.push(`  const defaults = layered ? config.defaults : config;`);
  parts.push(`  const serviceOverrides = layered ? config.services : undefined;`);
  parts.push(`  return {`);

  for (const s of services) {
    parts.push(`    /** ${s.name}（${s.endpointCount} endpoints） */`);
    parts.push(
      `    ${safeRuntimeKey(s.name)}: createNet<${pascalCaseConfigId(s.name)}Paths>(merge${projectTypeName}ServiceConfig(defaults, serviceOverrides?.[${JSON.stringify(s.name)}])),`,
    );
  }
  parts.push("  };");
  parts.push("}");
  parts.push("");

  // Api{Proj} 接口导出 —— 默认 data 仅含 2xx；自定义 validateStatus 时增加 error response 类型
  parts.push(`export interface Api${projectTypeName}<HasCustomStatus extends boolean = false> {`);
  for (const s of services) {
    parts.push(`  /** ${s.name} */`);
    parts.push(
      `  ${safeRuntimeKey(s.name)}: NetClient<${pascalCaseConfigId(s.name)}Paths, HasCustomStatus>;`,
    );
  }
  parts.push("}");
  parts.push("");

  return parts.join("\n");
}

// ---------- swagger-fetch re-export ----------
//
// 远程 source.url 的下载能力随 genapi 一起发布；source.file 由生成器直接读取。
export { downloadJson, fetchSwaggerJson, formatBytes } from "./swagger-fetch.js";
export type { FetchOptions, FetchResult } from "./swagger-fetch.js";
