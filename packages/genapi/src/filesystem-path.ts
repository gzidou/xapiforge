import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function fileSystemErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

export function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function pathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" || process.platform === "darwin"
    ? absolute.toLowerCase()
    : absolute;
}

async function resolvePhysicalPathInternal(
  path: string,
  visitedLinks: Set<string>,
): Promise<string> {
  const absolute = resolve(path);
  try {
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      if (visitedLinks.has(absolute)) throw new Error(`symlink 循环：${absolute}`);
      visitedLinks.add(absolute);
      const target = await readlink(absolute);
      return resolvePhysicalPathInternal(resolve(dirname(absolute), target), visitedLinks);
    }
  } catch (cause) {
    const code = fileSystemErrorCode(cause);
    if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
  }

  let current = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (cause) {
      const code = fileSystemErrorCode(cause);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
      const parent = dirname(current);
      if (parent === current) throw cause;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

/** 解析已有或断开的 symlink，并为尚不存在的尾部路径解析最近的真实父目录。 */
export function resolvePhysicalPath(path: string): Promise<string> {
  return resolvePhysicalPathInternal(path, new Set<string>());
}
