/**
 * DOM 兜底轮次捕获 —— **纯逻辑**（2026-10-31 Gemini 定案）。
 *
 * ## 为什么存在
 *
 * Gemini 网页端 2026-10-20 把补全从 `batchexecute`/`StreamGenerate` 全面
 * 迁到了 WebChannel 全双工二进制 Protobuf（`/v1/processSession`）—— 钩子
 * 在网络层再也看不见补全请求/响应（表现：页面正常聊、驱动永远
 * `seenAnyRequest=false`）。二进制 protobuf 逆向成本高、漂移快；而 Gemini
 * 页面的 `user-query` / `model-response` 语义标签多年稳定 ⇒ **桥直接盯
 * DOM 出帧**，帧走与钩子同一条 postMessage 管道（归属/环形缓冲/回放/
 * 广播全部复用，驱动侧零改动）。
 *
 * ## 出帧口径（与钩子帧同构）
 *
 * · 新响应元素首见 → `request`（body = 前面最近的 user-query 文本）
 * · 文本增长（前缀稳定）→ `chunk`（增量）
 * · 文本整段重写（前缀断裂，重新生成/归一化）→ `reset`（全量覆盖）
 * · 无增长超过 settle 时限 → `done`（流式渲染停顿即收口）
 *
 * 归属不用自己判：request 帧进桥的统一管道后由 `isRecentOwnRequest` 按
 * 指纹认领 —— App 注入的文本渲染在 user-query 里，天然命中。
 */

/** 与钩子帧同源的 postMessage source（hook-core 的 MSG_SOURCE / bridge-core
 *  的 HOOK_SOURCE 与此值必须一致 —— 三处都是 'occ-web-chat'） */
export const WEB_CHAT_FRAME_SOURCE = 'occ-web-chat'

export interface DomTurnSink {
  request(requestId: string, body: string): void
  chunk(requestId: string, delta: string): void
  /** 整段重写：消费方覆盖已累计文本，不能追加 */
  reset(requestId: string, text: string): void
  done(requestId: string): void
}

/** 无增长多久判一轮结束（流式渲染停顿；要大于流式 token 间隔，小于驱动空闲窗） */
export const DOM_TURN_SETTLE_MS = 1500

/** 强制收口时限：生成中信号误判常驻时的绝对兜底（Stop 按钮卡死/页面将跳） */
export const DOM_TURN_FORCE_MS = 90_000

/** 孤儿元素的收编窗口：元素被页面重渲染移除后，多久内出现的前缀连续新元素算同一条流 */
export const DOM_TURN_ORPHAN_MS = 10_000

/** 用户气泡重渲染的 request 去重窗口（同文本短窗口内只出一轮） */
export const DOM_TURN_BEGIN_DEDUPE_MS = 8_000

/** 已出 request 帧的轮次等响应元素认领的最长时间（超时不收口，只丢 pending） */
export const DOM_TURN_PENDING_MS = 180_000

interface ActiveTurn {
  /** 空串 = seed 占位（观察起点已存在的元素），增长时才晋升为真实轮次 */
  id: string
  text: string
  lastGrewAt: number
  userText: string
  /** 元素已被页面移除（等待收编/收口）；在册 = 还活着 */
  orphanedAt?: number
}

export class DomTurnTracker {
  private turns = new Map<Element, ActiveTurn>()
  /** 已出 request 帧、还没绑定响应元素的轮次（用户气泡一出现就出帧 ——
   *  不等回复正文：提交验证等不起思考停顿） */
  private pending: { id: string; userText: string; at: number } | null = null
  /** 上次 beginTurn 的记录（用户气泡重渲染去重） */
  private lastBegun: { userText: string; at: number } | null = null

  constructor(
    private readonly sink: DomTurnSink,
    private readonly nextId: () => string,
    /** 页面是否还在生成（Gemini：流式期间有「停止」按钮）。true 期间不做
     *  settle 收口 —— 思考/联网停顿经常远超 settle 时限，过早 done 会把
     *  回答截在开头（真机：app 里只收到「这就」两个字）。 */
    private readonly isGenerating?: () => boolean,
  ) {}

  /**
   * 用户气泡出现 —— **立刻**出 request 帧（2026-10-31 无限重试定案）。
   *
   * 旧实现在响应正文出现时才出 request，而桥的提交验证（requireRequestEvidence）
   * 只认 request 帧：首 token 慢于验证窗 ⇒ 判「没提交」⇒ 重注入 ⇒ 页面上
   * 真的多一条 ⇒ 又判没提交…… 无限重试 + 重复消息。用户气泡是页面
   * **收下消息的最早铁证**，一到就报。
   */
  beginTurn(userText: string, now = Date.now()): void {
    const text = userText.trim()
    if (!text) return
    // 气泡重渲染会重复触发：同文本短窗口内只出一轮 request
    if (this.lastBegun && this.lastBegun.userText === text && now - this.lastBegun.at < DOM_TURN_BEGIN_DEDUPE_MS) return
    const id = this.nextId()
    this.lastBegun = { userText: text, at: now }
    this.pending = { id, userText: text, at: now }
    this.sink.request(id, text)
  }

