import { describe, expect, it } from 'vitest'
import { mapChatGPTConversation, pulledTurnId, shortHash } from '../history-pull'

/** 组一条 ChatGPT mapping 节点 */
function node(
  role: 'user' | 'assistant' | 'tool',
  createTime: number,
  opts: {
    text?: string
    contentType?: string
    assetPointer?: string
    hidden?: boolean
    parts?: unknown[]
    /** 站点消息 id（三元组身份） */
    msgId?: string
    /** 父节点 id（mapping 是树；当前分支靠它回溯） */
    parent?: string
  } = {},
): Record<string, unknown> {
  return {
    ...(opts.parent ? { parent: opts.parent } : {}),
    message: {
      ...(opts.msgId ? { id: opts.msgId } : {}),
      author: { role },
      create_time: createTime,
      ...(opts.hidden ? { metadata: { is_visually_hidden_from_conversation: true } } : {}),
      content: {
        content_type: opts.contentType ?? 'text',
        ...(opts.parts ? { parts: opts.parts } : { parts: [opts.text ?? ''] }),
        ...(opts.assetPointer ? { asset_pointer: opts.assetPointer } : {}),
      },
    },
  }
}

describe('mapChatGPTConversation(拉取对账,§6.16)', () => {
  it('mapping 无序 → 按 create_time 排序;user/assistant 配对成轮', () => {
    const raw = JSON.stringify({
      title: '随便聊聊',
      mapping: {
        b: node('assistant', 200, { text: '答案一' }),
        a: node('user', 100, { text: '问题一' }),
        d: node('assistant', 400, { text: '答案二' }),
        c: node('user', 300, { text: '问题二' }),
      },
    })
    const { title, turns } = mapChatGPTConversation(raw)
    expect(title).toBe('随便聊聊')
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ userText: '问题一', assistantText: '答案一', at: 100_000 })
    expect(turns[1]).toMatchObject({ userText: '问题二', assistantText: '答案二', at: 300_000 })
  })

  it('隐藏消息(工具壳)与 tool 角色跳过;assistant 无前导 user 也成轮', () => {
    const raw = JSON.stringify({
      mapping: {
        t: node('tool', 50, { text: '工具壳' }),
        h: node('assistant', 60, { text: '被隐藏的', hidden: true }),
        a: node('assistant', 100, { text: '无前导的回答' }),
      },
    })
    const { turns } = mapChatGPTConversation(raw)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ userText: '', assistantText: '无前导的回答' })
  })

  it('多模态用户消息(parts 混文本与对象分片)取文本;助手图片轮出 imageUrls', () => {
    const raw = JSON.stringify({
      mapping: {
        u: node('user', 100, { contentType: 'multimodal_text', parts: [
          '看这张图',
          { asset_pointer: 'https://files.user-uploads.example/up.png' },
        ] }),
        a: node('assistant', 200, { contentType: 'image_asset_pointer', text: '', assetPointer: 'https://sfile.chatgpt.com/images/horse.png?se=1' }),
      },
    })
    const { turns } = mapChatGPTConversation(raw)
    expect(turns).toHaveLength(1)
    expect(turns[0].userText).toBe('看这张图')
    expect(turns[0].assistantText).toBe('')
    expect(turns[0].imageUrls).toEqual(['https://sfile.chatgpt.com/images/horse.png?se=1'])
  })

  it('空 assistant(无正文无图)不成轮;坏 JSON 不炸', () => {
    expect(mapChatGPTConversation('not json').turns).toEqual([])
    const raw = JSON.stringify({
      mapping: {
        u: node('user', 100, { text: '只有问题' }),
        a: node('assistant', 200, { text: '' }),
      },
    })
    expect(mapChatGPTConversation(raw).turns).toEqual([])
  })

  it('三元组身份:user / assistant 各带自己那条站点消息 id', () => {
    const raw = JSON.stringify({
      mapping: {
        u: node('user', 100, { text: 'q', msgId: 'u-1' }),
        a: node('assistant', 200, { text: 'a', msgId: 'a-1' }),
      },
    })
    const { turns } = mapChatGPTConversation(raw)
    expect(turns[0]).toMatchObject({ userMessageId: 'u-1', assistantMessageId: 'a-1' })
  })

  it('⭐ 只走当前分支:编辑/重新生成留下的旧枝不拉（旧枝从没出现在这段对话里）', () => {
    const raw = JSON.stringify({
      current_node: 'a2',
      mapping: {
        root: node('user', 10, { text: '开场', parent: '' }),
        u1: node('user', 100, { text: '原问题', parent: 'root' }),
        a1: node('assistant', 200, { text: '被放弃的回答', parent: 'u1' }),
        u2: node('user', 300, { text: '改过的问题', parent: 'root' }),
        a2: node('assistant', 400, { text: '当前回答', parent: 'u2' }),
      },
    })
    const { turns } = mapChatGPTConversation(raw)
    expect(turns.map(t => t.assistantText)).toEqual(['当前回答'])
    expect(turns[0].userText).toBe('改过的问题')
  })

  it('没有 current_node（老形状）⇒ 退回全量，不因缺字段拉空', () => {
    const raw = JSON.stringify({
      mapping: {
        u: node('user', 100, { text: 'q' }),
        a: node('assistant', 200, { text: 'a' }),
      },
    })
    expect(mapChatGPTConversation(raw).turns).toHaveLength(1)
  })

  it('稳定去重 id:同轮同 id,轮次不同 id', () => {
    const t1 = { userText: 'q', assistantText: 'a', imageUrls: [], at: 1000 }
    const t2 = { userText: 'q2', assistantText: 'a2', imageUrls: [], at: 2000 }
    expect(pulledTurnId('conv-1', 0, t1)).toBe(pulledTurnId('conv-1', 0, t1))
    expect(pulledTurnId('conv-1', 0, t1)).not.toBe(pulledTurnId('conv-1', 1, t2))
    expect(pulledTurnId('conv-1', 0, t1)).toMatch(/^pull:conv-1:0:/)
    expect(shortHash('abc')).not.toBe(shortHash('abd'))
  })
})
