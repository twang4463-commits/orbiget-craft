/**
 * 请求体形状摘要（2026-10-27 豆包多请求分辨）。
 * 只出键名/类型/长度，绝不出值 —— 日志可以放心贴。
 */
import { describe, expect, it } from 'vitest'
import { summarizeBodyShape } from '../capture/shape'

describe('summarizeBodyShape', () => {
  it('给出结构化的键名/类型/长度，不含原值', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: '这是不能泄漏的正文' }],
      stream: true,
      model: 'doubao',
    })
    const shape = summarizeBodyShape(body)
    expect(shape).toContain('messages:[1]{role:str(4),content:str(9)}')
    expect(shape).toContain('stream:bool')
    expect(shape).toContain('model:str(6)')
    expect(shape).not.toContain('不能泄漏')
  })

  it('嵌套数组只展开首元素，长度保留', () => {
    expect(summarizeBodyShape(JSON.stringify({ a: [{ b: 1 }, { b: 2 }] })))
      .toBe('{a:[2]{b:num}}')
  })

  it('非 JSON / 空体如实标注', () => {
    expect(summarizeBodyShape('role=user&content=hi')).toBe('non-json')
    expect(summarizeBodyShape('')).toBe('empty')
  })
})
