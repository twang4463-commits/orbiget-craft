/**
 * 流归属判定（**纯函数**，2026-10-27）。
 *
 * 桥每看到一条补全请求都要回答一件事：**这一轮是不是 App 自己发的？**
 * 是 ⇒ 驱动收流、旁路丢弃；不是 ⇒ 用户在页面上手动聊的，旁路收下。
 * 两个方向判错都疼：
 * · 判成「自己的」⇒ 用户在页面上的那一轮**整轮丢失**（真机 2026-10-27：
 *   「我在 DeepSeek 界面聊天，本地不同步」，日志 `foreign=false … 丢弃`）；
 * · 判成「别人的」⇒ 同一轮落两份账。
 *
 * ## 口径：只比**本轮**，不比整段请求体
 *
 * 站点每轮都把**整条线程**重发（DeepSeek 的 `messages` 带全部历史），所以
 * 「请求体里出现过我发的那段文本」根本判不了归属 —— 历史里必然躺着上一轮、
 * 上上轮。唯一正确的比法是：请求体里**最后一条 user 消息**是不是我注入的
 * 那段（那是这一轮真正发出去的文本）。
 */
import { extractLastUserText } from './turn-text'

/**
 * 指纹口径 —— 去空白、取尾部 80 字。
 *
 * 取尾部而不是整段：各站会在正文前后补导语/附件标记，尾部是用户真敲的
 * 那截；去空白兼容富文本把换行拆成块（`textContent` 无分隔符）。
 */
export function turnFingerprint(text: string): string {
  return text.replace(/\s+/g, '').slice(-80)
}

export type TurnMatch =
  /** 最后一条 user 消息就是我这段 ⇒ 这一轮是我发的 */
  | 'match'
  /** 解得出本轮文本，但不是我这段 ⇒ 别人的轮次 */
  | 'mismatch'
  /** 解不出本轮文本（未知请求体形状）⇒ 判不了，调用方按旧口径兜底 */
  | 'unknown'

/**
 * 请求体代表的这一轮，是不是由 `fingerprint` 发起的。
 *
 * 尾部 80 字**完全一致**才算 match —— 用 `includes` 会把「App 发过
 * 『解释一下』、用户接着手打『解释一下量子力学』」判成同一轮。
 */
export function matchTurnText(body: string, fingerprint: string): TurnMatch {
  if (!body || !fingerprint) return 'unknown'
  const last = extractLastUserText(body)
  if (!last) return 'unknown'
  return turnFingerprint(last) === fingerprint ? 'match' : 'mismatch'
}
