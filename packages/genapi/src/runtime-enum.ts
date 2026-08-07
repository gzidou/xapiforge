import type { GenapiHookContext, GenapiHooks, TransformSwaggerHook } from "./index.js";

const RUNTIME_ENUM_VALUES = "x-xapiforge-runtime-enum-values";
const TYPESCRIPT_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
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
]);

type EnumValue = string | number;
type UnknownRecord = Record<string, unknown>;

export interface RuntimeEnumMetadata {
  /** Flags 字段在 OpenAPI 类型中生成 number，runtime map 只列出声明的单项。 */
  isFlags?: boolean;
}

export interface RuntimeEnumHooksOptions {
  /** 以 full schema name 为 key 的显式元数据。 */
  metadata?: Readonly<Record<string, RuntimeEnumMetadata>>;
  /** 可选的前置规范化 hook；用于 legacy Swagger 转成标准 enum。 */
  preprocessSwagger?: TransformSwaggerHook;
}

interface RuntimeEnumDefinition {
  schemaName: string;
  exportName: string;
  values: EnumValue[];
  names: string[];
  labels: string[];
  isFlags: boolean;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumError(ctx: GenapiHookContext, message: string): Error {
  return new Error(`[genapi] runtime enum ${ctx.projectId}/${ctx.serviceName}: ${message}`);
}

function readSchemas(document: unknown, ctx: GenapiHookContext): UnknownRecord {
  if (!isRecord(document)) throw enumError(ctx, "OpenAPI 文档必须是对象");
  const components = document.components;
  if (components === undefined) return {};
  if (!isRecord(components)) throw enumError(ctx, "components 必须是对象");
  const schemas = components.schemas;
  if (schemas === undefined) return {};
  if (!isRecord(schemas)) throw enumError(ctx, "components.schemas 必须是对象");
  return schemas;
}

function runtimeExportName(schemaName: string): string {
  const name = schemaName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[0-9]/.test(name) || TYPESCRIPT_RESERVED_WORDS.has(name) ? `_${name}` : name;
}

function validateMetadata(
  schemas: UnknownRecord,
  metadata: Readonly<Record<string, RuntimeEnumMetadata>>,
  ctx: GenapiHookContext,
): void {
  for (const [schemaName, entry] of Object.entries(metadata)) {
    if (!isRecord(entry))
      throw enumError(ctx, `metadata[${JSON.stringify(schemaName)}] 必须是对象`);
    if (entry.isFlags !== undefined && typeof entry.isFlags !== "boolean") {
      throw enumError(ctx, `metadata[${JSON.stringify(schemaName)}].isFlags 必须是 boolean`);
    }
    if (!(schemaName in schemas)) {
      throw enumError(ctx, `metadata 引用了不存在的 schema ${JSON.stringify(schemaName)}`);
    }
  }
}

function readStringArray(
  schemaName: string,
  field: string,
  value: unknown,
  expectedLength: number,
  ctx: GenapiHookContext,
): string[] {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw enumError(
      ctx,
      `${JSON.stringify(schemaName)}.${field} 必须是长度为 ${expectedLength} 的字符串数组`,
    );
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw enumError(
        ctx,
        `${JSON.stringify(schemaName)}.${field} 必须是长度为 ${expectedLength} 的字符串数组`,
      );
    }
    strings.push(item);
  }
  return strings;
}

function readDefinition(
  schemaName: string,
  schema: UnknownRecord,
  metadata: RuntimeEnumMetadata | undefined,
  ctx: GenapiHookContext,
): RuntimeEnumDefinition | undefined {
  const rawValues = Array.isArray(schema.enum)
    ? schema.enum
    : Array.isArray(schema[RUNTIME_ENUM_VALUES])
      ? schema[RUNTIME_ENUM_VALUES]
      : undefined;
  const hasRuntimeNames = schema["x-enum-varnames"] !== undefined;
  if (!rawValues || !hasRuntimeNames) {
    if (metadata?.isFlags) {
      throw enumError(
        ctx,
        `Flags schema ${JSON.stringify(schemaName)} 必须包含 enum 和 x-enum-varnames`,
      );
    }
    return undefined;
  }
  if (rawValues.length === 0) {
    throw enumError(ctx, `${JSON.stringify(schemaName)}.enum 不能为空`);
  }

  const type = schema.type;
  const values: EnumValue[] = [];
  for (const value of rawValues) {
    const valid =
      (type === "string" && typeof value === "string") ||
      ((type === "integer" || type === "number") &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        (type !== "integer" || Number.isInteger(value)));
    if (!valid) {
      throw enumError(
        ctx,
        `${JSON.stringify(schemaName)} 的 enum 值必须与 type=${JSON.stringify(type)} 一致`,
      );
    }
    values.push(value);
  }
  if (
    metadata?.isFlags &&
    (type !== "integer" || values.some((value) => typeof value !== "number"))
  ) {
    throw enumError(ctx, `Flags schema ${JSON.stringify(schemaName)} 必须是 integer 数字枚举`);
  }

  const names = readStringArray(
    schemaName,
    "x-enum-varnames",
    schema["x-enum-varnames"],
    values.length,
    ctx,
  );
  const labels =
    schema["x-enum-labels"] === undefined
      ? [...names]
      : readStringArray(schemaName, "x-enum-labels", schema["x-enum-labels"], values.length, ctx);
  const seenNames = new Set<string>();
  const seenValues = new Set<string>();
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (!TYPESCRIPT_IDENTIFIER.test(name) || TYPESCRIPT_RESERVED_WORDS.has(name)) {
      throw enumError(
        ctx,
        `${JSON.stringify(schemaName)} 的枚举名 ${JSON.stringify(name)} 不是合法 TypeScript 标识符`,
      );
    }
    if (seenNames.has(name)) {
      throw enumError(ctx, `${JSON.stringify(schemaName)} 的枚举名 ${JSON.stringify(name)} 重复`);
    }
    seenNames.add(name);
    const value = values[index]!;
    const valueKey = `${typeof value}:${JSON.stringify(value)}`;
    if (seenValues.has(valueKey)) {
      throw enumError(
        ctx,
        `${JSON.stringify(schemaName)} 的 enum 值 ${JSON.stringify(value)} 重复`,
      );
    }
    seenValues.add(valueKey);
  }

  const exportName = runtimeExportName(schemaName);
  if (!exportName)
    throw enumError(ctx, `${JSON.stringify(schemaName)} 无法生成 runtime enum 导出名`);
  return {
    schemaName,
    exportName,
    values,
    names,
    labels,
    isFlags: metadata?.isFlags === true,
  };
}

