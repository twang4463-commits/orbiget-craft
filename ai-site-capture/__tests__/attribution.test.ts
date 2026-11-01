/**
 * 流归属判定（2026-10-27 真机：页面手动发的轮次被误判成「App 自己的」⇒ 丢弃）。
 *
 * 真机现场（DeepSeek）：App 在专窗里发过一条，随后用户在**同一个专窗**里
 * 手动追问。追问的请求体带着整条线程历史（含 App 上一轮那句），旧判据
 * 「整段请求体包含指纹」命中 ⇒ `foreign=false` ⇒ 旁路丢弃 ⇒ 本地不同步。
 */
import { describe, it, expect } from 'vitest'
import { matchTurnText, turnFingerprint } from '../capture/attribution'

/** DeepSeek 续聊的请求体：messages 带历史，最后一条是**本轮** */
function deepseekBody(messages: Array<{ role: string; content: string }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    chat_session_id: '49ce0469-1ac6-4fb0-b111-d7d1dd5b7f3e0',
    model: 'deepseek-chat',
    messages,
    thinking_enabled: false,
    ...extra,
  })
}

const APP_SAID = '历史上最出名的数学家有哪些'

describe('matchTurnText · 只比「本轮」（最后一条 user 消息）', () => {
  it('⭐ 真机 bug 复现：历史里有 App 发的那句、本轮是用户手打的另一句 ⇒ mismatch', () => {
    // 旧判据在这里会命中「历史里含 App 指纹」⇒ 误判成 App 自己的轮次
    const body = deepseekBody([
      { role: 'user', content: APP_SAID },
      { role: 'assistant', content: '冯·诺依曼、爱因斯坦……（长回答）' },
      { role: 'user', content: '那他和爱因斯坦的相处怎么样' },
    ])
    expect(matchTurnText(body, turnFingerprint(APP_SAID))).toBe('mismatch')
  })

  it('本轮就是 App 注入的那句 ⇒ match（驱动器照常收自己的流）', () => {
    const body = deepseekBody([
      { role: 'user', content: '上一轮旧的' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: APP_SAID },
    ])
    expect(matchTurnText(body, turnFingerprint(APP_SAID))).toBe('match')
  })

  it('新会话：messages 为空、正文只在顶层 prompt ⇒ match', () => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [],
      prompt: APP_SAID,
      chat_session_id: 's1',
    })
    expect(matchTurnText(body, turnFingerprint(APP_SAID))).toBe('match')
  })

  it('前缀陷阱：「解释一下」不能吃掉「解释一下量子力学」', () => {
    const body = deepseekBody([{ role: 'user', content: '解释一下量子力学' }])
    expect(matchTurnText(body, turnFingerprint('解释一下'))).toBe('mismatch')
  })

  it('空白/换行差异不算差异（富文本换行被拆成块）', () => {
    const body = deepseekBody([{ role: 'user', content: '第一行\n第二行  第三行' }])
    expect(matchTurnText(body, turnFingerprint('第一行 第二行 第三行'))).toBe('match')
  })

  it('超长文本只比尾部 80 字（差异在 80 字之外不影响）', () => {
    const tail = '丙'.repeat(90) + '尾部结论'
    const body = deepseekBody([{ role: 'user', content: '甲'.repeat(10) + tail }])
    expect(matchTurnText(body, turnFingerprint('乙'.repeat(10) + tail))).toBe('match')
  })

  it('豆包嵌套 JSON 的 content 照样能认', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: JSON.stringify({ text: '旧问题' }) },
        { role: 'assistant', content: JSON.stringify({ text: '旧回答' }) },
        { role: 'user', content: JSON.stringify({ text: '新问题' }) },
      ],
    })
    expect(matchTurnText(body, turnFingerprint('旧问题'))).toBe('mismatch')
    expect(matchTurnText(body, turnFingerprint('新问题'))).toBe('match')
  })

  it('非 JSON 明文 body（DOM 兜底帧）按明文比本轮；JSON 解不出 user 文本仍 unknown', () => {
    // 2026-10-31：明文 body = 用户消息本身（Gemini DOM 兜底），能直接比本轮
    expect(matchTurnText('not a json body', turnFingerprint('not a json body'))).toBe('match')
    expect(matchTurnText('not a json body', turnFingerprint('随便'))).toBe('mismatch')
    // JSON 解析成功但解不出 user 文本（无 role:user）⇒ 仍 unknown,退整段包含兜底
    expect(matchTurnText(JSON.stringify({ model: 'x', messages: [] }), turnFingerprint('随便'))).toBe('unknown')
  })
})
