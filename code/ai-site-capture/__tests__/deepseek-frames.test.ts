/**
 * DeepSeek 网页端点 SSE 帧解析测试(2026-10-23;2026-10-24 按真机协议重写样例)。
 *
 * 钩子转来的是**任意切割**的原始文本块 —— 解析器必须扛住:
 * - 跨块断行(一行 JSON 被切成两半);
 * - 真机 JSON-Patch 形态(p/o/v:response/content、fragments 分流、status FINISHED);
 * - 旧纸面形态兜底(扁平 content / choices[].delta / reasoning_content / [DONE]);
 * - 错误帧(非零 code / type:"error" 载荷 / 内嵌 toast|hint);
 * - 未识别帧(计数诊断,不炸不丢流)。
 *
 * 真机形态来源:2026-10-24 第四轮真机定案(详见 deepseek-frames.ts 头注与规格文档)。
 */
import { describe, it, expect } from 'vitest'
import { DeepSeekFrameParser } from '../deepseek-frames'
import { extractBodyIdent } from '../types'

describe('DeepSeekFrameParser — 真机 JSON-Patch 形态', () => {
  it('普通模式正文:p=response/content 的 v 是正文增量', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data: {"p":"response/content","o":"APPEND","v":"你好"}\n')
    expect(frames).toEqual([{ type: 'content', delta: '你好' }])
  })

  it('专家模式 THINK→RESPONSE 分流:快照定段、-1/content 按段、切段带种子', () => {
    const parser = new DeepSeekFrameParser()
    // 起手快照:fragments[0] 是 THINK(种子为空,只定段)
    expect(parser.push('data: {"v":{"response":{"fragments":[{"type":"THINK","content":""}]}}}\n')).toEqual([])
    // THINK 段里的增量 → 思考
    expect(parser.push('data: {"p":"response/fragments/-1/content","o":"APPEND","v":"推演"}\n'))
      .toEqual([{ type: 'thinking', delta: '推演' }])
    // 切到 RESPONSE 段:种子内容直接带在段上 → 正文
    expect(parser.push('data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"你好"}]}\n'))
      .toEqual([{ type: 'content', delta: '你好' }])
    // RESPONSE 段里的增量 → 正文
    expect(parser.push('data: {"p":"response/fragments/-1/content","o":"APPEND","v":"呀"}\n'))
      .toEqual([{ type: 'content', delta: '呀' }])
    // 切回 THINK 也认(THINKING 变体同判)
    expect(parser.push('data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINKING","content":"再想想"}]}\n'))
      .toEqual([{ type: 'thinking', delta: '再想想' }])
  })

  it('纯 token 帧(v 字符串,无 p/o):按当前 fragment 类型分流,缺省正文', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"v":"正文"}\n')).toEqual([{ type: 'content', delta: '正文' }])
    parser.push('data: {"v":{"response":{"fragments":[{"type":"THINK","content":""}]}}}\n')
    expect(parser.push('data: {"v":"段内"}\n')).toEqual([{ type: 'thinking', delta: '段内' }])
  })

  it('结束信号:p=response/status 且 v=FINISHED(没有 [DONE]);其他状态值不算', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"p":"response/status","v":"IN_PROGRESS"}\n')).toEqual([])
    expect(parser.push('data: {"p":"response/status","v":"FINISHED"}\n')).toEqual([{ type: 'done' }])
  })

  it('错误帧:type:"error" 载荷与内嵌 toast 都认(风控/限流)', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"type":"error","content":"请求过于频繁","finish_reason":"INVALID"}\n'))
      .toEqual([{ type: 'error', message: '请求过于频繁' }])
    expect(parser.push('data: {"toast":{"type":"error","content":"服务有点拥挤"}}\n'))
      .toEqual([{ type: 'error', message: '服务有点拥挤' }])
  })

  it('完整一轮(真机形态回放):普通模式 → 正文累计 → FINISHED 收口', () => {
    const parser = new DeepSeekFrameParser()
    const chunks = [
      'data: {"v":{"response":{"content":""}}}\n\ndata: {"p":"response/content","o":"APPEND","v":"第一"}\n',
      'data: {"p":"response/content","o":"APPEND","v":"句"}\ndata: {"p":"response/status","v":"FINISHED"}\n',
    ]
    let content = ''
    let done = 0
    for (const chunk of chunks) {
      for (const frame of parser.push(chunk)) {
        if (frame.type === 'content') content += frame.delta
        if (frame.type === 'done') done++
      }
    }
    expect(content).toBe('第一句')
    expect(done).toBe(1)
  })
})

