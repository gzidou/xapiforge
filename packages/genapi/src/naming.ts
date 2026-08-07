/** TypeScript 关键字不能直接作为生成的 type、namespace 或属性标识符。 */
export const TYPESCRIPT_RESERVED_WORDS: ReadonlySet<string> = new Set([
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
  return /^[0-9]/.test(safe) || TYPESCRIPT_RESERVED_WORDS.has(safe) ? `_${safe}` : safe;
}

/** 不依赖 locale 的稳定字符串排序。 */
export function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
