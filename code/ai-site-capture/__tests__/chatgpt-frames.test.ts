import { describe, expect, it } from 'vitest'
import { ChatGPTFrameParser } from '../chatgpt-frames'

function sse(lines: string[]): string {
  return lines.map(l => `data: ${l}\n\n`).join('')
}

describe('chatgpt-frames', () => {
  it('全量快照形态:message.content.parts 累积增长,按已收长度切增量', () => {
    const parser = new ChatGPTFrameParser()
    const snapshot = (text: string, status = 'in_progress'): string => JSON.stringify({
      message: {
        id: 'msg-1',
        status,
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: [text] },
      },
      conversation_id: 'conv-1',
      error: null,
    })
    const frames = [
      ...parser.push(sse([snapshot('你'), snapshot('你好'), snapshot('你好呀'), '[DONE]'])),
      ...parser.end(),
    ]
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['你', '好', '呀'])
    expect(frames.some(f => f.type === 'done')).toBe(true)
  })

  it('换 message.id(思考段→正文段)重置基线,不同段互不串', () => {
    const parser = new ChatGPTFrameParser()
    const snap = (id: string, contentType: string, text: string): string => JSON.stringify({
      message: { id, status: 'in_progress', author: { role: 'assistant' }, content: { content_type: contentType, parts: [text] } },
      error: null,
    })
    const frames = parser.push(sse([
      snap('think-1', 'thinking', '先想'),
      snap('think-1', 'thinking', '先想想'),
      snap('msg-2', 'text', '答'),
      snap('msg-2', 'text', '答案'),
    ]))
    expect(frames.filter(f => f.type === 'thinking').map(f => (f as { delta: string }).delta))
      .toEqual(['先想', '想'])
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['答', '案'])
  })

  it('v 增量形态(新协议):v 字符串直接当增量', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse(['{"v":"你"}', '{"v":"好"}', '[DONE]']))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['你', '好'])
    expect(frames.some(f => f.type === 'done')).toBe(true)
  })

  it('type 信封格式(2026-10-26 真机):v 增量帧出正文;元数据事件进忽略名单', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"type":"resume_conversation_token","kind":"topic","token":"eyJ"}',
      '{"type":"input_message","input_message":{"id":"u1","author":{"role":"user"}}}',
      '{"type":"message_marker","conversation_id":"c1","message_id":"m1"}',
      '{"type":"delta","v":"你"}',
      '{"type":"delta","v":"想"}',
      '{"type":"message_marker","conversation_id":"c1","message_id":"m1"}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['你', '想'])
    // 元数据帧忽略后,unknown 计数应为 0(之前真机 14 帧全 unknown 的病根)
    expect(parser.unknownFrameCount).toBe(0)
    expect(frames.some(f => f.type === 'done')).toBe(true)
  })

  it('thinking/reasoning 型信封的增量分流思考通道', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"type":"reasoning_delta","v":"先想想"}',
      '{"type":"delta","v":"答案"}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'thinking').map(f => (f as { delta: string }).delta))
      .toEqual(['先想想'])
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['答案'])
  })

  it('无 v 的变体:parts 数组 / text 字段也认', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"type":"delta","parts":["段一"]}',
      '{"type":"delta","text":"段二"}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['段一', '段二'])
  })

  it('v 数组的 patch 操作对象形态(真机二轮主流):按值语义深挖,o=patch 也收', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      // 首块:v 字符串(真机开头 6 字的来源)
      '{"type":"delta","v":"那咱们就不玩"}',
      // 主流:patch 操作数组(value 语义字段才进正文)
      '{"type":"delta","o":"patch","v":[{"op":"append","path":"/message/content/parts/0","value":"接句子了"}]}',
      '{"type":"delta","v":[{"p":"/message/content/parts/0","v":",聊点慢慢的"}]}',
      // replace/remove 是状态与元数据 patch,不进正文
      '{"type":"delta","v":[{"op":"replace","path":"/message/status","value":"finished_successfully"}]}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta).join(''))
      .toBe('那咱们就不玩接句子了,聊点慢慢的')
  })

  it('v 数组采样带载荷(残留形态下一轮可读)', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"type":"delta","v":[{"weird":{"nested":[1,2]}}]}',
      '[DONE]',
    ]))
    const unknown = frames.find(f => f.type === 'unknown') as { raw: string }
    expect(unknown.raw).toContain('v-array:')
    expect(unknown.raw).toContain('weird')
  })

  it('REPLACE 在 content/parts 上 = 累积快照切增量;status 的 replace 进 unknown', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"v":{"search_result":1}}',
      '{"p":"message/content/parts/0","o":"REPLACE","v":"第一段"}',
      '{"p":"message/content/parts/0","o":"REPLACE","v":"第一段第二段"}',
      '{"p":"/message/status","o":"REPLACE","v":"finished_successfully"}',
      '{"v":"正"}',
      '[DONE]',
    ]))
    // content 的 replace 按已发前缀切增量;replace 之后冒出来的裸 v 照样追加
    // (混排是新协议的真实形态,丢了正文就缺一段 —— 2026-10-30 起)
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['第一段', '第二段', '正'])
    // status 的 replace 不当正文,进 unknown 诊断(带载荷)
    expect(frames.some(f => f.type === 'unknown' && (f as { raw: string }).raw.includes('finished_successfully'))).toBe(true)
    expect(frames.some(f => f.type === 'unknown' && (f as { raw: string }).raw.includes('search_result'))).toBe(true)
  })

  it('v 对象内嵌 message 快照(新协议首帧)按快照解析;后续显式 p APPEND 不受锁模限制', () => {
    const parser = new ChatGPTFrameParser()
    const snapshot = JSON.stringify({
      v: { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你好'] } }, error: null },
    })
    const frames = parser.push(sse([
      snapshot,
      JSON.stringify({ p: '/message/content/parts/0', o: 'APPEND', v: '呀' }),
      JSON.stringify({ p: '/message/status', o: 'REPLACE', v: 'finished_successfully' }),
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['你好', '呀'])
    // status 的 REPLACE 进 unknown 诊断,不当正文
    expect(frames.some(f => f.type === 'unknown' && (f as { raw: string }).raw.startsWith('patch:replace'))).toBe(true)
  })

  it('v 字符串数组整段追加(o 非 APPEND 不拼)', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"p":"/message/content/parts/0","o":"APPEND","v":["段一"]}',
      '{"p":"/x","o":"DELETE","v":["不该拼"]}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['段一'])
    expect(frames.some(f => f.type === 'unknown' && (f as { raw: string }).raw.startsWith('v-array:DELETE'))).toBe(true)
  })

  it('user/system 快照与元数据帧忽略;error 字段映成 error 帧', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      JSON.stringify({ message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['用户的话'] } }, error: null }),
      JSON.stringify({ conversation_id: 'c1', error: null }),
      JSON.stringify({ error: { message: '太多了,慢一点' } }),
    ]))
    expect(frames.filter(f => f.type === 'content')).toEqual([])
    expect(frames.find(f => f.type === 'error')).toMatchObject({ message: '太多了,慢一点' })
  })

  it('跨块断行:快照 JSON 被拦腰截断也能拼回来', () => {
    const parser = new ChatGPTFrameParser()
    const full = `data: ${JSON.stringify({
      message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['跨块文本'] } },
      error: null,
    })}\n\n`
    const cut = Math.floor(full.length / 2)
    const frames = [...parser.push(full.slice(0, cut)), ...parser.push(full.slice(cut)), ...parser.end()]
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['跨块文本'])
  })

  it('工具调用快照(recipient=工具名)跳过 —— 生图参数 JSON 不进正文(2026-10-26 真机生图轮)', () => {
    const parser = new ChatGPTFrameParser()
    const snap = (recipient: string, text: string): string => JSON.stringify({
      message: {
        id: recipient === 'all' ? 'msg-visible' : 'msg-tool',
        status: 'in_progress',
        author: { role: 'assistant' },
        recipient,
        content: { content_type: 'text', parts: [text] },
      },
      error: null,
    })
    const frames = parser.push(sse([
      // 工具调用消息:parts 里是 image_gen 的调用参数 JSON,页面不渲染
      snap('image_gen', '{"prompt":"Create a charming, high-quality illustration square image, no text."}'),
      snap('image_gen', '{"prompt":"Create a charming, high-quality illustration square image, no text.","size":"square"}'),
      // 工具结果之后的可见正文
      snap('all', '给你画了一只海边落日下的螃蟹🦀'),
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta).join(''))
      .toBe('给你画了一只海边落日下的螃蟹🦀')
  })

  it('replace 前缀分叉(换段)即 reset 覆盖 —— 生图参数不再当正文残留(真机螃蟹轮)', () => {
    const parser = new ChatGPTFrameParser()
    const args = '{"prompt":"Create a charming, high-quality illustration square image, no text."}'
    const frames = parser.push(sse([
      JSON.stringify({ p: '/message/content/parts/0', o: 'replace', v: '{"prompt"' }),
      JSON.stringify({ p: '/message/content/parts/0', o: 'replace', v: args }),
      // 正文段:同路径但与参数前缀分叉 —— 页面换了新段,增量切不出干净边界
      JSON.stringify({ p: '/message/content/parts/0', o: 'replace', v: '给你画了一只海边落日下的螃蟹🦀' }),
      '[DONE]',
    ]))
    // 分叉段发 reset 全量替换:参数 JSON 被覆盖掉,最终正文只有回答本身
    // (旧行为把参数当增量拼进正文,回答前面挂着一段工具参数 JSON)
    const resets = frames.filter(f => f.type === 'reset') as Array<{ channel: string; text: string }>
    expect(resets).toEqual([{ type: 'reset', channel: 'content', text: '给你画了一只海边落日下的螃蟹🦀' }])
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta).join(''))
      .toBe(args)
  })

  it('replace 基线:同目标持续变长照常切增量(不因重置逻辑回退)', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"p":"/message/content/parts/0","o":"replace","v":"ab"}',
      '{"p":"/message/content/parts/0","o":"replace","v":"abc"}',
      '{"p":"/message/content/parts/0","o":"replace","v":"abcde"}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['ab', 'c', 'de'])
  })

  it('回归(2026-10-29 真机):裸 v 增量与 replace 全量快照混排不重发 —— 句中碎片重复的病根', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      // 正文先以裸 v 增量到达
      '{"type":"delta","v":"我个人偏向第三种混合第一种。"}',
      '{"type":"delta","v":"中期让人怀疑是灵异事件,"}',
      // 页面随后发 replace 全量快照(内容 = 已发文本)—— 旧基线只记 replace
      // 自己的长度,这里会把已发尾巴整段重发一次
      JSON.stringify({ p: '/message/content/parts/0', o: 'replace', v: '我个人偏向第三种混合第一种。中期让人怀疑是灵异事件,' }),
      '{"type":"delta","v":"最后再揭开真相。"}',
      '[DONE]',
    ]))
    const full = frames
      .map(f => (f.type === 'content' ? (f as { delta: string }).delta : ''))
      .join('')
    expect(full).toBe('我个人偏向第三种混合第一种。中期让人怀疑是灵异事件,最后再揭开真相。')
    expect(frames.some(f => f.type === 'reset')).toBe(false)
  })

  it('回归:同路径快照被页面重写(前缀分叉)⇒ reset 全量替换,下游覆盖不残留', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"p":"/message/content/parts/0","o":"replace","v":"中式恐怖:旧房子解释的存在。"}',
      // 页面把列表项重写成另一个版本(变长且中段分叉)
      '{"p":"/message/content/parts/0","o":"replace","v":"中式恐怖:旧房子、家人、禁忌、反复出现的细节,越日常越诡异。"}',
      '[DONE]',
    ]))
    const resets = frames.filter(f => f.type === 'reset') as Array<{ channel: string; text: string }>
    expect(resets).toHaveLength(1)
    expect(resets[0]).toMatchObject({ channel: 'content', text: '中式恐怖:旧房子、家人、禁忌、反复出现的细节,越日常越诡异。' })
    // 旧行为在这里切出「释的存在。」之类的句中碎片增量 —— 正文重复交错
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['中式恐怖:旧房子解释的存在。'])
  })

  it('回归:APPEND 增量记入路径账本,随后的 replace 快照不重发 append 过的尾巴', () => {
    const parser = new ChatGPTFrameParser()
    const frames = parser.push(sse([
      '{"p":"/message/content/parts/0","o":"APPEND","v":"第一段"}',
      '{"p":"/message/content/parts/0","o":"APPEND","v":"第二段"}',
      JSON.stringify({ p: '/message/content/parts/0', o: 'replace', v: '第一段第二段' }),
      '{"p":"/message/content/parts/0","o":"APPEND","v":"第三段"}',
      '[DONE]',
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['第一段', '第二段', '第三段'])
    expect(frames.some(f => f.type === 'reset')).toBe(false)
  })
})
