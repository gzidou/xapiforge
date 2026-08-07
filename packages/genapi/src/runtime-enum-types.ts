import type { TransformSwaggerHook } from "./index.js";

export type RuntimeEnumValue = string | number;

/** extensions 只接受可确定序列化的 JSON 值，避免生成函数、Date 或循环对象。 */
export type RuntimeEnumExtensionValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeEnumExtensionValue[]
  | { readonly [key: string]: RuntimeEnumExtensionValue };

export interface RuntimeEnumAppendValue {
  name: string;
  label: string;
  value: RuntimeEnumValue;
}

export interface RuntimeEnumMetadata {
  /** 按真实 enum value 覆盖前端展示 label。 */
  overrideLabels?: Readonly<Record<string | number, string>>;
  /** 按真实 enum value 覆盖生成的 TypeScript 成员名。 */
  overrideVarnames?: Readonly<Record<string | number, string>>;
  /** 显式补充 Swagger 缺失的 enum value；冲突会失败，不会静默跳过。 */
  appendValues?: readonly RuntimeEnumAppendValue[];
  /** 颜色、图标、tagType、单位等按 enum value 索引的任意 JSON 展示元数据。 */
  extensions?: Readonly<
    Record<string, Readonly<Record<string | number, RuntimeEnumExtensionValue>>>
  >;
  /** 数字枚举实际按字符串传输时，额外生成 Serialize/Deserialize map。 */
  serializeAs?: "number" | "string";
  /** Flags 字段在 OpenAPI 类型中生成 number，runtime map 只列出声明的基础成员。 */
  isFlags?: boolean;
}

export interface RuntimeEnumHooksOptions {
  /** 以 full schema name 为 key 的显式元数据。 */
  metadata?: Readonly<Record<string, RuntimeEnumMetadata>>;
  /** 可选的前置规范化 hook；用于 legacy Swagger 转成标准 enum。 */
  preprocessSwagger?: TransformSwaggerHook;
}

export interface RuntimeEnumExtensionDefinition {
  key: string;
  exportSuffix: string;
  values: RuntimeEnumExtensionValue[];
}

export interface RuntimeEnumDefinition {
  schemaName: string;
  exportName: string;
  values: RuntimeEnumValue[];
  names: string[];
  labels: string[];
  extensions: RuntimeEnumExtensionDefinition[];
  serializeAs: "number" | "string";
  isFlags: boolean;
}

/** api-types.ts 用它把 runtime enum 按现有 service/prefix/alias namespace 重导出。 */
export interface RuntimeEnumExportDescriptor {
  schemaName: string;
  exportName: string;
  extensionSuffixes: readonly string[];
  serializeAs: "number" | "string";
  isFlags: boolean;
}

export interface RuntimeEnumContext {
  projectId: string;
  serviceName: string;
}
