import { lexicalCompare, TYPESCRIPT_RESERVED_WORDS } from "./naming.js";
import type {
  RuntimeEnumContext,
  RuntimeEnumDefinition,
  RuntimeEnumExtensionDefinition,
  RuntimeEnumExtensionValue,
  RuntimeEnumExportDescriptor,
  RuntimeEnumMetadata,
  RuntimeEnumValue,
} from "./runtime-enum-types.js";

const RUNTIME_ENUM_VALUES = "x-xapiforge-runtime-enum-values";
const TYPESCRIPT_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const METADATA_FIELDS = new Set([
  "appendValues",
  "extensions",
  "isFlags",
  "overrideLabels",
  "overrideVarnames",
  "serializeAs",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enumError(ctx: RuntimeEnumContext, message: string): Error {
  return new Error(`[genapi] runtime enum ${ctx.projectId}/${ctx.serviceName}: ${message}`);
}

function readSchemas(document: unknown, ctx: RuntimeEnumContext): UnknownRecord {
  if (!isRecord(document)) throw enumError(ctx, "OpenAPI 文档必须是对象");
  const components = document.components;
  if (components === undefined) return {};
  if (!isRecord(components)) throw enumError(ctx, "components 必须是对象");
  const schemas = components.schemas;
  if (schemas === undefined) return {};
  if (!isRecord(schemas)) throw enumError(ctx, "components.schemas 必须是对象");
  return schemas;
}

function runtimeExportName(value: string): string {
  const name = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[0-9]/.test(name) || TYPESCRIPT_RESERVED_WORDS.has(name) ? `_${name}` : name;
}

function enumValueKey(value: RuntimeEnumValue): string {
  return `${typeof value}:${JSON.stringify(value)}`;
}

function configLookupKey(value: RuntimeEnumValue): string {
  return String(value);
}

function assertStringMap(
  value: unknown,
  path: string,
  ctx: RuntimeEnumContext,
): asserts value is Readonly<Record<string, string>> {
  if (!isRecord(value)) throw enumError(ctx, `${path} 必须是 value → string 对象`);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw enumError(ctx, `${path}[${JSON.stringify(key)}] 必须是 string`);
    }
  }
}

function validateMetadataRegistry(
  schemas: UnknownRecord,
  metadata: Readonly<Record<string, RuntimeEnumMetadata>>,
  ctx: RuntimeEnumContext,
): void {
  if (!isRecord(metadata)) throw enumError(ctx, "metadata 必须是对象");
  for (const [schemaName, entry] of Object.entries(metadata)) {
    const path = `metadata[${JSON.stringify(schemaName)}]`;
    if (!isRecord(entry)) throw enumError(ctx, `${path} 必须是对象`);
    for (const key of Object.keys(entry)) {
      if (!METADATA_FIELDS.has(key)) throw enumError(ctx, `${path} 包含未知字段 ${key}`);
    }
    if (!Object.prototype.hasOwnProperty.call(schemas, schemaName)) {
      throw enumError(ctx, `metadata 引用了不存在的 schema ${JSON.stringify(schemaName)}`);
    }
    if (entry.isFlags !== undefined && typeof entry.isFlags !== "boolean") {
      throw enumError(ctx, `${path}.isFlags 必须是 boolean`);
    }
    if (
      entry.serializeAs !== undefined &&
      entry.serializeAs !== "number" &&
      entry.serializeAs !== "string"
    ) {
      throw enumError(ctx, `${path}.serializeAs 只能是 "number" 或 "string"`);
    }
    if (entry.overrideLabels !== undefined) {
      assertStringMap(entry.overrideLabels, `${path}.overrideLabels`, ctx);
    }
    if (entry.overrideVarnames !== undefined) {
      assertStringMap(entry.overrideVarnames, `${path}.overrideVarnames`, ctx);
    }
    if (entry.appendValues !== undefined && !Array.isArray(entry.appendValues)) {
      throw enumError(ctx, `${path}.appendValues 必须是数组`);
    }
    if (entry.extensions !== undefined && !isRecord(entry.extensions)) {
      throw enumError(ctx, `${path}.extensions 必须是对象`);
    }
  }
}

