/**
 * JSON.parse 不接受 UTF-8 BOM，但部分 Swagger 导出器会在 JSON 文本开头写入 BOM。
 * 只移除文档起始处的一个 BOM；其它字符仍交给 JSON.parse 严格校验。
 */
export function normalizeJsonInputText(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseJsonInput(text: string): unknown {
  return JSON.parse(normalizeJsonInputText(text)) as unknown;
}
