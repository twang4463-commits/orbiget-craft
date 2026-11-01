/**
 * 「同分支只发新增」的判定（2026-10-27）。
 *
 * 守的规则：
 * · 第一轮必须全量（页面线程是空的）；
 * · 历史**接续** ⇒ 只发新增的用户消息；
 * · 历史被改过（编辑/删除/重生成/压缩）⇒ 退回全量；
 * · 线程换过（页面 URL 变了）⇒ 退回全量；
 * · system 不进快照（它每轮可能变，带上就每轮都退回全量）。
 */
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_ONLY_TEXT } from '../capture/delta'
import { conversationPath, planDelta, renderDeltaText, renderSupplementText, threadChangedBetween, toSnapshots } from '../capture/delta'

describe('planDelta', () => {
  /** 第一轮发出去时的本地历史：一定以用户的提问结尾（页面答完才会追加助手消息） */
  const afterFirstAsk = [{ role: 'user', text: '第一问' }]
  /** 页面已经答完第一轮 */
  const afterFirstReply = [...afterFirstAsk, { role: 'assistant', text: '第一答' }]

  it('第一轮退回全量(页面线程还是空的)', () => {
    expect(planDelta(null, afterFirstAsk)).toEqual({ mode: 'replay', reason: 'first-turn' })
  })

  it('历史接续 ⇒ 只发新增的那一条用户消息', () => {
    const next = [...afterFirstReply, { role: 'user', text: '第二问' }]
    const plan = planDelta(afterFirstAsk, next)
    expect(plan.mode).toBe('delta')
    if (plan.mode !== 'delta') return
    expect(plan.added).toEqual([{ role: 'user', text: '第二问' }])
  })

  it('页面自己的回答（紧跟在前缀后面的 assistant）不再重发', () => {
    const next = [...afterFirstReply, { role: 'user', text: '第二问' }]
    const plan = planDelta(afterFirstAsk, next)
    expect(plan.mode).toBe('delta')
    if (plan.mode !== 'delta') return
    expect(plan.added.map((m) => m.text)).toEqual(['第二问'])
  })

  it('只有页面自己的回答、没有新提问 ⇒ 退回全量(别发空)', () => {
    expect(planDelta(afterFirstAsk, afterFirstReply)).toEqual({ mode: 'replay', reason: 'no-user-turn' })
  })

  it('⭐ 跨窗口：中间聊过别家模型 ⇒ 补记缺的用户 + 助手轮次，最后才是本轮问题', () => {
    const next = [
      ...afterFirstReply,
      { role: 'user', text: '在别家问的' },
      { role: 'assistant', text: '别家答的' },
      { role: 'user', text: '切回来问的' },
    ]
    const plan = planDelta(afterFirstAsk, next)
    expect(plan.mode).toBe('supplement')
    if (plan.mode !== 'supplement') return
    expect(plan.missing.map((m) => m.text)).toEqual(['在别家问的', '别家答的', '切回来问的'])
  })

  it('跨窗口补记之后：再问一轮只发新增（补记已经算页面看过了）', () => {
    const sent = [
      ...afterFirstReply,
      { role: 'user', text: '在别家问的' },
      { role: 'assistant', text: '别家答的' },
      { role: 'user', text: '切回来问的' },
    ]
    const next = [...sent, { role: 'assistant', text: '切回来的答' }, { role: 'user', text: '再问' }]
    const plan = planDelta(sent, next)
    expect(plan.mode).toBe('delta')
    if (plan.mode !== 'delta') return
    expect(plan.added.map((m) => m.text)).toEqual(['再问'])
  })

  it('历史被改过(前缀不同)⇒ 退回全量', () => {
    const next = [
      { role: 'user', text: '第一问(改过了)' },
      { role: 'assistant', text: '第一答' },
      { role: 'user', text: '第二问' },
    ]
    expect(planDelta(afterFirstAsk, next)).toEqual({ mode: 'replay', reason: 'not-extended' })
  })

  it('历史变短(压缩过)⇒ 退回全量', () => {
    expect(planDelta(afterFirstReply, afterFirstAsk)).toEqual({
      mode: 'replay',
      reason: 'not-extended',
    })
  })

  it('线程换过(页面 URL 变了)⇒ 退回全量', () => {
    const next = [...afterFirstReply, { role: 'user', text: '第二问' }]
    expect(planDelta(afterFirstAsk, next, { threadChanged: true })).toEqual({
      mode: 'replay',
      reason: 'thread-changed',
    })
  })
})

