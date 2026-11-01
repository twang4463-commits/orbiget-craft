/**
 * 请求体 → 「本轮用户文本」（2026-10-27 从 `page-capture.ts` 拆出）。
 *
 * 为什么单独一个模块：**桥（内容脚本）也要用**它做流归属判定
 * （`capture/attribution.ts`）。留在 `page-capture.ts` 里会把整条页面接力
 * 链路（含 `localStorage` 读去重表这类模块级副作用）拖进每站的 bridge
 * bundle —— 内容脚本里不需要，也不该跑。
 */

/**
 * 从请求体里取最后一条用户消息。
 *
 * 三家的请求体形状不同（DeepSeek 的 messages[].content 是字符串；豆包把
 * 正文放进 `content = JSON.stringify({ text })`），统一走「递给 role=user
 * 的对象，content 支持嵌套 JSON/数组」的递归解析。取**最后**一条 —— 请求体
 * 常带整段历史，最新那条才是这一轮。
 *
 * 解析不出来返回空串（纯图片轮次也可能没有文字）：UI 显示占位，绝不猜。
 */
export function extractLastUserText(body: string): string {
  if (!body) return ''
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    // 非 JSON 请求体（2026-10-31 Gemini DOM 兜底：body 就是用户消息明文）：
    // 原样当作用户文本。网络层乱码体以前走不到这（各站补全体都是 JSON），
    // 现在多了一条「DOM 出的明文帧」通道，必须认，否则手动轮次全被丢
    // （真机：`丢弃(解析不出用户消息也无图片证据)`）。
    return body.trim().slice(0, 8000)
  }
  // 顶层「本轮消息」字段优先(2026-10-25 真机:DeepSeek 新会话的请求体
  // messages 为空、正文只在顶层 prompt 里 —— 只认 role:user 会把整轮丢掉)
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    const obj = root as Record<string, unknown>
    for (const key of ['prompt', 'query', 'question']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  const found: string[] = []
  walkUserText(root, found, 0)
  return found.length ? found[found.length - 1] : ''
}

function walkUserText(value: unknown, out: string[], depth: number): void {
  if (depth > 8 || value == null) return
  if (Array.isArray(value)) {
    for (const item of value) walkUserText(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  const role = typeof obj.role === 'string' ? obj.role.toLowerCase() : ''
  if (role === 'user' || role === 'human') {
    const text = contentText(obj.content ?? obj.text ?? obj.parts ?? obj.message)
    if (text.trim()) out.push(text.trim())
  }
  for (const item of Object.values(obj)) walkUserText(item, out, depth + 1)
}

/** content 的兜底解包：字符串里的 JSON、数组里的文本段、对象里的 text/content */
function contentText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return contentText(JSON.parse(trimmed))
      } catch {
        return value
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map(contentText).filter(Boolean).join('\n')
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['text', 'content', 'value', 'query']) {
      if (!(key in obj)) continue
      const text = contentText(obj[key])
      if (text.trim()) return text
    }
  }
  return ''
}
