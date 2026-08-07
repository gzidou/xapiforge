import { createRuntimeEnumHooks } from "@xapiforge/genapi";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedLegacyEnumValue {
  name: string;
  label: string;
  value: number;
}

function parseLegacyEnumValue(value: unknown): ParsedLegacyEnumValue | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([^()=]+?)(?:\(([^)]*)\))?=(-?\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const name = match[1]?.trim() ?? "";
  const label = match[2]?.trim() || name;
  const numericValue = Number(match[3]);
  if (!name || !Number.isSafeInteger(numericValue)) return undefined;
  return { name, label, value: numericValue };
}

/**
 * Demo/fixture 专用 legacy 规范化示例。
 *
 * 仅当 integer enum 的每一个值都满足 `Name(Label)=1` 时才整体转换；任一值无法解析就
 * 保持原 schema 不变，避免对未知历史格式做猜测。
 */
export function normalizeLegacyIntegerEnums(swagger: unknown): unknown {
  const document = structuredClone(swagger);
  if (!isRecord(document) || !isRecord(document.components)) return document;
  const schemas = document.components.schemas;
  if (!isRecord(schemas)) return document;

  for (const rawSchema of Object.values(schemas)) {
    if (!isRecord(rawSchema) || rawSchema.type !== "integer" || !Array.isArray(rawSchema.enum)) {
      continue;
    }
    const parsed = rawSchema.enum.map(parseLegacyEnumValue);
    if (parsed.some((item) => item === undefined)) continue;
    const values = parsed as ParsedLegacyEnumValue[];
    rawSchema.enum = values.map((item) => item.value);
    rawSchema["x-enum-varnames"] = values.map((item) => item.name);
    rawSchema["x-enum-labels"] = values.map((item) => item.label);
  }
  return document;
}

/** 可直接挂到 legacy service 的 hooks；不会影响其它标准 service。 */
export const legacyEnumHooks = createRuntimeEnumHooks({
  preprocessSwagger: (swagger) => Promise.resolve(normalizeLegacyIntegerEnums(swagger)),
  metadata: {
    "Fixture.LegacyPermissions": { isFlags: true },
  },
});
