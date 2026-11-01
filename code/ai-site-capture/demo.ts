/**
 * 最小使用示例：把一段站点流式响应还原成统一帧序列
 *
 * 以 ChatGPT 的流式行为为样本：全量快照 → 增量 → 结束。
 * 运行：npx tsx demo.ts
 */
import { ChatGPTFrameParser } from './chatgpt-frames'

// 站点流到达的原始 SSE 文本：每条事件一行 `data: <JSON>`，{"v": …} 的 v 是增量文本块
const lines = ['{"v":"你"}', '{"v":"好"}', '{"v":"，"}', '{"v":"世界"}', '[DONE]']
const sseBody = lines.map((l) => `data: ${l}\n\n`).join('')

const parser = new ChatGPTFrameParser()
const frames = [...parser.push(sseBody), ...parser.end()]

for (const f of frames) {
  if (f.type === 'content') console.log(`content  +${JSON.stringify(f.delta)}`)
  else if (f.type === 'reset') console.log(`reset    覆盖通道=${f.channel} 长度=${f.text.length}`)
  else if (f.type === 'done') console.log(`done     usage=${JSON.stringify(f.usage ?? {})}`)
  else if (f.type === 'ident') console.log(`ident    conv=${f.conversationId} msg=${f.messageId} role=${f.role}`)
  else console.log(f.type)
}

// 消费规则：content 追加；reset 覆盖（站点整段重写时保证不残留旧文本）
let text = ''
for (const f of frames) {
  if (f.type === 'content') text += f.delta
  if (f.type === 'reset') text = f.text
}
console.log('\n还原的正文:', JSON.stringify(text))
