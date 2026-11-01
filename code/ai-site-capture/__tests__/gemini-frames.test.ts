import { describe, expect, it } from 'vitest'
import { GeminiFrameParser } from '../gemini-frames'

/** 组一段 Gemini 式响应:)]}' 哨兵 + 嵌套数组树(路径稳定、跨段累积) */
function doc(value: unknown): string {
  return `)]}'\n${JSON.stringify(value)}\n`
}

describe('gemini-frames', () => {
  it('路径级累积切分:同路径变长发增量,等长/变短不发', () => {
    const parser = new GeminiFrameParser()
    const frames = [
      ...parser.push(doc([['x', [['你']]]])),
      ...parser.push(doc([['x', [['你好']]]])),
      ...parser.push(doc([['x', [['你好']]]])), // 等长快照:不发
      ...parser.push(doc([['x', [['你好呀']]]])),
      ...parser.end(),
    ]
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['你', '好', '呀'])
  })

  it('回声过滤:含本轮发送文本的值不当正文(构造传 sentText)', () => {
    const parser = new GeminiFrameParser({ sentText: '帮我写一首关于宇宙的诗,不要太长' })
    const frames = parser.push(doc([
      ['user', ['帮我写一首关于宇宙的诗,不要太长']],
      ['model', [['好的,这就为你写一首短的宇宙诗。']]],
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['好的,这就为你写一首短的宇宙诗。'])
  })

  it('噪音过滤:uuid/URL/纯数字/无空白长串不进正文', () => {
    const parser = new GeminiFrameParser()
    const frames = parser.push(doc([
      ['id', ['0f2c9d4e-11a2-4b3c-8d4e-5f6a7b8c9d0e']],
      ['url', ['https://lh3.googleusercontent.com/xx']],
      ['score', ['0.9876']],
      ['token', ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9eyJhbGciOiJIUzI1NiIs']],
      ['text', [['正文来了']]],
    ]))
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['正文来了'])
  })

  it('跨块断行:JSON 文档被拦腰截断由缓冲拼回;坏文档不炸流', () => {
    const parser = new GeminiFrameParser()
    const full = doc([['x', [['跨块的回答']]]])
    const cut = Math.floor(full.length / 2)
    const frames = [...parser.push(full.slice(0, cut)), ...parser.push(full.slice(cut)), ...parser.end()]
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['跨块的回答'])
  })

  it('JSON 字符串递归(真机形态):wrb.fr 第三段解一层,只走 "0" 响应容器键', () => {
    const parser = new GeminiFrameParser({ sentText: '继续聊点别的' })
    const state = (text: string): string => JSON.stringify([
      null,
      ['c_5010084149ccd8b2', 'r_8460cf19e16a0b3b'],
      { 7: [['Organizing workshop structure']], 44: true, ...(text ? { 0: [[text]] } : {}) },
    ])
    const frames = [
      ...parser.push(doc([['wrb.fr', null, state('')]])), // 首块只有活动文案,无 "0" → 不发
      ...parser.push(doc([['wrb.fr', null, state('这是回答的开头')]])),
      ...parser.push(doc([['wrb.fr', null, state('这是回答的开头,然后继续')]])),
      ...parser.end(),
    ]
    // 活动文案("Organizing workshop structure")绝不进正文;"0" 键累积增长发增量
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta).join(''))
      .toBe('这是回答的开头,然后继续')
    expect(frames.every(f => !(f.type === 'content' && (f as { delta: string }).delta.includes('Organizing')))).toBe(true)
  })

  it('非文档行静默忽略;流尾残留冲刷', () => {
    const parser = new GeminiFrameParser()
    const frames = [
      ...parser.push(")]}'\n"),
      ...parser.push(JSON.stringify([['尾行没有换行']])),
      ...parser.end(),
    ]
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta))
      .toEqual(['尾行没有换行'])
    expect(parser.unknownFrameCount).toBe(0)
  })

  it('回归(2026-10-30):整段一次到齐的中文长回答不该被「无空白长串」闸判成 token', () => {
    const parser = new GeminiFrameParser()
    // 中文正文没有空格:长度一过 120 就命中「无空白超长串 = token/base64」闸
    const answer = '脑洞助手给出的回答会很长，'.repeat(15) // ≈ 195 字,无空白
    const frames = [...parser.push(doc([['x', [[answer]]]])), ...parser.end()]
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta).join(''))
      .toBe(answer)
  })

  it('回归(2026-10-30):流式增长越过 120 字后不该停摆(长中文被截断)', () => {
    const parser = new GeminiFrameParser()
    const grow = (n: number): string => '脑洞助手给出的回答会很长，'.repeat(n)
    const frames: ReturnType<GeminiFrameParser['push']> = []
    for (const n of [1, 2, 4, 8, 16]) frames.push(...parser.push(doc([['x', [[grow(n)]]]])))
    frames.push(...parser.end())
    expect(frames.filter(f => f.type === 'content').map(f => (f as { delta: string }).delta).join(''))
      .toBe(grow(16))
  })
})
