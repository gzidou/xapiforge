import type { DebugStorageArea, StorageLike } from "./types.js";

export interface StorageEntrySnapshot {
  key: string;
  value: string;
  sensitive: boolean;
}

/**
 * 读取并按 key 排序 Storage 快照。
 * 敏感值在数据层即完成脱敏，后续 DOM 渲染和复制诊断都拿不到原值。
 */
export function readStorageSnapshot(area: DebugStorageArea): StorageEntrySnapshot[] {
  const keys: string[] = [];
  for (let index = 0; index < area.storage.length; index += 1) {
    const key = area.storage.key(index);
    if (key !== null) keys.push(key);
  }

  const previewLength = Math.max(16, area.valuePreviewLength ?? 160);
  return keys.sort().map((key) => {
    const sensitive = area.isSensitiveKey?.(key) ?? false;
    const originalValue = area.storage.getItem(key) ?? "";
    const value = sensitive
      ? "[已脱敏]"
      : originalValue.length > previewLength
        ? `${originalValue.slice(0, previewLength)}…`
        : originalValue;

    return { key, value, sensitive };
  });
}

/** 清理 Storage，但保留调用方明确指定的键。返回实际删除的键，方便记录诊断结果。 */
export function clearStorageExcept(
  storage: StorageLike,
  preservedKeys: Iterable<string> = [],
): string[] {
  const preserved = new Set(preservedKeys);
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && !preserved.has(key)) keys.push(key);
  }

  keys.forEach((key) => storage.removeItem(key));
  return keys;
}
