/**
 * 请求体「形状摘要」—— 只出键名/类型/长度，**绝不出值**。
 *
 * 用途（2026-10-27 豆包真机）：一轮里可能同时出现多个含 completion 的
 * 请求（正文 / 标题 / 建议…），只靠「请求体里有没有本轮文本」会匹配错。
 * 把形状打进 App 控制台，就能分清哪条是主正文请求，不用去逆向页面 JS。
 */

function summarize(value: unknown, depth: number, maxDepth: number): string {
  if (value == null) return 'null'
  if (typeof value === 'string') return `str(${value.length})`
  if (typeof value === 'number') return 'num'
  if (typeof value === 'boolean') return 'bool'
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return `[${value.length}]${depth < maxDepth ? summarize(value[0], depth + 1, maxDepth) : ''}`
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 12)
    if (depth >= maxDepth) return `{${keys.join(',')}}`
    return `{${keys
      .map(key => `${key}:${summarize((value as Record<string, unknown>)[key], depth + 1, maxDepth)}`)
      .join(',')}}`
  }
  return typeof value
}

/** JSON 请求体 → 紧凑形状；非 JSON 返回 `non-json` */
export function summarizeBodyShape(body: string, maxDepth = 3): string {
  if (!body) return 'empty'
  try {
    const text = summarize(JSON.parse(body), 0, maxDepth)
    return text.length > 360 ? `${text.slice(0, 357)}...` : text
  } catch {
    return 'non-json'
  }
}