  /** 观察起点：既有响应元素按「已收完」记账（绝不回放历史） */
  seed(els: Iterable<Element>): void {
    for (const el of els) {
      if (this.turns.has(el)) continue
      this.turns.set(el, { id: '', text: el.textContent ?? '', lastGrewAt: Date.now(), userText: '' })
    }
  }

  /**
   * 某响应元素的文本快照变化（或首次见到）。
   * `userText` = 前面最近的用户消息文本（request 帧的 body）。
   */
  feed(el: Element, userText: string, text: string, now = Date.now()): void {
    if (!text) return
    const cur = this.turns.get(el)
    if (!cur) {
      // 页面重渲染会把 model-response 移除重建 —— 若有个孤儿流的文本是
      // 新文本的前缀（且用户文本一致、还在收编窗口内），收编为同一条流，
      // 绝不另开新轮（另开 = app 里同一条回答劈成两半）。
      const adopt = this.findOrphan(userText, text, now)
      if (adopt) {
        this.turns.delete(adopt.el)
        this.turns.set(el, adopt.turn)
        const delta = text.startsWith(adopt.turn.text)
          ? text.slice(adopt.turn.text.length)
          : ''
        adopt.turn.text = text
        adopt.turn.lastGrewAt = now
        if (delta) this.sink.chunk(adopt.turn.id, delta)
        return
      }
      // 已经 beginTurn 过（用户气泡先出场）⇒ 响应元素认领这轮，只补 chunk，
      // 绝不再出一遍 request（重复 request = 旁路/驱动各记一轮）
      const pend = this.pending
      if (pend && now - pend.at < DOM_TURN_PENDING_MS
        && (!userText || !pend.userText || pend.userText === userText)) {
        this.pending = null
        this.turns.set(el, { id: pend.id, text, lastGrewAt: now, userText: pend.userText })
        this.sink.chunk(pend.id, text)
        return
      }
      const id = this.nextId()
      this.turns.set(el, { id, text, lastGrewAt: now, userText })
      this.sink.request(id, userText)
      this.sink.chunk(id, text)
      return
    }
    if (text.length <= cur.text.length) return // 收缩/等长：不退不重（重渲染抖动）
    const grew = text.startsWith(cur.text) ? text.slice(cur.text.length) : text
    cur.text = text
    cur.lastGrewAt = now
    cur.orphanedAt = undefined
    if (cur.id) {
      if (grew === text) this.sink.reset(cur.id, text)
      else this.sink.chunk(cur.id, grew)
      return
    }
    // seed 占位开始增长（观察中途挂上来的老节点被重新生成）：晋升为真实轮次
    const id = this.nextId()
    cur.id = id
    cur.userText = userText
    this.sink.request(id, userText)
    if (grew === text) this.sink.reset(id, text)
    else this.sink.chunk(id, grew)
  }

  /** 找可收编的孤儿流：同用户文本、文本是前缀、还没出收编窗口 */
  private findOrphan(
    userText: string,
    text: string,
    now: number,
  ): { el: Element; turn: ActiveTurn } | null {
    for (const [el, turn] of this.turns) {
      if (!turn.orphanedAt || !turn.id) continue
      if (now - turn.orphanedAt > DOM_TURN_ORPHAN_MS) continue
      if ((turn.userText || userText) && turn.userText !== userText) continue
      if (!text.startsWith(turn.text)) continue
      return { el, turn }
    }
    return null
  }

  /** 元素被页面移除：先记孤儿（等收编），收口交给 sweep（元素真没了文本不会再长） */
  drop(el: Element, now = Date.now()): void {
    const cur = this.turns.get(el)
    if (!cur) return
    if (!cur.id) {
      this.turns.delete(el)
      return
    }
    cur.orphanedAt = now
  }

  /** 定时扫：无增长超时收口（生成中抑制；强制时限兜底） */
  sweep(now = Date.now()): void {
    // 过期 pending 丢弃（响应元素一直没出现 = 页面没答；驱动侧有自己的超时）
    if (this.pending && now - this.pending.at > DOM_TURN_PENDING_MS) this.pending = null
    const generating = this.isGenerating?.() ?? false
    for (const [el, turn] of [...this.turns]) {
      if (!turn.id) continue
      const idleMs = now - turn.lastGrewAt
      const force = idleMs >= DOM_TURN_FORCE_MS
      if (!force && (generating || idleMs < DOM_TURN_SETTLE_MS)) continue
      this.sink.done(turn.id)
      this.turns.delete(el)
    }
  }
}
