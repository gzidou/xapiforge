import { createHash } from "node:crypto";
import { lexicalCompare } from "./naming.js";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 递归按 key 排序 OpenAPI 的 JSON 对象，同时保留所有数组顺序。
 *
 * JSON 对象顺序不属于 OpenAPI 语义；后端只调整序列化顺序时，不应制造类型漂移。
 * 数组顺序可能承载 enum、oneOf、parameters 等语义，所以绝不排序数组。
 */
export function canonicalizeOpenApi<T>(value: T): T {
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, path: string): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`[genapi] OpenAPI 文档只能包含有限数字：${path}`);
      }
      return current;
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new Error("[genapi] OpenAPI 文档不能包含循环引用");
      ancestors.add(current);
      try {
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.length !== current.length + 1) {
          throw new Error(`[genapi] OpenAPI 数组包含空洞或非 JSON 属性：${path}`);
        }
        for (const key of ownKeys) {
          if (key === "length") continue;
          const index = typeof key === "string" ? Number(key) : Number.NaN;
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= current.length ||
            String(index) !== key
          ) {
            throw new Error(`[genapi] OpenAPI 数组包含非 JSON 属性：${path}`);
          }
        }
        return Array.from({ length: current.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error(`[genapi] OpenAPI 数组包含空洞或非数据项：${path}[${index}]`);
          }
          return visit(descriptor.value, `${path}[${index}]`);
        });
      } finally {
        ancestors.delete(current);
      }
    }
    if (!isRecord(current)) {
      throw new Error(`[genapi] OpenAPI 文档包含非 JSON 值：${path} (${typeof current})`);
    }
    const prototype = Reflect.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`[genapi] OpenAPI 文档包含非 JSON 对象：${path}`);
    }
    if (ancestors.has(current)) throw new Error("[genapi] OpenAPI 文档不能包含循环引用");
    ancestors.add(current);
    try {
      const result: UnknownRecord = {};
      const entries: Array<[string, unknown]> = [];
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") {
          throw new Error(`[genapi] OpenAPI 对象包含 Symbol key：${path}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`[genapi] OpenAPI 对象包含非 JSON 属性：${path}.${key}`);
        }
        entries.push([key, descriptor.value]);
      }
      entries.sort(([left], [right]) => lexicalCompare(left, right));
      for (const [key, item] of entries) {
        // defineProperty 能把 __proto__ 当普通 JSON key 保留，而不是改写 result 的原型。
        Object.defineProperty(result, key, {
          value: visit(item, `${path}.${key}`),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, "$") as T;
}

/**
 * 固定 canonical document，避免后续 transformTypes 意外制造多份不一致视图。
 *
 * 生成器把同一对象交给 openapi-typescript、endpoint/schema inventory 和 hook context；
 * 任一消费者都只能读取，不能在其他消费者已经运行后再改写它。
 */
export function freezeOpenApi<T>(value: T): T {
  const visited = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (typeof current !== "object" || current === null || visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else {
      for (const item of Object.values(current)) visit(item);
    }
    Object.freeze(current);
  };
  visit(value);
  return value;
}

/** canonical OpenAPI 内容 hash；不会因 JSON 对象 key 重排而变化。 */
export function canonicalOpenApiHash(value: unknown): string {
  const canonical = canonicalizeOpenApi(value);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
