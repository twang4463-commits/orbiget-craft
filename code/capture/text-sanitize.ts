/**
 * 文本清理（开源抽离版）
 *
 * 与生产代码 src/content-script/capture/text-sanitize.ts 一致。
 * 采集的内容只在这里做本地清理（解码实体、统一换行、去零宽字符），
 * 不涉及任何远程请求。
 */
function decodeHtmlEntities(input: string): string {
  if (!input) return ''
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': '\'',
  }

  return input.replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (match) => entities[match.toLowerCase()] || match)
}

/**
 * 清理采集的文本内容
 * - 解码 HTML 实体
 * - 统一换行符
 * - 移除不换行空格和零宽字符
 * - 移除 HTML 标签
 * - 压缩多余空格
 * - 压缩多余空行
 */
export function sanitizeCapturedText(input: string): string {
  const text = decodeHtmlEntities((input || ''))
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/<[^>]+>/g, '')

  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 清理从 DOM 节点提取的文本内容
 * 专门用于处理 Readability.js 等库提取的 textContent
 */
export function sanitizeDomText(input: string): string {
  return sanitizeCapturedText(input)
}

export function isLikelyHtml(input: string): boolean {
  const trimmed = (input || '').trimStart()
  if (!trimmed) return false
  return /<(?:!doctype|html|head|body|div|p|span|section|article|main|nav|header|footer|ul|ol|li|table|thead|tbody|tr|td|th|br|img|a|h[1-6]|pre|code|blockquote)\b/i.test(trimmed)
}
