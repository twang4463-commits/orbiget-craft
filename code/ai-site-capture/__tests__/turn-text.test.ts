/**
 * 用户消息提取 —— 纯文本 body 的兜底用例（2026-10-31 Gemini DOM 兜底配套）。
 */
import { describe, expect, it } from 'vitest'
import { extractLastUserText } from '../capture/turn-text'

describe('extractLastUserText · 纯文本 body 兜底', () => {
  it('非 JSON 的明文 body 原样作为用户文本(DOM 兜底帧)', () => {
    expect(extractLastUserText('不吐葡萄皮？还是单纯想找人唠两句')).toBe(
      '不吐葡萄皮？还是单纯想找人唠两句',
    )
  })

  it('明文 body 首尾空白折叠、超长截断(8000 封顶)', () => {
    expect(extractLastUserText('  你好  ')).toBe('你好')
    expect(extractLastUserText('x'.repeat(9000))).toHaveLength(8000)
  })

  it('JSON body 的行为不变(回归保护)', () => {
    expect(extractLastUserText(JSON.stringify({ prompt: '顶层正文' }))).toBe('顶层正文')
    expect(
      extractLastUserText(JSON.stringify({ messages: [{ role: 'user', content: '最后一条' }] })),
    ).toBe('最后一条')
  })

  it('空 body 仍返回空串', () => {
    expect(extractLastUserText('')).toBe('')
  })
})
