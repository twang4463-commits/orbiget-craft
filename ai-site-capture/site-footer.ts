/**
 * 网页端点回答的「站点页脚」清理（2026-10-31）
 *
 * 网页端点拿到的正文偶尔会把站点 UI 的免责声明一起带回来，例如 DeepSeek：
 *
 * ```
 * 本回答由 AI 生成，内容仅供参考，请仔细甄别
 * ```
 *
 * 它不是模型写的内容，也不该进聊天正文 / 产物代码 / 归档。
 * 这里只认**整行、出现在结尾**的固定句式：正文中间提到这句话是可能的
 * （用户在聊这件事），不能模糊包含。
 */

/**
 * 只匹配「结尾的一整行」：
 * · 允许前面有换行（行首）与行尾空白；
 * · 标点全角/半角、有无句号都认；
 * · 不做 `String.includes`，避免吃掉正文里正常提到这句话的段落。
 */
const FOOTER_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)[ \t]*本回答由\s*AI\s*生成[，,]\s*内容仅供参考[，,]\s*请仔细甄别[。.!！]?[ \t]*$/u,
  /(?:^|\n)[ \t]*本回答由\s*AI\s*生成[，,]\s*仅供参考[。.!！]?[ \t]*$/u,
  /(?:^|\n)[ \t]*内容由\s*AI\s*生成[，,]\s*仅供参考[。.!！]?[ \t]*$/u,
  /(?:^|\n)[ \t]*AI\s*生成内容[，,]\s*仅供参考[。.!！]?[ \t]*$/u,
]

/**
 * 去掉结尾的站点页脚（可能连续多行）。中间出现同样文案的不动。
 * 返回去掉首尾空白后的文本。
 */
export function stripSiteFooter(text: string): string {
  let out = text.trimEnd()
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of FOOTER_PATTERNS) {
      const next = out.replace(pattern, '').trimEnd()
      if (next !== out) {
        out = next
        changed = true
        break
      }
    }
  }
  return out
}
