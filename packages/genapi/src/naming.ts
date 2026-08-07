/** TypeScript 关键字不能直接作为生成的 type、namespace 或属性标识符。 */
export const TYPESCRIPT_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "as",
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
  "yield",
]);

/** 在 namespace/object 运行时导出中会触发 JavaScript 特殊语义的属性名。 */
export const TYPESCRIPT_UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__"]);

/** 配置 ID（如 `fill-center`）到稳定 PascalCase 标识符。 */
export function pascalCaseConfigId(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
    .join("");
}

/** service ID 到运行时对象键；当前 kebab-case 会稳定映射为下划线键。 */
export function safeRuntimeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_$]/g, "_");
}

/** 把 schema 短名变成合法且稳定的 TypeScript alias。 */
export function safeTypeAlias(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[0-9]/.test(safe) ||
    TYPESCRIPT_RESERVED_WORDS.has(safe) ||
    TYPESCRIPT_UNSAFE_OBJECT_KEYS.has(safe)
    ? `_${safe}`
    : safe;
}

/** 把外部文本压成安全单行，避免结束符提前截断生成注释。 */
export function safeCommentText(value: string): string {
  let result = "";
  let inControlRun = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const isLineOrControl =
      codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029;
    if (isLineOrControl) {
      if (!inControlRun) result += " ";
      inControlRun = true;
      continue;
    }
    inControlRun = false;
    const isBidirectionalControl =
      (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (!isBidirectionalControl) result += character;
  }
  return result.replace(/\*\//g, "*\\/");
}

/** 不依赖 locale 的稳定字符串排序。 */
export function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
