/** OpenAPI 对象遍历时，当前节点的字段语义。 */
export type ReferenceWalkRole = "components" | "map" | "object";

const JSON_LITERAL_FIELDS = new Set(["const", "default", "enum", "example", "value"]);
const OPENAPI_MAP_FIELDS = new Set([
  "$defs",
  "callbacks",
  "content",
  "dependentSchemas",
  "encoding",
  "headers",
  "links",
  "parameters",
  "pathItems",
  "paths",
  "patternProperties",
  "properties",
  "requestBodies",
  "responses",
  "schemas",
  "securitySchemes",
  "webhooks",
]);
const REFERENCE_LIKE_LITERAL_KEYS = new Set(["$anchor", "$dynamicRef", "$recursiveRef", "$ref"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 返回子字段的 OpenAPI 遍历语义；null 表示其值是任意 JSON，而不是 OpenAPI 对象。
 * map 中的 key 是用户名称（例如 schema 名），即使恰好叫 `example` 或 `$ref` 也不改变语义。
 */
export function referenceChildRole(
  currentRole: ReferenceWalkRole,
  key: string,
  value: unknown,
): ReferenceWalkRole | null {
  if (currentRole === "map") return "object";
  if (key.startsWith("x-") || JSON_LITERAL_FIELDS.has(key)) return null;
  if (key === "components") return "components";
  // Example Object map 是对象；JSON Schema 的 examples 是任意值数组。
  if (key === "examples") return isRecord(value) ? "map" : null;
  if (currentRole === "components" || OPENAPI_MAP_FIELDS.has(key)) return "map";
  return "object";
}

function sanitizeLiteralJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeLiteralJson);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Redocly 会在任意 JSON 数据内解释这些 key。它们不影响 TypeScript 类型，
    // 因此只从第三方输入视图中删除，权威 normalized document 保持原样。
    if (REFERENCE_LIKE_LITERAL_KEYS.has(key)) continue;
    Object.defineProperty(result, key, {
      value: sanitizeLiteralJson(child),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/**
 * 为 openapi-typescript/Redocly 创建隔离输入。
 *
 * Redocly 会把 example/default/vendor extension 等任意 JSON 内的 `$ref` 误判为
 * OpenAPI 引用。该视图仅移除这些 literal 数据中的引用样式 key；schema、response、
 * PathItem 等语义位置的引用保持不变，并且不会修改冻结的权威 document。
 */
export function createOpenApiTypescriptInput<T>(document: T): T {
  const visit = (value: unknown, role: ReferenceWalkRole): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, "object"));
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childRole = referenceChildRole(role, key, child);
      Object.defineProperty(result, key, {
        value: childRole === null ? sanitizeLiteralJson(child) : visit(child, childRole),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  return visit(document, "object") as T;
}
