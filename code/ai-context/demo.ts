/**
 * 最小使用示例：把 40 条长消息压进 500 token 预算
 *
 * 运行：npx tsx demo.ts
 */
import { compressHistoryMessages, COMPACTION_DIGEST_HEADER } from './context-compaction'

// 造 40 条对话，每条约 1000 字
const history = Array.from({ length: 40 }, (_, i) => ({
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  content: `第 ${i} 条消息：关于创作项目的一段比较长的讨论。`.repeat(40),
}))

const before = history.reduce((n, m) => n + m.content.length, 0)
const { messages, compacted } = compressHistoryMessages(history, { maxTokens: 500 })

console.log(`压缩前: ${history.length} 条 / 约 ${before} 字`)
console.log(`压缩后: ${messages.length} 条 / compacted=${compacted}`)

const digest = messages[0]
if (digest && typeof digest.content === 'string' && digest.content.startsWith(COMPACTION_DIGEST_HEADER)) {
  const lines = digest.content.split('\n')
  console.log(`\n摘要块（共 ${lines.length} 行）：`)
  for (const line of lines.slice(0, 6)) console.log(' ', line.slice(0, 60) + (line.length > 60 ? '…' : ''))
  console.log('  …')
}

// 再压一次：幂等 —— 已折叠的摘要原样并入，不会摘要套摘要
const again = compressHistoryMessages(messages, { maxTokens: 500 })
const digestCount = again.messages.filter(
  (m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_DIGEST_HEADER),
).length
console.log(`\n二次压缩: ${again.messages.length} 条，摘要块 ${digestCount} 个（应为 1）`)