function readStringArray(
  schemaName: string,
  field: string,
  value: unknown,
  expectedLength: number,
  ctx: RuntimeEnumContext,
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

function readBaseDefinition(
  schemaName: string,
  schema: UnknownRecord,
  metadata: RuntimeEnumMetadata | undefined,
  ctx: RuntimeEnumContext,
): Omit<RuntimeEnumDefinition, "extensions" | "serializeAs"> | undefined {
  const rawValues = Array.isArray(schema.enum)
    ? schema.enum
    : Array.isArray(schema[RUNTIME_ENUM_VALUES])
      ? schema[RUNTIME_ENUM_VALUES]
      : undefined;
  const hasRuntimeNames = schema["x-enum-varnames"] !== undefined;
  if (!rawValues || !hasRuntimeNames) {
    if (metadata !== undefined) {
      throw enumError(
        ctx,
        `metadata 目标 ${JSON.stringify(schemaName)} 必须包含 enum 和 x-enum-varnames`,
      );
    }
    return undefined;
  }
  if (rawValues.length === 0) throw enumError(ctx, `${JSON.stringify(schemaName)}.enum 不能为空`);

  const type = schema.type;
  const values: RuntimeEnumValue[] = [];
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
  if (metadata?.isFlags && type !== "integer") {
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
  const exportName = runtimeExportName(schemaName);
  if (!exportName) {
    throw enumError(ctx, `${JSON.stringify(schemaName)} 无法生成 runtime enum 导出名`);
  }
  return {
    schemaName,
    exportName,
    values,
    names,
    labels,
    isFlags: metadata?.isFlags === true,
  };
}

function assertMapKeysKnown(
  map: Readonly<Record<string, unknown>>,
  values: readonly RuntimeEnumValue[],
  path: string,
  ctx: RuntimeEnumContext,
): void {
  const known = new Set(values.map(configLookupKey));
  for (const key of Object.keys(map)) {
    if (!known.has(key))
      throw enumError(ctx, `${path} 引用了不存在的 enum value ${JSON.stringify(key)}`);
  }
}

function applyMetadata(
  definition: Omit<RuntimeEnumDefinition, "extensions" | "serializeAs">,
  type: unknown,
  metadata: RuntimeEnumMetadata | undefined,
  ctx: RuntimeEnumContext,
): void {
  if (!metadata) return;
  const path = `metadata[${JSON.stringify(definition.schemaName)}]`;
  if (metadata.appendValues) {
    for (const [index, append] of metadata.appendValues.entries()) {
      const appendPath = `${path}.appendValues[${index}]`;
      if (!isRecord(append)) throw enumError(ctx, `${appendPath} 必须是对象`);
      for (const key of Object.keys(append)) {
        if (key !== "label" && key !== "name" && key !== "value") {
          throw enumError(ctx, `${appendPath} 包含未知字段 ${key}`);
        }
      }
      if (typeof append.name !== "string" || typeof append.label !== "string") {
        throw enumError(ctx, `${appendPath}.name/label 必须是字符串`);
      }
      const validValue =
        (type === "string" && typeof append.value === "string") ||
        ((type === "integer" || type === "number") &&
          typeof append.value === "number" &&
          Number.isFinite(append.value) &&
          (type !== "integer" || Number.isInteger(append.value)));
      if (!validValue) {
        throw enumError(ctx, `${appendPath}.value 必须与 schema type=${JSON.stringify(type)} 一致`);
      }
      if (definition.values.some((value) => enumValueKey(value) === enumValueKey(append.value))) {
        throw enumError(
          ctx,
          `${appendPath}.value 与已有 enum value ${JSON.stringify(append.value)} 冲突`,
        );
      }
      definition.values.push(append.value);
      definition.names.push(append.name);
      definition.labels.push(append.label);
    }
  }

  if (metadata.overrideLabels) {
    assertMapKeysKnown(metadata.overrideLabels, definition.values, `${path}.overrideLabels`, ctx);
    for (let index = 0; index < definition.values.length; index += 1) {
      const key = configLookupKey(definition.values[index]!);
      if (Object.prototype.hasOwnProperty.call(metadata.overrideLabels, key)) {
        definition.labels[index] = metadata.overrideLabels[key]!;
      }
    }
  }
  if (metadata.overrideVarnames) {
    assertMapKeysKnown(
      metadata.overrideVarnames,
      definition.values,
      `${path}.overrideVarnames`,
      ctx,
    );
    for (let index = 0; index < definition.values.length; index += 1) {
      const key = configLookupKey(definition.values[index]!);
      if (Object.prototype.hasOwnProperty.call(metadata.overrideVarnames, key)) {
        definition.names[index] = metadata.overrideVarnames[key]!;
      }
    }
  }
}

function validateDefinition(definition: RuntimeEnumDefinition, ctx: RuntimeEnumContext): void {
  const seenNames = new Set<string>();
  const seenValues = new Set<string>();
  for (let index = 0; index < definition.names.length; index += 1) {
    const name = definition.names[index]!;
    if (!TYPESCRIPT_IDENTIFIER.test(name) || TYPESCRIPT_RESERVED_WORDS.has(name)) {
      throw enumError(
        ctx,
        `${JSON.stringify(definition.schemaName)} 的枚举名 ${JSON.stringify(name)} 不是合法 TypeScript 标识符`,
      );
    }
    if (seenNames.has(name)) {
      throw enumError(
        ctx,
        `${JSON.stringify(definition.schemaName)} 的枚举名 ${JSON.stringify(name)} 重复`,
      );
    }
    seenNames.add(name);
    const value = definition.values[index]!;
    const valueKey = enumValueKey(value);
    if (seenValues.has(valueKey)) {
      throw enumError(
        ctx,
        `${JSON.stringify(definition.schemaName)} 的 enum 值 ${JSON.stringify(value)} 重复`,
      );
    }
    seenValues.add(valueKey);
  }
}

function canonicalizeExtensionValue(
  value: unknown,
  path: string,
  ctx: RuntimeEnumContext,
  ancestors = new WeakSet<object>(),
): RuntimeEnumExtensionValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw enumError(ctx, `${path} 必须是有限 JSON number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw enumError(ctx, `${path} 不能包含循环引用`);
    ancestors.add(value);
    try {
      return value.map((item, index) =>
        canonicalizeExtensionValue(item, `${path}[${index}]`, ctx, ancestors),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value)) throw enumError(ctx, `${path} 必须是 JSON 值`);
  if (ancestors.has(value)) throw enumError(ctx, `${path} 不能包含循环引用`);
  ancestors.add(value);
  try {
    const result: Record<string, RuntimeEnumExtensionValue> = {};
    for (const key of Object.keys(value).sort(lexicalCompare)) {
      Object.defineProperty(result, key, {
        value: canonicalizeExtensionValue(value[key], `${path}.${key}`, ctx, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function readExtensions(
  definition: Omit<RuntimeEnumDefinition, "extensions" | "serializeAs">,
  metadata: RuntimeEnumMetadata | undefined,
  ctx: RuntimeEnumContext,
): RuntimeEnumExtensionDefinition[] {
  if (!metadata?.extensions) return [];
  const path = `metadata[${JSON.stringify(definition.schemaName)}].extensions`;
  const result: RuntimeEnumExtensionDefinition[] = [];
  const suffixOwners = new Map<string, string>();
  for (const key of Object.keys(metadata.extensions).sort(lexicalCompare)) {
    const map = metadata.extensions[key];
    if (!isRecord(map)) throw enumError(ctx, `${path}[${JSON.stringify(key)}] 必须是对象`);
    const exportSuffix = runtimeExportName(key);
    if (!exportSuffix)
      throw enumError(ctx, `${path} 的扩展名 ${JSON.stringify(key)} 无法生成导出名`);
    const previous = suffixOwners.get(exportSuffix);
    if (previous) {
      throw enumError(
        ctx,
        `${path} 的 ${JSON.stringify(previous)} 与 ${JSON.stringify(key)} 生成相同导出后缀 ${exportSuffix}`,
      );
    }
    suffixOwners.set(exportSuffix, key);
    assertMapKeysKnown(map, definition.values, `${path}[${JSON.stringify(key)}]`, ctx);
    result.push({
      key,
      exportSuffix,
      values: definition.values.map((value) => {
        const valueKey = configLookupKey(value);
        return Object.prototype.hasOwnProperty.call(map, valueKey)
          ? canonicalizeExtensionValue(
              map[valueKey],
              `${path}[${JSON.stringify(key)}][${JSON.stringify(valueKey)}]`,
              ctx,
            )
          : null;
      }),
    });
  }
  return result;
}

function attachRuntimeMetadata(
  definition: Omit<RuntimeEnumDefinition, "extensions" | "serializeAs">,
  metadata: RuntimeEnumMetadata | undefined,
  ctx: RuntimeEnumContext,
): RuntimeEnumDefinition {
  const serializeAs = metadata?.serializeAs ?? "number";
  if (serializeAs === "string" && definition.values.some((value) => typeof value !== "number")) {
    throw enumError(
      ctx,
      `metadata[${JSON.stringify(definition.schemaName)}].serializeAs="string" 只支持数字枚举`,
    );
  }
  const complete: RuntimeEnumDefinition = {
    ...definition,
    extensions: readExtensions(definition, metadata, ctx),
    serializeAs,
  };
  validateDefinition(complete, ctx);
  return complete;
}

function generatedNames(definition: RuntimeEnumDefinition): string[] {
  const base = definition.exportName;
  const names = [
    base,
    `${base}ByLabel`,
    `${base}Labels`,
    `${base}Names`,
    `${base}Option`,
    `${base}Options`,
    `${base}Value`,
    `get${base}Label`,
    `get${base}Name`,
  ];
  if (definition.isFlags) names.push(`${base}Member`);
  for (const extension of definition.extensions) {
    names.push(`${base}${extension.exportSuffix}`, `${base}${extension.exportSuffix}Value`);
  }
  if (definition.serializeAs === "string") {
    names.push(`${base}Deserialize`, `${base}Serialize`, `deserialize${base}`, `serialize${base}`);
  }
  return names;
}

function assertGeneratedNamesUnique(
  definitions: readonly RuntimeEnumDefinition[],
  ctx: RuntimeEnumContext,
): void {
  const owners = new Map<string, string>();
  for (const definition of definitions) {
    for (const name of generatedNames(definition)) {
      const previous = owners.get(name);
      if (previous) {
        throw enumError(
          ctx,
          `schema ${JSON.stringify(previous)} 与 ${JSON.stringify(definition.schemaName)} 的生成导出 ${JSON.stringify(name)} 冲突`,
        );
      }
      owners.set(name, definition.schemaName);
    }
  }
}

/** metadata 在 transformSwagger 阶段只应用一次，并写回标准 enum/x-enum 数组。 */
export function prepareRuntimeEnumDocument(
  document: unknown,
  metadata: Readonly<Record<string, RuntimeEnumMetadata>>,
  ctx: RuntimeEnumContext,
): RuntimeEnumExportDescriptor[] {
  const schemas = readSchemas(document, ctx);
  validateMetadataRegistry(schemas, metadata, ctx);
  const definitions: RuntimeEnumDefinition[] = [];
  for (const [schemaName, rawSchema] of Object.entries(schemas)) {
    if (!isRecord(rawSchema)) continue;
    const configured = metadata[schemaName];
    const base = readBaseDefinition(schemaName, rawSchema, configured, ctx);
    if (!base) continue;
    applyMetadata(base, rawSchema.type, configured, ctx);
    const definition = attachRuntimeMetadata(base, configured, ctx);
    definitions.push(definition);
    rawSchema["x-enum-varnames"] = [...definition.names];
    rawSchema["x-enum-labels"] = [...definition.labels];
    if (definition.isFlags) {
      rawSchema.type = "integer";
      rawSchema[RUNTIME_ENUM_VALUES] = [...definition.values];
      delete rawSchema.enum;
    } else {
      rawSchema.enum = [...definition.values];
      delete rawSchema[RUNTIME_ENUM_VALUES];
    }
  }
  assertGeneratedNamesUnique(definitions, ctx);
  return definitions.map((definition) => ({
    schemaName: definition.schemaName,
    exportName: definition.exportName,
    extensionSuffixes: definition.extensions.map((extension) => extension.exportSuffix),
    serializeAs: definition.serializeAs,
    isFlags: definition.isFlags,
  }));
}

/** transformTypes 只从冻结的 normalizedDocument 收集，不重新读取或再次改写 Swagger。 */
export function collectRuntimeEnumDefinitions(
  document: unknown,
  metadata: Readonly<Record<string, RuntimeEnumMetadata>>,
  ctx: RuntimeEnumContext,
): RuntimeEnumDefinition[] {
  const schemas = readSchemas(document, ctx);
  validateMetadataRegistry(schemas, metadata, ctx);
  const definitions: RuntimeEnumDefinition[] = [];
  for (const [schemaName, rawSchema] of Object.entries(schemas)) {
    if (!isRecord(rawSchema)) continue;
    const configured = metadata[schemaName];
    const base = readBaseDefinition(schemaName, rawSchema, configured, ctx);
    if (!base) continue;
    definitions.push(attachRuntimeMetadata(base, configured, ctx));
  }
  assertGeneratedNamesUnique(definitions, ctx);
  return definitions;
}