function collectDefinitions(
  document: unknown,
  metadata: Readonly<Record<string, RuntimeEnumMetadata>>,
  ctx: GenapiHookContext,
): RuntimeEnumDefinition[] {
  const schemas = readSchemas(document, ctx);
  validateMetadata(schemas, metadata, ctx);
  const definitions: RuntimeEnumDefinition[] = [];
  const exports = new Map<string, string>();
  for (const [schemaName, rawSchema] of Object.entries(schemas)) {
    if (!isRecord(rawSchema)) continue;
    const definition = readDefinition(schemaName, rawSchema, metadata[schemaName], ctx);
    if (!definition) continue;
    const previous = exports.get(definition.exportName);
    if (previous) {
      throw enumError(
        ctx,
        `schema ${JSON.stringify(previous)} 与 ${JSON.stringify(schemaName)} 生成相同 runtime 导出 ${JSON.stringify(definition.exportName)}`,
      );
    }
    exports.set(definition.exportName, schemaName);
    definitions.push(definition);
  }
  return definitions;
}

function renderDefinition(definition: RuntimeEnumDefinition): string {
  const { exportName, values, names, labels, isFlags } = definition;
  const lines = [
    `/** ${definition.schemaName}${isFlags ? "（Flags；API 字段保持 number，组合值请使用位运算）" : ""} */`,
    `export const ${exportName} = {`,
  ];
  for (let index = 0; index < values.length; index += 1) {
    lines.push(`  ${names[index]}: ${JSON.stringify(values[index])},`);
  }
  lines.push("} as const;");
  lines.push(
    `export type ${exportName}Value = (typeof ${exportName})[keyof typeof ${exportName}];`,
  );
  lines.push(`export const ${exportName}Labels: Readonly<Record<${exportName}Value, string>> = {`);
  for (let index = 0; index < values.length; index += 1) {
    lines.push(`  [${exportName}.${names[index]}]: ${JSON.stringify(labels[index])},`);
  }
  lines.push("} as const;");
  return lines.join("\n");
}

/**
 * 创建显式启用的 runtime enum hooks。
 *
 * 默认 OpenAPI enum 仍由 openapi-typescript 生成 literal union；只有配置此 hook 时，
 * 才会从标准 `enum` + `x-enum-varnames`/`x-enum-labels` 追加 `as const` runtime map。
 */
export function createRuntimeEnumHooks(options: RuntimeEnumHooksOptions = {}): GenapiHooks {
  const metadata = options.metadata ?? {};
  return {
    async transformSwagger(swagger, ctx) {
      const preprocessed = options.preprocessSwagger
        ? await options.preprocessSwagger(swagger, ctx)
        : swagger;
      if (preprocessed === undefined || preprocessed === null) {
        throw enumError(ctx, "preprocessSwagger 返回空值");
      }
      const document = structuredClone(preprocessed);
      const schemas = readSchemas(document, ctx);
      validateMetadata(schemas, metadata, ctx);
      for (const [schemaName, rawSchema] of Object.entries(schemas)) {
        if (!isRecord(rawSchema)) continue;
        const definition = readDefinition(schemaName, rawSchema, metadata[schemaName], ctx);
        if (!definition?.isFlags) continue;
        rawSchema[RUNTIME_ENUM_VALUES] = [...definition.values];
        delete rawSchema.enum;
      }
      return document;
    },
    transformTypes(typesContent, ctx) {
      const definitions = collectDefinitions(ctx.normalizedDocument, metadata, ctx);
      if (definitions.length === 0) return Promise.resolve(typesContent);
      const prefix = typesContent.endsWith("\n") ? typesContent : `${typesContent}\n`;
      return Promise.resolve(`${prefix}\n${definitions.map(renderDefinition).join("\n\n")}\n`);
    },
  };
}