describe('toSnapshots', () => {
  it('system 不进快照(它每轮可能变)', () => {
    const snaps = toSnapshots([
      { role: 'system', content: '系统设定 A' },
      { role: 'user', content: '问' },
    ])
    expect(snaps).toEqual([{ role: 'user', text: '问' }])
  })

  it('多模态只取文本分片', () => {
    const snaps = toSnapshots([
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url' } as never] },
    ])
    expect(snaps[0].text).toBe('看图')
  })

  it('纯附件轮（只发图、不带字）用占位正文，增量不塌成空串', () => {
    const snaps = toSnapshots([
      { role: 'user', content: [{ type: 'image_url' } as never] },
    ])
    expect(snaps[0].text).toBe(ATTACHMENT_ONLY_TEXT)
    expect(renderDeltaText(snaps)).toBe(ATTACHMENT_ONLY_TEXT)
  })
})

describe('renderDeltaText', () => {
  it('贴进输入框的就是新增那段正文', () => {
    expect(renderDeltaText([{ role: 'user', text: '第二问' }])).toBe('第二问')
  })

  it('空文本不占位', () => {
    expect(renderDeltaText([{ role: 'user', text: '  ' }])).toBe('')
  })
})

describe('renderSupplementText · 跨窗口补记', () => {
  it('带上缺的用户 + 助手轮次，末尾是本轮问题', () => {
    const text = renderSupplementText([
      { role: 'user', text: '在别家问的' },
      { role: 'assistant', text: '别家答的' },
      { role: 'user', text: '切回来问的' },
    ])
    expect(text).toContain('补记')
    expect(text).toContain('用户：在别家问的')
    expect(text).toContain('助手：别家答的')
    // 末尾必须是本轮问题（指纹按最后一段匹配）
    expect(text.endsWith('切回来问的')).toBe(true)
  })

  it('没有中间轮次时只有补记头与本轮问题', () => {
    const text = renderSupplementText([{ role: 'user', text: '本轮' }])
    expect(text).toContain('补记')
    expect(text.endsWith('本轮')).toBe(true)
  })
})

describe('threadChangedBetween · 线程身份只看会话路径', () => {
  const conv = 'https://chat.deepseek.com/a/chat/s/abc'

  it('同一条会话（地址相同，或只多了查询串）⇒ 没换线程', () => {
    expect(threadChangedBetween(conv, conv)).toBe(false)
    expect(threadChangedBetween(conv, `${conv}?from=share`)).toBe(false)
  })

  it('会话切到别的会话 / 切回首页（新对话）⇒ 换了线程', () => {
    expect(threadChangedBetween(conv, 'https://chat.deepseek.com/a/chat/s/xyz')).toBe(true)
    expect(threadChangedBetween(conv, 'https://chat.deepseek.com/')).toBe(true)
  })

  it('拿不到地址 ⇒ 不下结论（交给其它判据）', () => {
    expect(threadChangedBetween(undefined, conv)).toBe(false)
    expect(threadChangedBetween(conv, undefined)).toBe(false)
  })

  it('conversationPath：首页是空路径，末尾斜杠与查询串不影响', () => {
    expect(conversationPath('https://chat.deepseek.com/')).toBe('')
    expect(conversationPath('https://chat.deepseek.com')).toBe('')
    expect(conversationPath(`${conv}/?x=1#y`)).toBe('/a/chat/s/abc')
    expect(conversationPath('not a url')).toBeUndefined()
  })
})
