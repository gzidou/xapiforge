import { safeCommentText } from "./naming.js";
import type { RuntimeEnumDefinition } from "./runtime-enum-types.js";

function memberReference(definition: RuntimeEnumDefinition, index: number): string {
  return `${definition.exportName}.${definition.names[index]}`;
}

function renderLookup(
  declaration: string,
  definition: RuntimeEnumDefinition,
  values: readonly unknown[],
): string[] {
  const lines = [`export const ${declaration} = {`];
  for (let index = 0; index < definition.values.length; index += 1) {
    lines.push(`  [${memberReference(definition, index)}]: ${JSON.stringify(values[index])},`);
  }
  lines.push("} as const;");
  return lines;
}

function byLabelEntries(definition: RuntimeEnumDefinition): Array<[string, number]> {
  const seen = new Set<string>();
  const entries: Array<[string, number]> = [];
  for (let index = 0; index < definition.labels.length; index += 1) {
    const label = definition.labels[index]!;
    if (seen.has(label)) continue;
    seen.add(label);
    entries.push([label, index]);
  }
  return entries;
}

function renderSerializeMaps(definition: RuntimeEnumDefinition): string[] {
  if (definition.serializeAs !== "string") return [];
  const base = definition.exportName;
  const lines = [`export const ${base}Serialize: Readonly<Record<${base}Value, string>> = {`];
  for (let index = 0; index < definition.values.length; index += 1) {
    lines.push(
      `  [${memberReference(definition, index)}]: ${JSON.stringify(String(definition.values[index]))},`,
    );
  }
  lines.push("} as const;", "");
  lines.push(`export const ${base}Deserialize: Readonly<Record<string, ${base}Value>> = {`);
  for (let index = 0; index < definition.values.length; index += 1) {
    lines.push(
      `  ${JSON.stringify(String(definition.values[index]))}: ${memberReference(definition, index)},`,
    );
  }
  lines.push("} as const;", "");
  lines.push(
    `export function serialize${base}(value: ${base}Value | number | null | undefined): string {`,
    `  if (value === null || value === undefined) return "";`,
    `  return (${base}Serialize as Readonly<Record<number, string>>)[value] ?? String(value);`,
    `}`,
    "",
    `export function deserialize${base}(value: string | number | null | undefined): ${base}Value | number {`,
    `  if (value === null || value === undefined) return Number.NaN;`,
    `  if (typeof value === "number") return value;`,
    `  return (${base}Deserialize as Readonly<Record<string, ${base}Value>>)[value] ?? Number(value);`,
    `}`,
  );
  return lines;
}

/** 把一个已验证 definition 渲染成可直接被业务 import 的稳定 TypeScript 产物。 */
export function renderRuntimeEnumDefinition(definition: RuntimeEnumDefinition): string {
  const { exportName, values, names, labels, isFlags } = definition;
  const lines = [
    `/** ${safeCommentText(definition.schemaName)}${isFlags ? "（Flags；API 字段保持 number，组合值请使用位运算）" : ""} */`,
    `export const ${exportName} = {`,
  ];
  for (let index = 0; index < values.length; index += 1) {
    // Computed keys keep special names such as `__proto__` as ordinary own properties.
    lines.push(`  [${JSON.stringify(names[index])}]: ${JSON.stringify(values[index])},`);
  }
  lines.push("} as const;", "");
  lines.push(
    `export type ${exportName}Value = (typeof ${exportName})[keyof typeof ${exportName}];`,
  );
  if (isFlags) {
    lines.push(
      `/** Swagger 明确声明的 Flags 基础成员；接口字段本身仍为 number。 */`,
      `export type ${exportName}Member = ${exportName}Value;`,
    );
  }
  lines.push("");

  lines.push(
    ...renderLookup(
      `${exportName}Labels: Readonly<Record<${exportName}Value, string>>`,
      definition,
      labels,
    ),
    "",
    ...renderLookup(
      `${exportName}Names: Readonly<Record<${exportName}Value, string>>`,
      definition,
      names,
    ),
    "",
  );

  lines.push(`/** 可直接用于 Select、Radio、Picker 等页面组件，顺序与 enum 声明一致。 */`);
  lines.push(`export const ${exportName}Options = [`);
  for (let index = 0; index < values.length; index += 1) {
    lines.push(
      `  { key: ${JSON.stringify(names[index])}, value: ${memberReference(definition, index)}, label: ${JSON.stringify(labels[index])} },`,
    );
  }
  lines.push(
    `] as const;`,
    `export type ${exportName}Option = (typeof ${exportName}Options)[number];`,
    "",
  );

  lines.push(`export const ${exportName}ByLabel: Readonly<Record<string, ${exportName}Value>> = {`);
  for (const [label, index] of byLabelEntries(definition)) {
    lines.push(`  [${JSON.stringify(label)}]: ${memberReference(definition, index)},`);
  }
  lines.push("} as const;", "");

  const fallbackType = values.every((value) => typeof value === "number")
    ? "number"
    : values.every((value) => typeof value === "string")
      ? "string"
      : "string | number";
  lines.push(
    `/** 取 label；未知值返回“未知”。 */`,
    `export function get${exportName}Label(value: ${exportName}Value | ${fallbackType} | null | undefined): string {`,
    `  if (value === null || value === undefined) return "未知";`,
    `  return (${exportName}Labels as Readonly<Record<string | number, string>>)[value] ?? "未知";`,
    `}`,
    "",
    `/** 取成员名；未知值返回“Unknown”。 */`,
    `export function get${exportName}Name(value: ${exportName}Value | ${fallbackType} | null | undefined): string {`,
    `  if (value === null || value === undefined) return "Unknown";`,
    `  return (${exportName}Names as Readonly<Record<string | number, string>>)[value] ?? "Unknown";`,
    `}`,
  );

  for (const extension of definition.extensions) {
    lines.push("");
    const declaration = `${exportName}${extension.exportSuffix}`;
    lines.push(...renderLookup(declaration, definition, extension.values));
    lines.push(`export type ${declaration}Value = (typeof ${declaration})[${exportName}Value];`);
  }

  const serializeLines = renderSerializeMaps(definition);
  if (serializeLines.length > 0) lines.push("", ...serializeLines);
  return lines.join("\n");
}
