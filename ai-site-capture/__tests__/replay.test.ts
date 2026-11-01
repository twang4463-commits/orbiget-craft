/**
 * 端口重放规则（2026-10-27 豆包真机）。
 *
 * 目标：驱动端口晚连上时，只补**最后一个未完结轮次**的帧；
 * 已完结的旧轮绝不重放（短文本会假匹配），没有请求也不补。
 */
import { describe, expect, it } from 'vitest'
import { activeTurnFrames } from '../capture/replay'

type Item = { seq: number; frame: { kind: string; requestId?: string; body?: string; text?: string } }

const req = (seq: number, requestId: string, body = 'hi'): Item => ({ seq, frame: { kind: 'request', requestId, body } })
const chunk = (seq: number, requestId: string, text = 'x'): Item => ({ seq, frame: { kind: 'chunk', requestId, text } })
const done = (seq: number, requestId: string): Item => ({ seq, frame: { kind: 'done', requestId } })

describe('activeTurnFrames · 只补未完结轮次', () => {
  it('在途请求 ⇒ request + 已到的 chunks 全补', () => {
    const ring = [req(1, 'r1'), chunk(2, 'r1'), chunk(3, 'r1')]
    expect(activeTurnFrames(ring).map(item => item.seq)).toEqual([1, 2, 3])
  })

  it('已完结的上一轮 ⇒ 不补（避免短文本假匹配死流）', () => {
    const ring = [req(1, 'r1'), chunk(2, 'r1'), done(3, 'r1')]
    expect(activeTurnFrames(ring)).toEqual([])
  })

  it('非流错误收口（response-error / error）也视为完结', () => {
    for (const kind of ['response-error', 'error']) {
      const ring = [req(1, 'r1'), { seq: 2, frame: { kind, requestId: 'r1' } }]
      expect(activeTurnFrames(ring)).toEqual([])
    }
  })

  it('只认最后一个请求；别的轮次/产物活动帧不混进来', () => {
    const ring = [
      req(1, 'old'), chunk(2, 'old'), done(3, 'old'),
      req(4, 'r2'), chunk(5, 'r2'),
      { seq: 6, frame: { kind: 'activity' } },
      chunk(7, 'other'),
    ]
    expect(activeTurnFrames(ring).map(item => item.seq)).toEqual([4, 5])
  })

  it('没有请求 ⇒ 空', () => {
    expect(activeTurnFrames([])).toEqual([])
    expect(activeTurnFrames([chunk(1, 'r1')])).toEqual([])
  })
})