describe('DeepSeekFrameParser — 旧纸面形态兜底(留着无害)', () => {
  it('扁平 content 帧', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data: {"content":"你好"}\n\n')
    expect(frames).toEqual([{ type: 'content', delta: '你好' }])
  })

  it('OpenAI 风格 choices[].delta(含 reasoning_content)', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data: {"choices":[{"delta":{"reasoning_content":"思","content":"文"}}]}\n')
    expect(frames).toEqual([
      { type: 'content', delta: '文' },
      { type: 'thinking', delta: '思' },
    ])
  })

  it('[DONE] 与 finish_reason 都是结束信号;usage 帧带用量', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"choices":[{"delta":{"finish_reason":"stop"}}]}\n'))
      .toEqual([{ type: 'done' }])
    expect(parser.push('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n'))
      .toEqual([{ type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }])
    expect(parser.push('data: [DONE]\n')).toEqual([{ type: 'done' }])
  })

  it('错误帧:非零 code 提取 msg/description', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"code":40300,"msg":"MISSING_HEADER"}\n'))
      .toEqual([{ type: 'error', message: 'MISSING_HEADER' }])
  })
})

describe('DeepSeekFrameParser — 鲁棒性', () => {
  it('跨块断行:一行 JSON 切成三段也能拼回', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"p":"response/con')).toEqual([])
    expect(parser.push('tent","o":"APPEND","v":"拼')).toEqual([])
    const frames = parser.push('回"}\n')
    expect(frames).toEqual([{ type: 'content', delta: '拼回' }])
  })

  it('CRLF 与无空格 data: 前缀都认', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data:{"p":"response/content","o":"APPEND","v":"a"}\r\n\r\n')
    expect(frames).toEqual([{ type: 'content', delta: 'a' }])
  })

  it('未识别帧:进 unknown 诊断计数,超出保留条数后只计数不堆积', () => {
    const parser = new DeepSeekFrameParser({ unknownLimit: 2 })
    const all = parser.push('data: not-json\n\n\ndata: {"code":0,"idle":true}\n\ndata: {"x":1}\n\ndata: {"y":2}\n')
    const unknowns = all.filter(f => f.type === 'unknown')
    expect(unknowns.length).toBe(2)
    expect(parser.unknownFrameCount).toBe(4)
  })

  it('注释行/事件行/空行忽略', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push(': keep-alive\n\nevent: message\n\n')).toEqual([])
  })

  it('end():缓冲里「完整 JSON 但没结尾换行」的最后一帧也能解析', () => {
    const parser = new DeepSeekFrameParser()
    parser.push('data: {"p":"response/content","o":"APPEND","v":"尾"}')
    expect(parser.end()).toEqual([{ type: 'content', delta: '尾' }])
    expect(parser.end()).toEqual([])
  })

  it('end():残缺 JSON(流被掐断)按 unknown 诊断,不炸', () => {
    const parser = new DeepSeekFrameParser()
    parser.push('data: {"p":"response/content","o":"APPEND","v":"尾')
    const frames = parser.end()
    expect(frames.length).toBe(1)
    expect(frames[0].type).toBe('unknown')
  })
})

/**
 * **三元组身份**（2026-10-27）—— 对账的身份证，一行比对用。
 *
 * ```
 * (conversationId, messageId, role)
 * ```
 *
 * 两个来源：
 * · **请求体**（hook 抓的 body）→ conversationId + userMessageId
 *   （`chat_session_id` 是真机 fixture 里见过的字段名；`parent_message_id`
 *    是纸面推断，真机未验 —— 下面两组测试标注了哪些是硬事实、哪些是猜的）
 * · **返回流**（JSON-Patch 帧）→ assistantMessageId
 *
 * ⚠️ 这些 id 以前全走「unknown 计数当漂移信号」被丢掉。对账要它们，
 *    所以现在必须**捞出来**而不是当噪声。
 */
