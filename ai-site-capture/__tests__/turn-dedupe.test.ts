import { describe, expect, it } from 'vitest'
import {
  TURN_MAX_INJECTIONS,
  TURN_SEND_TTL_MS,
  bumpTurnAttempt,
  isDuplicateTurnSend,
  planDuplicateSend,
  rememberTurnSend,
  type TurnSendRecord,
} from '../capture/turn-dedupe'

/**
 * 「同一轮只发一次」（2026-10-29 用户真机：DeepSeek 页面两条一样的消息）。
 *
 * 驱动和会话层都有自动重试；桥按 turnId 记「这一轮已经提交成功」，
 * 同一个 turnId + 同一段正文再来就只回 reused，不再注入。
 */
describe('turn-dedupe · 同一轮只发一次', () => {
  it('同一 turnId + 同一正文 ⇒ 判重（重试不再注入）', () => {
    const records = new Map<string, { hash: string; at: number }>()
    const now = 1_700_000_000_000
    rememberTurnSend(records, 'turn-1', 'hash-a', now)
    expect(isDuplicateTurnSend(records, 'turn-1', 'hash-a', now + 1000)).toBe(true)
  })

  it('同一 turnId、正文不同（工具回填 / 换了内容）⇒ 不判重', () => {
    const records = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(records, 'turn-1', 'hash-a', 1000)
    expect(isDuplicateTurnSend(records, 'turn-1', 'hash-b', 2000)).toBe(false)
  })

  it('不同 turnId ⇒ 不判重（用户故意重复问同一句）', () => {
    const records = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(records, 'turn-1', 'hash-a', 1000)
    expect(isDuplicateTurnSend(records, 'turn-2', 'hash-a', 2000)).toBe(false)
  })

  it('过了 TTL ⇒ 不判重', () => {
    const records = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(records, 'turn-1', 'hash-a', 1000)
    expect(isDuplicateTurnSend(records, 'turn-1', 'hash-a', 1000 + TURN_SEND_TTL_MS + 1)).toBe(false)
  })

  it('没有 turnId（旧调用方）⇒ 不去重，也不记账', () => {
    const records = new Map<string, { hash: string; at: number }>()
    expect(isDuplicateTurnSend(records, '', 'hash-a', 1000)).toBe(false)
    rememberTurnSend(records, '', 'hash-a', 1000)
    expect(records.size).toBe(0)
  })
})

/**
 * 「触发过但没确认」的中间态（2026-10-30 豆包真机「还是两条」）：
 * 离屏页证据迟到，上一回报了 not-submitted 页面其实提交了；
 * 重试再进来必须「先等迟到证据」，绝不能立刻重注入。
 */
describe('turn-dedupe · 三态分诊 planDuplicateSend', () => {
  it('确认账有记录 ⇒ reused（不注入，直接认下）', () => {
    const confirmed = new Map<string, { hash: string; at: number }>()
    const attempted = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(confirmed, 'turn-1', 'hash-a', 1000)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 2000)).toBe('reused')
  })

  it('只在途账有记录 ⇒ await-evidence（先等迟到证据，不补枪）', () => {
    const confirmed = new Map<string, { hash: string; at: number }>()
    const attempted = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(attempted, 'turn-1', 'hash-a', 1000)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 2000)).toBe('await-evidence')
  })

  it('两本账都没有 ⇒ send（正常发送）', () => {
    const confirmed = new Map<string, { hash: string; at: number }>()
    const attempted = new Map<string, { hash: string; at: number }>()
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 2000)).toBe('send')
  })

  it('在途账已过期 ⇒ send（10 分钟外的旧触发不拦新发送）', () => {
    const confirmed = new Map<string, { hash: string; at: number }>()
    const attempted = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(attempted, 'turn-1', 'hash-a', 1000)
    expect(
      planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 1000 + TURN_SEND_TTL_MS + 1),
    ).toBe('send')
  })

  it('在途账命中但正文不同 ⇒ send（同 turnId 换了内容，按新发送处理）', () => {
    const confirmed = new Map<string, { hash: string; at: number }>()
    const attempted = new Map<string, { hash: string; at: number }>()
    rememberTurnSend(attempted, 'turn-1', 'hash-a', 1000)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-b', 2000)).toBe('send')
  })

  it('没有 turnId ⇒ 永远 send（旧调用方不参与分诊）', () => {
    const confirmed = new Map<string, { hash: string; at: number }>()
    const attempted = new Map<string, { hash: string; at: number }>()
    expect(planDuplicateSend(confirmed, attempted, '', 'hash-a', 1000)).toBe('send')
  })
})

/**
 * 注入次数封顶（2026-10-31 用户「不停的重试」真机：页面上第三条一模一样的
 * 用户消息）。证据一直不来时继续注入只是刷屏，`exhausted` 直接判失败。
 */
describe('turn-dedupe · 注入次数封顶', () => {
  it('在途账计数累加：第 2 次仍等证据，到顶 ⇒ exhausted', () => {
    const confirmed = new Map<string, TurnSendRecord>()
    const attempted = new Map<string, TurnSendRecord>()
    bumpTurnAttempt(attempted, 'turn-1', 'hash-a', 1000)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 1100)).toBe('await-evidence')
    bumpTurnAttempt(attempted, 'turn-1', 'hash-a', 1200)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 1300))
      .toBe(TURN_MAX_INJECTIONS >= 2 ? 'exhausted' : 'await-evidence')
  })

  it('已注入到顶 ⇒ 无论重试几次都是 exhausted（不再添气泡）', () => {
    const confirmed = new Map<string, TurnSendRecord>()
    const attempted = new Map<string, TurnSendRecord>()
    for (let i = 0; i < TURN_MAX_INJECTIONS; i += 1) bumpTurnAttempt(attempted, 'turn-1', 'hash-a', 1000 + i)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 2000)).toBe('exhausted')
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 3000)).toBe('exhausted')
  })

  it('确认提交后 ⇒ reused 优先于 exhausted（页面回流的轮次不受封顶影响）', () => {
    const confirmed = new Map<string, TurnSendRecord>()
    const attempted = new Map<string, TurnSendRecord>()
    for (let i = 0; i < TURN_MAX_INJECTIONS; i += 1) bumpTurnAttempt(attempted, 'turn-1', 'hash-a', 1000 + i)
    rememberTurnSend(confirmed, 'turn-1', 'hash-a', 2000)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', 2100)).toBe('reused')
  })

  it('正文变了 ⇒ 计数从头来（用户改口径重发不被封顶卡住）', () => {
    const confirmed = new Map<string, TurnSendRecord>()
    const attempted = new Map<string, TurnSendRecord>()
    for (let i = 0; i < TURN_MAX_INJECTIONS; i += 1) bumpTurnAttempt(attempted, 'turn-1', 'hash-a', 1000 + i)
    bumpTurnAttempt(attempted, 'turn-1', 'hash-b', 2000)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-b', 2100)).toBe('await-evidence')
  })

  it('在途账过期后重新计数（10 分钟外的旧轮不封新轮）', () => {
    const confirmed = new Map<string, TurnSendRecord>()
    const attempted = new Map<string, TurnSendRecord>()
    for (let i = 0; i < TURN_MAX_INJECTIONS; i += 1) bumpTurnAttempt(attempted, 'turn-1', 'hash-a', 1000 + i)
    const later = 1000 + TURN_SEND_TTL_MS + 10
    bumpTurnAttempt(attempted, 'turn-1', 'hash-a', later)
    expect(planDuplicateSend(confirmed, attempted, 'turn-1', 'hash-a', later + 10))
      .toBe('await-evidence')
  })
})
