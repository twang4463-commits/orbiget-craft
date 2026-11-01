/**
 * DOM 兜底轮次捕获 —— 纯逻辑用例（2026-10-31 Gemini WebChannel 迁移配套）。
 */
import { describe, expect, it } from 'vitest'
import {
  DOM_TURN_BEGIN_DEDUPE_MS,
  DOM_TURN_FORCE_MS,
  DOM_TURN_ORPHAN_MS,
  DOM_TURN_PENDING_MS,
  DOM_TURN_SETTLE_MS,
  DomTurnTracker,
  type DomTurnSink,
} from '../capture/dom-turns'

/** 收集帧的哑 sink */
function makeSink(): DomTurnSink & { frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = []
  return {
    frames,
    request: (id, body) => frames.push({ f: 'request', id, body }),
    chunk: (id, delta) => frames.push({ f: 'chunk', id, delta }),
    reset: (id, text) => frames.push({ f: 'reset', id, text }),
    done: (id) => frames.push({ f: 'done', id }),
  }
}

function makeTracker(sink = makeSink(), seq = { n: 0 }) {
  return {
    tracker: new DomTurnTracker(sink, () => `id-${++seq.n}`),
    sink,
    seq,
  }
}

const el = (): Element => ({}) as unknown as Element

describe('DomTurnTracker · DOM 兜底轮次捕获', () => {
  it('新响应元素首见 ⇒ request(用户文本) + chunk(全文)', () => {
    const { tracker, sink } = makeTracker()
    tracker.feed(el(), '你好', '你好呀！', 1000)
    expect(sink.frames).toEqual([
      { f: 'request', id: 'id-1', body: '你好' },
      { f: 'chunk', id: 'id-1', delta: '你好呀！' },
    ])
  })

  it('前缀稳定增长 ⇒ 增量 chunk;不收缩不重发', () => {
    const { tracker, sink } = makeTracker()
    const e = el()
    tracker.feed(e, '问', '第一句', 1000)
    tracker.feed(e, '问', '第一句，第二句', 1100)
    tracker.feed(e, '问', '第一句，第二句', 1200) // 等长抖动:不发
    tracker.feed(e, '问', '第一句', 1300) // 收缩:不发
    expect(sink.frames).toEqual([
      { f: 'request', id: 'id-1', body: '问' },
      { f: 'chunk', id: 'id-1', delta: '第一句' },
      { f: 'chunk', id: 'id-1', delta: '，第二句' },
    ])
  })

  it('整段重写(前缀断裂) ⇒ reset 全量覆盖,不追加', () => {
    const { tracker, sink } = makeTracker()
    const e = el()
    tracker.feed(e, '问', '原稿', 1000)
    tracker.feed(e, '问', '完全不同的重写稿', 1100)
    expect(sink.frames).toEqual([
      { f: 'request', id: 'id-1', body: '问' },
      { f: 'chunk', id: 'id-1', delta: '原稿' },
      { f: 'reset', id: 'id-1', text: '完全不同的重写稿' },
    ])
  })

  it('settle 时限无增长 ⇒ done 收口;收口后再增长 ⇒ 新一轮新 id', () => {
    const { tracker, sink } = makeTracker()
    const e = el()
    tracker.feed(e, '问', '内容', 1000)
    tracker.sweep(1000 + DOM_TURN_SETTLE_MS - 1)
    expect(sink.frames.at(-1)).toEqual({ f: 'chunk', id: 'id-1', delta: '内容' })
    tracker.sweep(1000 + DOM_TURN_SETTLE_MS)
    expect(sink.frames.at(-1)).toEqual({ f: 'done', id: 'id-1' })
    // 同一元素又长出来了(重新生成) ⇒ 全新轮次(旧账已收口删除)
    tracker.feed(e, '问', '重新生成的内容', 3000)
    expect(sink.frames.at(-2)).toEqual({ f: 'request', id: 'id-2', body: '问' })
    expect(sink.frames.at(-1)).toEqual({ f: 'chunk', id: 'id-2', delta: '重新生成的内容' })
  })

  it('seed 的历史元素不回放;开始增长才晋升为真实轮次', () => {
    const { tracker, sink } = makeTracker()
    const e = { textContent: '历史内容没变' } as unknown as Element
    tracker.seed([e])
    expect(sink.frames).toEqual([])
    tracker.feed(e, '历史问', '历史内容没变', 1000) // 等长:仍不发
    expect(sink.frames).toEqual([])
    tracker.feed(e, '历史问', '历史内容没变,重新长出来', 1100)
    expect(sink.frames).toEqual([
      { f: 'request', id: 'id-1', body: '历史问' },
      { f: 'chunk', id: 'id-1', delta: ',重新长出来' },
    ])
  })

  it('drop 未收口元素 ⇒ 记孤儿;sweep 后 done(页面重渲染不悬流)', () => {
    const { tracker, sink } = makeTracker()
    const e = el()
    tracker.feed(e, '问', '半截内容', 1000)
    tracker.drop(e)
    tracker.sweep(1000 + DOM_TURN_SETTLE_MS)
    expect(sink.frames.at(-1)).toEqual({ f: 'done', id: 'id-1' })
    // 再 drop 同一元素:已出账,不重复 done
    tracker.drop(e)
    tracker.sweep(1000 + DOM_TURN_SETTLE_MS * 2)
    expect(sink.frames.filter(f => f.f === 'done')).toHaveLength(1)
  })

  it('生成中(Stop 按钮)抑制收口 —— 思考停顿不截断回答', () => {
    const generating = { on: true }
    const sink = makeSink()
    const seq = { n: 0 }
    const tracker = new DomTurnTracker(sink, () => `id-${++seq.n}`, () => generating.on)
    const e = el()
    tracker.feed(e, '问', '这就', 1000)
    tracker.sweep(1000 + DOM_TURN_SETTLE_MS) // 停顿超过 settle,但页面还在生成
    expect(sink.frames.some(f => f.f === 'done')).toBe(false)
    generating.on = false
    tracker.sweep(1000 + DOM_TURN_SETTLE_MS * 2)
    expect(sink.frames.at(-1)).toEqual({ f: 'done', id: 'id-1' })
  })

  it('生成中信号卡死也有强制收口兜底(90s)', () => {
    const sink = makeSink()
    const seq = { n: 0 }
    const tracker = new DomTurnTracker(sink, () => `id-${++seq.n}`, () => true)
    const e = el()
    tracker.feed(e, '问', '内容', 1000)
    tracker.sweep(1000 + 89_000)
    expect(sink.frames.some(f => f.f === 'done')).toBe(false)
    tracker.sweep(1000 + 90_000)
    expect(sink.frames.at(-1)).toEqual({ f: 'done', id: 'id-1' })
  })

  it('元素重渲染移除后,前缀连续的新元素收编为同一条流(不劈成两半)', () => {
    const { tracker, sink } = makeTracker()
    const old = el()
    tracker.feed(old, '问', '前半段', 1000)
    tracker.drop(old, 1000) // 页面把元素移除重建
    const next = el()
    tracker.feed(next, '问', '前半段后半段', 1500)
    expect(sink.frames).toEqual([
      { f: 'request', id: 'id-1', body: '问' },
      { f: 'chunk', id: 'id-1', delta: '前半段' },
      { f: 'chunk', id: 'id-1', delta: '后半段' },
    ])
  })

  it('收编窗口外的重渲染/重生成 ⇒ 另起新轮(不误接)', () => {
    const { tracker, sink } = makeTracker()
    const old = el()
    tracker.feed(old, '问', '第一版', 1000)
    tracker.drop(old, 1000)
    // 超过 10s 收编窗口:是重新生成,不是重渲染
    const next = el()
    tracker.feed(next, '问', '第一版第二版', 1000 + DOM_TURN_ORPHAN_MS + 1)
    expect(sink.frames.at(-2)).toEqual({ f: 'request', id: 'id-2', body: '问' })
  })

  it('用户气泡一出现就出 request(不等回复正文) —— 提交验证不再误判没提交', () => {
    const { tracker, sink } = makeTracker()
    tracker.beginTurn('新问题', 1000)
    expect(sink.frames).toEqual([{ f: 'request', id: 'id-1', body: '新问题' }])
  })

  it('响应元素认领 pending 轮次:只补 chunk,不再重复出 request', () => {
    const { tracker, sink } = makeTracker()
    tracker.beginTurn('新问题', 1000)
    const e = el()
    tracker.feed(e, '新问题', '回答开头', 1200)
    tracker.feed(e, '新问题', '回答开头继续', 1400)
    expect(sink.frames).toEqual([
      { f: 'request', id: 'id-1', body: '新问题' },
      { f: 'chunk', id: 'id-1', delta: '回答开头' },
      { f: 'chunk', id: 'id-1', delta: '继续' },
    ])
  })

  it('气泡重渲染同文本短窗口内只出一轮 request(8s 去重)', () => {
    const { tracker, sink } = makeTracker()
    tracker.beginTurn('重复渲染的消息', 1000)
    tracker.beginTurn('重复渲染的消息', 3000)
    expect(sink.frames).toHaveLength(1)
    // 超过去重窗口:用户真的又发了一遍同样的内容 ⇒ 正常出帧
    tracker.beginTurn('重复渲染的消息', 1000 + DOM_TURN_BEGIN_DEDUPE_MS)
    expect(sink.frames).toHaveLength(2)
  })

  it('pending 过期(响应迟迟不来)后新响应另起新轮,不误接到旧 request', () => {
    const { tracker, sink } = makeTracker()
    tracker.beginTurn('没等来回答的问题', 1000)
    tracker.sweep(1000 + DOM_TURN_PENDING_MS + 1) // pending 过期作废
    tracker.feed(el(), '没等来回答的问题', '迟到的回答', 200_000)
    expect(sink.frames.at(-2)).toEqual({ f: 'request', id: 'id-2', body: '没等来回答的问题' })
  })
})