describe('三元组身份 · 返回流侧（ident 帧）', () => {
  it('⭐ 路径含 session ⇒ conversationId（原先被当 unknown 丢掉）', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data: {"p":"response/chat_session_id","o":"REPLACE","v":"conv-abc"}\n')
    expect(frames).toEqual([{ type: 'ident', conversationId: 'conv-abc', role: 'assistant' }])
  })

  it('⭐ 路径含 message 且不带 parent ⇒ 本轮 assistant 消息 id', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data: {"p":"response/message_id","o":"REPLACE","v":"msg-123"}\n')
    expect(frames).toEqual([{ type: 'ident', messageId: 'msg-123', role: 'assistant' }])
  })

  it('⭐ parent_message_id 是**上一条**的 id，不当本轮 id 收（否则对账会错位）', () => {
    const parser = new DeepSeekFrameParser()
    const frames = parser.push('data: {"p":"response/parent_message_id","o":"REPLACE","v":"prev-999"}\n')
    // 不是 ident ⇒ 退回 unknown 计数（漂移信号仍在）
    expect(frames.length).toBe(1)
    expect(frames[0].type).toBe('unknown')
    expect(parser.unknownFrameCount).toBe(1)
  })

  it('对账用的一行比对：同一个 convId + 不同 msgId ⇒ 两条不同的消息', () => {
    const parser = new DeepSeekFrameParser()
    const a = parser.push('data: {"p":"response/chat_session_id","v":"conv-1"}\n')
    const b = parser.push('data: {"p":"response/message_id","v":"msg-1"}\n')
    const c = parser.push('data: {"p":"response/message_id","v":"msg-2"}\n')
    const convId = a[0].type === 'ident' ? a[0].conversationId : undefined
    const id1 = b[0].type === 'ident' ? b[0].messageId : undefined
    const id2 = c[0].type === 'ident' ? c[0].messageId : undefined
    // 同一条对话、两个不同消息 ⇒ 对账时是两条，不会互相顶掉
    expect(convId).toBe('conv-1')
    expect(id1).toBe('msg-1')
    expect(id2).toBe('msg-2')
    expect(id1).not.toBe(id2)
  })

  it('正文/思考/结束帧不受影响（ident 不抢它们的路径）', () => {
    const parser = new DeepSeekFrameParser()
    expect(parser.push('data: {"p":"response/content","o":"APPEND","v":"你好"}\n'))
      .toEqual([{ type: 'content', delta: '你好' }])
    expect(parser.push('data: {"p":"response/status","v":"FINISHED"}\n'))
      .toEqual([{ type: 'done' }])
    expect(parser.unknownFrameCount).toBe(0)
  })
})

describe('三元组身份 · 请求体侧（extractBodyIdent）', () => {
  it('⭐ chat_session_id ⇒ conversationId（**真机 fixture 实证过的字段名**）', () => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [],
      prompt: '帮我写个大纲',
      chat_session_id: 's1',
      thinking_enabled: true,
    })
    expect(extractBodyIdent(body)).toEqual({ conversationId: 's1' })
  })

  it('⚠️ parent_message_id ⇒ userMessageId（**纸面推断，真机未验**）', () => {
    // 这条测试锁的是「我们期待的形状」；真机样本一到若字段名不同，
    // 改 extractBodyIdent 的正则即可，测试跟着改。
    const body = JSON.stringify({
      chat_session_id: 's1',
      parent_message_id: 'user-msg-42',
      messages: [{ role: 'user', content: '问题' }],
    })
    expect(extractBodyIdent(body)).toEqual({ conversationId: 's1', userMessageId: 'user-msg-42' })
  })

  it('嵌套/数组里也能捞到（DeepSeek 的 body 是深层结构）', () => {
    const body = JSON.stringify({
      meta: { chat_session_id: 'deep' },
      items: [{ parent_message_id: 'user-deep' }],
    })
    expect(extractBodyIdent(body)).toEqual({ conversationId: 'deep', userMessageId: 'user-deep' })
  })

  it('没有 id 字段 ⇒ 空对象（对账退回内容判重兜底）', () => {
    expect(extractBodyIdent(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })))
      .toEqual({})
  })

  it('非 JSON（页面改了直发格式）⇒ 空对象，不炸', () => {
    expect(extractBodyIdent('not json at all')).toEqual({})
    expect(extractBodyIdent('')).toEqual({})
  })
})
