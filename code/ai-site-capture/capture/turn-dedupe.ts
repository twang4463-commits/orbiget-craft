/**
 * 「同一轮只发一次」的桥侧账本（2026-10-29）。
 *
 * ## 为什么需要它
 *
 * 驱动和会话层都有自动重试：
 * · 驱动：未消费类失败自动重试一轮；
 * · 会话层：`network` 错误且还没有正文时再跑一次 `runBrainstormChat`。
 *
 * 两次重试都可能重新走 `WEB_CHAT_SEND`。页面如果第一次其实已经收下了，
 * 第二次注入就是**页面上两条一样的用户消息**（用户已遇到多次，DeepSeek）。
 *
 * ⇒ 每次发送带一个**跨重试稳定的 turnId**（当前轮的消息 id），桥记下
 * 「这一轮已经提交成功」；同一个 turnId + 同一段正文再来，直接回 `reused`，
 * 不再注入。不同轮次的 turnId 不同，所以「用户故意重复问同一句」不受影响。
 */
export interface TurnSendRecord {
  /** 正文指纹（与流归属判定同一口径） */
  hash: string
  at: number
  /** 这一轮注入过几次（仅 attempted 账用；confirmed 恒为 1） */
  n?: number
}

/** 同一轮最多注入几次。到顶后再注入就是页面上的第 N+1 条同样消息 ——
 *  用户 2026-10-31 真机截图里正是三条。「页面到底收没收」交给等回流去证，
 *  绝不靠继续添气泡来试（试不出来，只会刷屏）。 */
export const TURN_MAX_INJECTIONS = 2

/** 记多久：覆盖驱动的两次重试 + 会话层的一次重试，留足余量 */
export const TURN_SEND_TTL_MS = 10 * 60_000

/** 这一轮是不是已经提交过（同 turnId + 同正文指纹） */
export function isDuplicateTurnSend(
  records: Map<string, TurnSendRecord>,
  turnId: string,
  hash: string,
  now = Date.now(),
): boolean {
  if (!turnId) return false
  const prev = records.get(turnId)
  if (!prev) return false
  if (now - prev.at > TURN_SEND_TTL_MS) {
    records.delete(turnId)
    return false
  }
  return prev.hash === hash
}

/** 记下「这一轮已经提交成功」；顺手清掉过期记录 */
export function rememberTurnSend(
  records: Map<string, TurnSendRecord>,
  turnId: string,
  hash: string,
  now = Date.now(),
): void {
  if (!turnId) return
  for (const [id, rec] of records) {
    if (now - rec.at > TURN_SEND_TTL_MS) records.delete(id)
  }
  records.set(turnId, { hash, at: now, n: 1 })
}

/**
 * 记下「这一轮注入过一次（未必确认）」—— 在途账专用，计数累加。
 * 计数只用于封顶（见 `TURN_MAX_INJECTIONS`），过期口径与 confirmed 一致。
 */
export function bumpTurnAttempt(
  records: Map<string, TurnSendRecord>,
  turnId: string,
  hash: string,
  now = Date.now(),
): void {
  if (!turnId) return
  for (const [id, rec] of records) {
    if (now - rec.at > TURN_SEND_TTL_MS) records.delete(id)
  }
  const prev = records.get(turnId)
  // 正文变了 = 用户真的改了口径（换一轮），计数重来
  const n = prev && prev.hash === hash ? (prev.n ?? 1) + 1 : 1
  records.set(turnId, { hash, at: now, n })
}

/**
 * 同一轮重复送入时的三态分诊（2026-10-30 深夜，豆包真机「还是两条」）。
 *
 * 「已确认提交」和「从没见过」之间还有一个中间态：**触发过，但没确认**——
 * 离屏/隐藏页定时器被浏览器节流，「输入框清空 / 补全请求帧」这些已提交证据
 * 常常比 2.5s 验证窗慢半拍，上次触发其实有效。这个状态下立刻重注入，
 * 就是页面上的第二条用户消息。
 *
 * ⇒ 账本拆两本：`confirmed`（确认提交）+ `attempted`（触发即记）。
 * · confirmed 有账 ⇒ `reused`：直接认下，不注入；
 * · attempted 有账 ⇒ `await-evidence`：先等迟到证据再定夺，绝不立刻补枪；
 * · attempted 已注入到顶（`TURN_MAX_INJECTIONS`）⇒ `exhausted`：不再添第三条，
 *   直接判「页面没收下」交驱动报错（2026-10-31「不停重试」）；
 * · 都没账 ⇒ `send`：正常发送。
 */
export type DuplicateSendPlan = 'reused' | 'await-evidence' | 'exhausted' | 'send'

/** 同一轮再来时该怎么处置（turnId 为空 = 旧调用方，永远放行） */
export function planDuplicateSend(
  confirmed: Map<string, TurnSendRecord>,
  attempted: Map<string, TurnSendRecord>,
  turnId: string,
  hash: string,
  now = Date.now(),
): DuplicateSendPlan {
  if (isDuplicateTurnSend(confirmed, turnId, hash, now)) return 'reused'
  if (isDuplicateTurnSend(attempted, turnId, hash, now)) {
    const rec = attempted.get(turnId)
    if ((rec?.n ?? 1) >= TURN_MAX_INJECTIONS) return 'exhausted'
    return 'await-evidence'
  }
  return 'send'
}
