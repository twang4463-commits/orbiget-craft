/**
 * 网页聊天桥 —— **站点无关内核**（隔离世界）。
 *
 * 三个职责：
 * 1. 转发：把 MAIN world 钩子 postMessage 出来的原始流帧转给扩展侧（驱动器）；
 * 2. 命令：响应 WEB_CHAT_PING（登录态/输入框探测）与 WEB_CHAT_SEND（注入 + 发送）；
 * 3. 关联：补全请求体也带出去，驱动器用「请求体包含我发的那段文本」做流归属。
 *
 * 内核不知道任何站点的选择器、产物 DOM 或历史接口 —— 这些全部来自
 * `sites/<site>.ts` 的 `BridgeSiteProfile`，每站打成独立 bundle。这里的
 * 通用能力（可见元素筛选、富文本注入管线、消费判定、防重复、端口广播）
 * 是各站共享的**机制**，不是站点答案。
 *
 * 铁律：任何 DOM 操作失败都收敛成结构化失败（inject-failed / not-submitted），
 * 绝不把异常抛给页面。
 */

import type { BridgeSiteProfile, HistoryPullResult, MediaStatusEntry, SweptMedia } from './types'
import type { WebAttachFile } from '../types'
import {
  deliverAttachments as deliverAttachmentsToPage,
  type AttachDeliveryResult,
} from './attach'
import { activeTurnFrames } from './replay'
import { summarizeBodyShape } from './shape'
import { matchTurnText, turnFingerprint } from './attribution'
import { bumpTurnAttempt, planDuplicateSend, rememberTurnSend, TURN_SEND_TTL_MS, type TurnSendRecord } from './turn-dedupe'
import { WEB_CHAT_LAYER_VERSION } from '../version'

/** 与 MAIN world 钩子约定的消息形状（钩子是哑管道，契约在这两处对齐） */
type HookFrame =
  | { source: 'occ-web-chat'; kind: 'hello'; at: number; version?: string }
  | { source: 'occ-web-chat'; kind: 'request'; requestId: string; body: string }
  | { source: 'occ-web-chat'; kind: 'chunk'; requestId: string; text: string }
  | { source: 'occ-web-chat'; kind: 'reset'; requestId: string; text: string }
  | { source: 'occ-web-chat'; kind: 'done'; requestId: string }
  | { source: 'occ-web-chat'; kind: 'error'; requestId: string; message: string }
  | { source: 'occ-web-chat'; kind: 'response-error'; requestId: string; status: number; contentType: string; preview: string }
  /** 产物动向(2026-10-26):页面拉生成图 CDN —— 无 requestId,广播即可 */
  | { source: 'occ-web-chat'; kind: 'activity'; label: string }
  /** 钩子诊断(2026-10-27):响应头/首块/流结尾 —— 只广播、不进环 */
  | { source: 'occ-web-chat'; kind: 'diag'; requestId?: string; text: string }

/** 桥 → 钩子的控制消息(钩子按 CTL_SOURCE 过滤:probe 补在位证明;
 *  visibility-lie 是发送窗口的可见性谎报开关 —— 后台静默发送用) */
type CtlMessage =
  | { source: 'occ-web-chat-ctl'; kind: 'probe' }
  | { source: 'occ-web-chat-ctl'; kind: 'visibility-lie'; on: boolean }

/** 桥 → 端口的帧:钩子帧 + 旁路标记。`foreign` 只出现在 request 上 ——
 *  true = 不是 App 发的(用户在页面上手动发送),旁路监听器据此收流。 */
type BridgeOutFrame = HookFrame & { foreign?: boolean; shape?: string }
/** 捕获端口的 ACK(2026-10-25 深夜三,投递保证):收到 request 帧后回报 seq,
 *  桥销账;任何端口重连时「未确认 + 最近几轮」一起重放,消息恰好一次送达 */
type BridgeInFrame = { kind: 'ack'; seq: number }

export function installWebChatBridge(profile: BridgeSiteProfile): void {
  // 幂等护栏:探测允许在加载完成的标签上重复注入,双装只会翻倍监听器、双发应答
  const w = window as Window & { __occWebChatBridgeInstalled?: boolean }
  if (w.__occWebChatBridgeInstalled) return
  w.__occWebChatBridgeInstalled = true

  const HOOK_SOURCE = 'occ-web-chat'
  const PORT_NAME = 'occ-web-chat'
  /** 三方版本来自唯一真身（`version.ts`）；连同钩子版本一起报给驱动自愈 */
  const LAYER_VERSION = WEB_CHAT_LAYER_VERSION
  /** 输入框 / 发送键候选 —— **站点答案**，内核不内置任何站点选择器。
   *  哈希类名一律不用；属性优先，页面改版只改该站 profile。 */
  const INPUT_SELECTORS = profile.composerSelectors
  const SEND_BUTTON_SELECTORS = profile.sendButtonSelectors

  /** 所有连上来的端口(驱动器 + 旁路监听器)。单端口会互相顶掉:
   *  监听器一连接,驱动器就收不到本轮流了(2026-10-25 页面接力)。 */
  const ports = new Set<chrome.runtime.Port>()
  /** 钩子在位时间戳(hello 帧;隔离世界先于钩子装载时为空) */
  let hookHelloAt = 0
  /** 钩子自报的版本(hello 帧;旧钩子为空 ⇒ 驱动据此重载标签) */
  let hookVersion = ''
  /** 当前(最近一条)补全请求的帧环形缓冲:驱动器后连上来也能补齐本轮流 */
  const ring: { seq: number; frame: BridgeOutFrame; at: number }[] = []
  let seq = 0
  const RING_LIMIT = 2000
  /** 最近由本桥提交的文本指纹(120 秒)。request 帧据此区分「App 发的」
   *  和「用户在页面上手动发的」——旁路监听只收后者,否则每条消息双份。 */
  const RECENT_SEND_TTL_MS = 120_000
  const recentSends: Array<{ fingerprint: string; at: number }> = []
  /** 「同一轮只发一次」的账本（2026-10-29）：turnId → 已提交的正文指纹 */
  const turnSends = new Map<string, { hash: string; at: number }>()
  /** 「触发过但没确认」的在途账（2026-10-30 豆包真机）：离屏页证据迟到，
   *  上一回报了 not-submitted 页面其实慢半拍提交了；重试再进来先等迟到
   *  证据，绝不立刻重注入 —— 重注入就是页面上的第二条 */
  const turnAttempts = new Map<string, TurnSendRecord>()
  /**
   * 「本轮附件已投递」的账本（2026-10-31）：turnId → 已投递件数。
   *
   * 为什么要记：驱动/会话层都有自动重试，重试会再走一遍投递 ⇒ 页面输入坞
   * 里会多出一份附件（芯片 ×2）。同一轮重投时芯片还在（页面没发送就一直挂着），
   * 所以**不重复投**才是对的。
   *
   * ⚠️ 换标签页 = 换桥实例 = 账本空了 ⇒ 新标签上会重投（那是对的：
   *   新页面里本来就没有芯片）。
   */
  const deliveredAttachments = new Map<string, { count: number; at: number }>()
  /** 「触发过没确认」重进来时的迟到证据宽限窗：要盖住驱动重试轮激活页面后
   *  被节流的 JS 把待发请求真正发出去的耗时 */
  const LATE_EVIDENCE_MS = 8000
  /** 旁路监听器专用端口名:回放规则与驱动器不同(见 replayRecentTurns) */
  const CAPTURE_PORT_NAME = 'occ-web-chat-capture'
  /** 补给窗口:最近 8 轮 / 结束后 30 分钟内(2026-10-25 深夜二:只补一轮
   *  会丢「App 没开/标签晚连上」期间聊的中间轮次;重复由 App 侧去重兜底) */
  const CAPTURE_BACKLOG_TURNS = 8
  const CAPTURE_BACKLOG_TTL_MS = 30 * 60_000
  /** 已发出、待捕获端口确认的 request 帧(ACK 销账;重连时未确认的必重放) */
  const unackedRequests = new Set<number>()
  /**
   * 本轮发送时的产物 key 基线（2026-10-27）：页面同一会话里历史轮次的图片
   * 网格一直躺在 DOM 里，不记基线会把旧图算进本轮占位。发送时快照，
   * 状态查询只返回基线之外的新容器。
   */
  let mediaBaseline: Set<string> | null = null

  /** 广播到所有端口。⚠️ 每个 frame **独立 clone** 给每个端口(2026-10-26
   *  真机踩坑):两个端口在不同 JS 上下文(SW 的工作线程 + App 的页面)时,
   *  **同一对象给第二个 postMessage 会 DataCloneError** —— 第一个克隆后
   *  对象的「可传输」状态被消费,第二发必炸,后连的端口永远收不到帧
   *  (表现:端口连着、日志全对,就是没同步)。clone 一份发一份,零共享。 */
  function broadcastToPorts(frame: BridgeOutFrame): void {
    for (const p of [...ports]) {
      try {
        p.postMessage(
          typeof structuredClone === 'function' ? structuredClone(frame) : JSON.parse(JSON.stringify(frame)),
        )
      } catch {
        // 端口已断:帧留在环形缓冲里;从广播表移除,别反复报错
        ports.delete(p)
      }
    }
  }

  function postToPort(frame: BridgeOutFrame): void {
    if (frame.kind === 'hello') {
      hookHelloAt = frame.at
      hookVersion = frame.version ?? ''
      return
    }
    const wrapped = { seq: ++seq, frame, at: Date.now() }
    ring.push(wrapped)
    if (ring.length > RING_LIMIT) ring.shift()
    if (frame.kind === 'request') unackedRequests.add(wrapped.seq)
    broadcastToPorts(frame)
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Partial<HookFrame> | null
    if (event.source !== window || !data || data.source !== HOOK_SOURCE) return
    if (data.kind === 'hello' || data.kind === 'request' || data.kind === 'chunk' || data.kind === 'reset' || data.kind === 'done' || data.kind === 'error' || data.kind === 'response-error') {
      const frame = data as HookFrame
      // 补全请求一出现就判定归属：请求体里**最后一条 user 消息**是我注入的
      // 文本 = 这一轮是驱动器发的；否则是用户在页面上手动发的(旁路收)。
      // 只比本轮，不比整段 —— 整段必然带着历史(见 isRecentOwnRequest)。
      // 空请求体判不了归属 ⇒ 不标 foreign(旁路只收 true,宁可漏不可重)
      if (frame.kind === 'request' && frame.body) {
        // 请求体形状跟着 request 帧走（只出键名/类型/长度，不出值）：
        // 一轮里常有多条 completion 请求，靠它分辨主正文/标题/建议，
        // 不用逆向页面 JS；跟着帧走，重放时也不会丢。
        postToPort({
          ...frame,
          foreign: !isRecentOwnRequest(frame.body),
          shape: summarizeBodyShape(frame.body),
        })
      } else {
        postToPort(frame)
      }
      return
    }
    // 产物动向 / 钩子诊断：不进环（无回放价值），只广播实时
    if (data.kind === 'activity') {
      broadcastToPorts({ source: HOOK_SOURCE, kind: 'activity', label: String((data as { label?: string }).label ?? '') })
      return
    }
    if (data.kind === 'diag') {
      broadcastToPorts({
        source: HOOK_SOURCE,
        kind: 'diag',
        requestId: (data as { requestId?: string }).requestId,
        text: String((data as { text?: string }).text ?? ''),
      })
    }
  })

  /** 问钩子在不在:装载期 hello 丢失时按需补证(ping 的 hookReady 靠它,不再恒 false) */
  function probeHook(): void {
    try {
      window.postMessage({ source: 'occ-web-chat-ctl', kind: 'probe' } satisfies CtlMessage, '*')
    } catch {
      /* ignore */
    }
  }

  /** 请钩子开/关「完整前台扮装」(后台标签:豆包对不可见文档挂起交互,
   *  含 window.focus/Element.focus 这类前台 API —— 用户点名连 focus 一起骗) */
  function postVisibilityLie(on: boolean): void {
    try {
      window.postMessage({ source: 'occ-web-chat-ctl', kind: 'visibility-lie', on } satisfies CtlMessage, '*')
    } catch {
      /* ignore */
    }
  }

  // ⚠️ 专窗离屏（2026-10-25 引入，2026-10-27 移走）：开窗必须由**扩展页 / SW**
  //    调 `chrome.windows` —— 内容脚本没有这个 API（实测只有 chrome.runtime），
  //    经桥转发开窗永远失败。实现已收进 `web-tab-driver.ts` 的
  //    `acquireOwnedTabDirect()`。

  /**
   * 旁路监听器的回放(2026-10-25 深夜二):驱动器回放**只补未完结**的流(防
   * 假匹配旧请求);旁路要收的是「最近聊过的几轮」—— 监听器常在发送后才
   * 连上(App 4 秒扫描窗,或 App 刚被打开)。规则:最近 8 轮里、结束在
   * 30 分钟内的整段补(在途流照补);重复落账由 App 侧按 requestId 去重。
   */
  /** 给驱动器补最后一个未完结轮次（request + chunks；已完结不补） */
  function replayActiveTurn(port: chrome.runtime.Port): void {
    const frames = activeTurnFrames(ring)
    if (!frames.length) return
    for (const item of frames) {
      try {
        port.postMessage(
          typeof structuredClone === 'function' ? structuredClone(item.frame) : JSON.parse(JSON.stringify(item.frame)),
        )
      } catch {
        return
      }
    }
    console.info('[occ-web-chat] bridge: replay active turn', `${frames.length} frames`)
  }

  function replayRecentTurns(port: chrome.runtime.Port): void {
    const requests = ring.filter(r => r.frame.kind === 'request').slice(-CAPTURE_BACKLOG_TURNS)
    const cutoff = Date.now() - CAPTURE_BACKLOG_TTL_MS
    // 未确认的 request 帧**必重放**(投递保证:上次发出去没人收 = 这次补),
    // 再叠加时间窗口内的最近轮次;App 侧按 requestId 去重,重放不双记
    const eligible = requests.filter(r => r.at >= cutoff || unackedRequests.has(r.seq))
    if (!eligible.length) return
    const firstSeq = eligible[0].seq
    for (const item of ring) {
      if (item.seq < firstSeq) continue
      try {
        // 逐帧 clone(与 postToPort 同理:同帧给两个端口 = DataCloneError,
        // 第二个端口永远收不到 —— 双端口是常态:SW + App 页面各连一份)
        port.postMessage(
          typeof structuredClone === 'function' ? structuredClone(item.frame) : JSON.parse(JSON.stringify(item.frame)),
        )
      } catch {
        return
      }
    }
  }

  chrome.runtime.onConnect.addListener((incoming: chrome.runtime.Port) => {
    // 旁路监听器:独立的回放规则(刚完结的一轮也补),与驱动器互不干扰
    if (incoming.name === CAPTURE_PORT_NAME) {
      ports.add(incoming)
      console.info('[occ-web-chat] bridge: capture port connected, replay recent turns (8 turns / 30min)')
      replayRecentTurns(incoming)
      // ACK:捕获端口收到 request 帧后回报 seq,销掉「未确认」(投递保证)
      incoming.onMessage.addListener((msg: BridgeInFrame) => {
        if (msg?.kind === 'ack' && typeof msg.seq === 'number') unackedRequests.delete(msg.seq)
      })
      incoming.onDisconnect.addListener(() => {
        ports.delete(incoming)
      })
      return
    }
    if (incoming.name !== PORT_NAME) return
    // 多个端口并存:驱动器(发送时连) + 旁路监听器(长驻)。广播/回放
    // 各走各的,互不顶替。
    ports.add(incoming)
    console.info('[occ-web-chat] bridge: driver port connected')
    // 只重放**最后一个未完结轮次**（2026-10-27 豆包真机修正二）：
    // · 整圈历史重放 ⇒ 短文本指纹假匹配已完结的上一轮，驱动等死流；
    // · 完全不重放 ⇒ 页面上轮请求的 chunks 在端口连上之前已广播完，驱动
    //   匹配到 request 却永远收不到正文（表现同样是 45s 超时）。
    // 规则见 `replay.ts`：有 request 且尚无 done/error/response-error 才补。
    replayActiveTurn(incoming)
    incoming.onDisconnect.addListener(() => {
      ports.delete(incoming)
    })
  })

  /** 真渲染在视口里(client rects 非空且有尺寸;display:none/0×0 暗桩都算没渲染) */
  function isRendered(el: HTMLElement): boolean {
    if (el.getClientRects().length === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 20 && rect.height > 8
  }

  /** 候选编辑区是否「容器里带发送键」—— 输入框和发送键通常同属一个容器
   *  (向上走最多 6 层祖先,在每层容器里找发送键候选)。页面上有多个可见
   *  可编辑区时(搜索框/侧栏),这条判别比 DOM 顺序可靠。 */
  function nearSendButton(el: HTMLElement): boolean {
    // 站点给了真身定位器时，判据就以它为准（DeepSeek / 豆包的通用选择器
    // 在真页面上命中数为 0 —— 靠选择器表判「这个输入框旁边有没有发送键」
    // 会一律判否 ⇒ 输入框挑错）。
    if (profile.findSendButton) {
      try {
        const found = profile.findSendButton(document)
        if (found) {
          let cur: HTMLElement | null = el
          for (let depth = 0; depth < 6 && cur; depth += 1) {
            if (cur.contains(found)) return true
            cur = cur.parentElement
          }
          return false
        }
      } catch {
        /* 读挂了 ⇒ 落到选择器表 */
      }
    }
    let cur: HTMLElement | null = el
    for (let depth = 0; depth < 6 && cur; depth += 1) {
      for (const selector of SEND_BUTTON_SELECTORS) {
        if (cur.querySelector(selector)) return true
      }
      cur = cur.parentElement
    }
    return false
  }

  /** 最近一次定位到的输入框描述(标签 + 命中的 selector)—— 发送日志带出来,
   *  真机排查时直接看「我们到底在往哪儿注」,不用猜。 */
  let lastComposerDesc = ''
  /** 最近一次命中的发送键(selector + 标签/aria)—— 打点用 */
  let lastSendButtonDesc = ''

  /**
   * 找主输入框。三层判别(2026-10-24 真机豆包层层踩出来):
   * ① querySelectorAll 而不是 querySelector —— 第一个匹配常是不可见暗桩;
   * ② 只认**可见的**(client rects + 尺寸);
   * ③ 多个可见候选时,优先**容器里带发送键**的那个(= 聊天输入区本尊)。
   */
  function findInput(): HTMLTextAreaElement | HTMLElement | null {
    const candidates: Array<{ el: HTMLElement; selector: string; index: number }> = []
    INPUT_SELECTORS.forEach((selector, index) => {
      for (const el of document.querySelectorAll<HTMLElement>(selector)) {
        if (isRendered(el)) candidates.push({ el, selector, index })
      }
    })
    const picked = candidates.find(c => nearSendButton(c.el)) ?? candidates[0]
    lastComposerDesc = picked
      ? `${picked.el.tagName.toLowerCase()} (${picked.selector})`
      : ''
    lastComposerSelectorIndex = picked?.index ?? -1
    return picked?.el ?? null
  }

  /** 最近一次 findInput 命中的选择器序号（-1 = 没找到）。
   *  0 = 站点的**主**编辑器；>0 = 兜底选择器 —— 兜底命中但主选择器在 DOM
   *  里又没渲染时，多半是主编辑器还没 hydrate（Gemini 真机 2026-10-31：
   *  文本灌进了暗桩 textarea，点真发送键，空编辑器按兵不动）。 */
  let lastComposerSelectorIndex = -1

  /**
   * 找输入框，但**兜底命中时先等主编辑器**。
   *
   * 主选择器在 DOM 里有节点、只是还没渲染（Angular/React 组件未挂载完）⇒
   * 轮询等它渲染；等到超时（主选择器压根不存在/就是不渲染）才放行兜底。
   * 只有「picked = 主选择器」或「主选择器 DOM 里根本没有」时零等待直通，
   * 对现有站点（主选择器即刻渲染）是无损快路径。
   */
  async function findInputWhenPrimaryReady(waitMs = 5000): Promise<HTMLTextAreaElement | HTMLElement | null> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const input = findInput()
      if (!input) return null
      if (lastComposerSelectorIndex === 0) return input
      const primaryInDom = document.querySelector(INPUT_SELECTORS[0]) != null
      if (!primaryInDom || Date.now() > deadline) {
        if (lastComposerSelectorIndex > 0 && primaryInDom) {
          console.warn('[occ-web-chat] bridge send: 主编辑器未渲染,超时放行兜底 composer =', lastComposerDesc)
        }
        return input
      }
      await sleep(250)
    }
  }

  /**
   * 注入成功的判据（可升级，2026-10-31 Gemini 真机）。
   *
   * 缺省：DOM 里出现了文本就算落账（paste/execCommand/合成事件三选一）。
   * 站点开 `verifySendButtonUnlock` 后：落账还要**等到发送键出现** ——
   * 有些框架（Gemini 的合成 paste）文本只进 DOM 不进模型，发送键永远
   * 不亮，拿着假落账去点按钮就是白点。等不到就换下一种手法。
   */
  async function injectionTakesEffect(budgetMs: number): Promise<boolean> {
    if (profile.verifySendButtonUnlock !== true) return true
    const deadline = Date.now() + budgetMs
    for (;;) {
      if (findSendButton()) return true
      if (Date.now() > deadline) return false
      await sleep(150)
    }
  }

  /**
   * 注入文本并让页面框架感知。
   * textarea:React 受控组件必须走原型链上的原生 value setter,直接赋值会被
   * React 的 value tracker 吃掉(onChange 不触发,界面看着填进去了实际没进状态)。
   * contenteditable:execCommand 走真实编辑管线,框架一定感知。
   */
  async function injectText(input: HTMLTextAreaElement | HTMLElement, text: string): Promise<boolean> {
    try {
      input.focus()
      if (input instanceof HTMLTextAreaElement) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        if (nativeSetter) {
          nativeSetter.call(input, text)
        } else {
          input.value = text
        }
        input.selectionStart = input.selectionEnd = input.value.length
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return input.value === text
      }
      if (input.getAttribute('contenteditable') === 'true' || input.getAttribute('contenteditable') === 'plaintext-only') {
        const selection = window.getSelection()
        const range = document.createRange()
        // ⑨ paste **替换**注入(2026-10-25 实验室定案,千问 Slate 实测):
        // 选全 + 合成粘贴 = **整框替换** —— 上次失败注入留下的 DOM-only
        // 残渣被一并换掉(自愈)、幂等天然成立(替换语义,重复注入不叠加;
        // 此前「文本已在框里就跳过」的护栏在残框上反而挡住救援,已废)、
        // 文本进**模型**(发送键解锁,千问实测按钮 disabled 解除、点发送
        // 即出补全请求)。Slate/Lexical 的 paste 管道不校验 isTrusted。
        range.selectNodeContents(input)
        selection?.removeAllRanges()
        selection?.addRange(range)
        if (injectTextViaPaste(input, text)) {
          if (await injectionTakesEffect(2500)) {
            console.info('[occ-web-chat] bridge inject: paste 替换落账')
            return true
          }
          console.info('[occ-web-chat] bridge inject: paste 只进了 DOM,发送键没解锁 ⇒ 换 execCommand')
        }
        // 兜底 1:execCommand —— **保持选全**直接 insertText(替换语义,
        // 2026-10-25 千问真机修正:paste 在隐藏文档不落账时退到这里,
        // 收尾追加会在残框上把文本翻倍;选全替换天然幂等)。对 Slate 只
        // 污染 DOM(模型不认,发送键锁死)—— 那类站 paste 已在上一步成
        // 功,或需要驱动器把页面带到前台(见 spec.activateOncePerSession)。
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.execCommand('insertText', false, text)
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        // 富文本把换行拆成块级元素,textContent 直接拼(无分隔符)⇒
        // 带换行的原文用 includes 永远对不上;两边去掉全部空白再比
        if (stripWs(input.textContent || '').includes(stripWs(text.slice(0, 40)))) {
          if (await injectionTakesEffect(2500)) {
            console.info('[occ-web-chat] bridge inject: execCommand 落账')
            return true
          }
          console.info('[occ-web-chat] bridge inject: execCommand 同样只进 DOM ⇒ 换合成事件')
        }
        // execCommand 没落账(后台标签:编辑器把 DOM 直改当来路不明的突变
        // 回滚了)→ 合成 insertText 事件让编辑器走自己的管线落账
        const viaEvents = injectTextViaEvents(input, text)
        if (viaEvents && await injectionTakesEffect(2500)) {
          console.info('[occ-web-chat] bridge inject: 合成事件落账')
          return true
        }
        return false
      }
      return false
    } catch {
      return false
    }
  }

  /** 合成 paste 注入(⑨,2026-10-25 实验室定案):调用前已选全(见
   *  injectText),Slate/Lexical 的 paste 管道认合成 ClipboardEvent
   *  (不校验 isTrusted,只读 clipboardData)—— 对选中范围做**替换**,
   *  文本进模型而非只进 DOM:React 状态同步、发送键解锁、残渣自愈。
   *  千问实测:替换后按钮 disabled 解除,点发送即出补全请求。落账标准
   *  与其他路径一致:DOM 里真出现了文本才算。 */
  function injectTextViaPaste(input: HTMLElement, text: string): boolean {
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
      return stripWs(input.textContent || '').includes(stripWs(text.slice(0, 40)))
    } catch {
      return false
    }
  }

  /**
   * 附件投递（2026-10-31 真机）：把 File 交给**页面自己的**上传管线。
   *
   * 内核在 `capture/attach.ts`（站点无关，可单测）；这里只把桥的能力
   * （找输入框、等）接上去，并读站点答案（手法/判据）。
   */
  async function deliverAttachments(files: WebAttachFile[]): Promise<AttachDeliveryResult> {
    const spec = profile.attachments
    if (!spec) return { ok: false, reason: 'attachments-unsupported' }
    // 先等输入框就位（页面刚挂载时可能还没有）——找得到才投
    await findInputWhenPrimaryReady()
    return deliverAttachmentsToPage(files, {
      mode: spec.mode,
      detect: spec.detect,
      settleMs: spec.settleMs,
      findInput: () => findInput(),
      sleep,
    })
  }

  /** 合成 insertText 事件注入(后台救援,2026-10-25):真机豆包后台日志
   *  round 1 not consumed 后 round 2/3 inject failed —— execCommand 改了
   *  DOM,但 Lexical/ProseMirror 系编辑器不认这笔「来路不明的变更」,把
   *  文本回滚掉了。改派 beforeinput/input(inputType=insertText)让编辑器
   *  **自己**落账,不依赖 document.hasFocus();验证标准与 execCommand
   *  路径一致 —— DOM 里真出现了文本才算数。 */
  function injectTextViaEvents(input: HTMLElement, text: string): boolean {
    try {
      const init: InputEventInit = { bubbles: true, cancelable: true, inputType: 'insertText', data: text }
      input.dispatchEvent(new InputEvent('beforeinput', init))
      input.dispatchEvent(new InputEvent('input', init))
      return stripWs(input.textContent || '').includes(stripWs(text.slice(0, 40)))
    } catch {
      return false
    }
  }

  /** 注入分派：站点有专属策略就用它，否则走通用管线。 */
  async function injectForSite(input: HTMLTextAreaElement | HTMLElement, text: string): Promise<boolean> {
    if (profile.injectText) {
      try {
        return profile.injectText(input, text)
      } catch {
        return false
      }
    }
    return injectText(input, text)
  }

  function stripWs(s: string): string {
    return s.replace(/\s+/g, '')
  }

  /** 敲一轮键(⑧,2026-10-25 千问真机):有些站点的发送键要**编辑器收过
   *  键盘事件**才解锁 —— 文本落了 DOM、状态机没记账,点按钮/Enter 都按兵
   *  不动。敲 'a'(down/press/up 全链)点亮「已敲键」。
   *  ⚠️ 退格是**条件式**的:只有站点真把合成 keypress 落了账(内容 +1,
   *  说明它的事件通路认合成键)才敲 Backspace 清理 —— 盲敲会把真文本删掉
   *  一个字符(ProseMirror 系把删除直挂 keydown keymap,不理合成插入,
   *  「插入 +1、删除 -1」的净零假设不成立,消息尾巴会缺字、指纹对不上)。
   *  站点完全不理合成键时这一敲什么都不做 —— 与现状等价,无损。 */
  function touchComposerWithKeystroke(input: HTMLTextAreaElement | HTMLElement): void {
    try {
      const tap = (type: 'keydown' | 'keypress' | 'keyup', key: string, code: string, keyCode: number): void => {
        input.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }))
      }
      const before = stripWs(input.textContent || '')
      tap('keydown', 'a', 'KeyA', 65)
      tap('keypress', 'a', 'KeyA', 65)
      tap('keyup', 'a', 'KeyA', 65)
      if (stripWs(input.textContent || '').length > before.length) {
        // 站点把 'a' 真插进来了 ⇒ 同一条事件通路上的退格也归它管,敲掉这个 'a'
        tap('keydown', 'Backspace', 'Backspace', 8)
        tap('keyup', 'Backspace', 'Backspace', 8)
        if (stripWs(input.textContent || '').length > before.length) {
          // 退格路径没删干净:execCommand delete 走真实编辑管线补一刀
          document.execCommand('delete', false)
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** JSON 里的全部字符串值(嵌套 JSON 字符串解两层 —— 与驱动器
   *  requestBodyMatches 同口径:豆包把正文放在
   *  messages[0].content = JSON.stringify({text}) 里,不解开指纹对不上) */
  function collectStrings(value: unknown, out: string[], depth: number): void {
    if (typeof value === 'string') {
      out.push(value)
      if (depth < 2 && value.length > 1 && (value.startsWith('{') || value.startsWith('['))) {
        try {
          collectStrings(JSON.parse(value), out, depth + 1)
        } catch {
          /* 不是 JSON 字符串就到此为止 */
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, out, depth)
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) collectStrings(item, out, depth)
    }
  }

  /** 解码 \uXXXX / HTML 实体(Gemini 请求体的文本编码形态;与驱动器同口径) */
  function decodeEscapedText(s: string): string {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#x([0-9a-fA-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  }

  /** 请求体里是否带着本轮文本(去空白后缀指纹,取结尾 —— 开头是每轮一样的回放导语) */
  function requestBodyHasFp(body: string, fingerprint: string): boolean {
    // 空指纹不该用来判归属（`includes('')` 恒真）；调用方本就不该记空指纹，
    // 这里再兜一层（2026-10-31 纯附件轮）。
    if (!fingerprint.trim()) return false
    const strings: string[] = []
    try {
      collectStrings(JSON.parse(body), strings, 0)
    } catch {
      strings.push(body)
    }
    // 解转义是站点答案（Gemini 的编码形态），不是全局行为
    const texts = profile.decodeEscapedFingerprint ? strings.map(decodeEscapedText) : strings
    return stripWs(texts.join('')).includes(fingerprint)
  }

  /** 记下本轮 App 要发的文本(每次触发前调用;指纹口径与 requestBodyHasFp 一致) */
  function rememberSend(text: string): void {
    const fingerprint = turnFingerprint(text)
    if (!fingerprint) return
    const now = Date.now()
    recentSends.push({ fingerprint, at: now })
    for (let i = recentSends.length - 1; i >= 0; i -= 1) {
      if (now - recentSends[i].at > RECENT_SEND_TTL_MS) recentSends.splice(i, 1)
    }
  }

  /** 请求体是否命中「最近一次 App 发送」(命中 = 这一轮是自己发的)。
   *
   *  ⚠️ 2026-10-27 真机修正：**不能**拿「整段请求体包含指纹」当判据 ——
   *  站点每轮都把整条线程重发，历史里必然有 App 上一轮发过的那句 ⇒
   *  用户在页面上手动追问的那一轮被误判成「App 自己发的」⇒ 旁路整轮
   *  丢弃（现象就是「我在 DeepSeek 界面聊天，本地不同步」）。归属只看
   *  **本轮**：请求体里最后一条 user 消息 == 我注入的文本。 */
  /** 明文体 body（非 JSON，2026-10-31 Gemini DOM 兜底帧的形态） */
  function isPlainBody(body: string): boolean {
    try {
      JSON.parse(body)
      return false
    } catch {
      return true
    }
  }

  function isRecentOwnRequest(body: string): boolean {
    if (!body) return false
    const now = Date.now()
    for (let i = recentSends.length - 1; i >= 0; i -= 1) {
      const send = recentSends[i]
      if (now - send.at > RECENT_SEND_TTL_MS) {
        recentSends.splice(i, 1)
        continue
      }
      const verdict = matchTurnText(body, send.fingerprint)
      if (verdict === 'match') return true
      // 解不出本轮文本(未知请求体形状)才退回整段包含：宁可漏，不可重
      if (verdict === 'unknown' && requestBodyHasFp(body, send.fingerprint)) return true
      // DOM 明文帧(2026-10-31 Gemini)：渲染后的用户消息会被 markdown 化改写
      // （星号变粗体、换行重排），尾部指纹逐字比对会 mismatch ⇒ App 注入的
      // 回放被误判成手动轮、整段贴进 app 会话（真机 09:10）。明文体（非
      // JSON）退整段包含：代价是「手动重发同文本」被并进 App 轮 —— 可接受。
      if (verdict === 'mismatch' && isPlainBody(body) && requestBodyHasFp(body, send.fingerprint)) return true
    }
    return false
  }

  /** 网络级提交证据(⑦,防重复的基石):自某一起点(seq)起,钩子捕到的
   *  补全请求帧里是否已出现本轮文本。请求只在页面**真的提交之后**才存在
   *  —— 拿到它就不许再触发(重发 = 页面上的第二条);比「输入框被清空」
   *  可靠(清空慢/换节点都会漏报,真机豆包 2026-10-25)。
   *  同样只认「本轮」:整段包含会被历史里的旧轮骗过(2026-10-27)。 */
  function requestWithTextSince(fromSeq: number, text: string): boolean {
    const fingerprint = turnFingerprint(text)
    for (const item of ring) {
      if (item.seq <= fromSeq) continue
      if (item.frame.kind !== 'request') continue
      const verdict = matchTurnText(item.frame.body, fingerprint)
      if (verdict === 'match') return true
      if (verdict === 'unknown' && requestBodyHasFp(item.frame.body, fingerprint)) return true
    }
    return false
  }

  /** 某起点之后是否出现过**任意**补全请求帧。只用于「提交证据」，
   *  不做归属判定 —— 归属仍由驱动按指纹匹配。 */
  function completionRequestSince(fromSeq: number): boolean {
    return ring.some(item => item.seq > fromSeq && item.frame.kind === 'request')
  }

  /** 找到可点的发送键(存在且未禁用;div[role=button] 没有 disabled 属性 ——
   *  undefined 视为可点,点错由消费核实兜底) */
  function findSendButton(): HTMLElement | null {
    // ① 站点给的**真身定位**优先（2026-10-31）：DeepSeek / 豆包的发送键都是
    //    自定义控件，通用选择器表在真页面上命中数为 0。
    if (profile.findSendButton) {
      try {
        const found = profile.findSendButton(document)
        if (found && !(found as HTMLButtonElement).disabled) {
          lastSendButtonDesc = `site-finder <${found.tagName.toLowerCase()}>`
          return found
        }
      } catch {
        /* 站点定位器读挂了 ⇒ 落到选择器表 */
      }
    }
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = document.querySelector<HTMLElement>(selector)
      if (button && !(button as HTMLButtonElement).disabled) {
        const label = button.getAttribute('aria-label') || button.textContent?.trim().slice(0, 24) || ''
        lastSendButtonDesc = `${selector} <${button.tagName.toLowerCase()}>${label ? ` "${label}"` : ''}`
        return button
      }
    }
    lastSendButtonDesc = ''
    return null
  }

  /**
   * 触发发送。preferEnter:走键盘路径(不找按钮)。
   * 两条路交替重试是刻意的:刚弹出的页面 React 常常还没接管按钮的点击监听
   * (输入框在、值也注进去了,点按钮却丢事件);Enter keydown 走的是另一条
   * 事件通路 —— 2026-10-24 真机「首次弹出必失败、第二轮才成」就是这么救回来的。
   * 后台标签里合成 click 前先补全指针事件序列(2026-10-25):有的发送键
   * 监听 pointerdown/up(命中测试/按压态),孤零零一个 click 不走通。
   * ⚠️ reallyHidden 用**谎报前**的真实可见性(2026-10-25 千问轮修):可见性
   * 谎报开启后 document.visibilityState 恒读 'visible',用它会把自己骗过
   * 去 —— 真隐藏标签的指针序列永远不补。
   */
  function triggerSend(input: HTMLTextAreaElement | HTMLElement, preferEnter = false, reallyHidden = false): boolean {
    if (!preferEnter) {
      const button = findSendButton()
      if (button) {
        if (reallyHidden) firePointerSequence(button)
        button.click()
        return true
      }
    }
    // 兜底:对输入框派发 Enter。React 合成事件不校验 isTrusted,能生效。
    // 三连发(2026-10-25 千问真机):只发 keydown 不够 —— 站点在 keypress
    // 上等回车,补齐 keydown→keypress→keyup 全链
    const enterInit: KeyboardEventInit = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }
    input.dispatchEvent(new KeyboardEvent('keydown', enterInit))
    input.dispatchEvent(new KeyboardEvent('keypress', enterInit))
    input.dispatchEvent(new KeyboardEvent('keyup', enterInit))
    return true
  }

  /** 合成 pointerdown→mousedown→pointerup→mouseup 全序列(元素中心点),
   *  只在后台发送时补 —— 治「发送键只认指针事件链」的后台挂起 */
  function firePointerSequence(el: HTMLElement): void {
    try {
      const rect = el.getBoundingClientRect()
      const base: PointerEventInit & MouseEventInit = {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse',
      }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    } catch {
      /* ignore */
    }
  }

  /** 输入框里是否还躺着本轮文本(= 页面还没消费它;富文本换行拆块,去空白比) */
  function inputStillHolds(input: HTMLTextAreaElement | HTMLElement, text: string): boolean {
    return input instanceof HTMLTextAreaElement
      ? input.value.trim() === text.trim()
      : stripWs(input.textContent || '').includes(stripWs(text.slice(0, 40)))
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * DOM 扫「已生成完的媒体」—— **站点答案**。
   * 豆包的 testid 网格、ChatGPT 的助手气泡图都在各自 profile 里；
   * 内核只负责调用与兜错。旧轮次的元素由调用方 prime 打底 + seen-key 排除。
   */
  function sweepGeneratedImages(): SweptMedia[] {
    try {
      return profile.sweepMedia?.(document) ?? []
    } catch {
      return []
    }
  }

  /** 等页面消费输入。三条消费证据,任一成立 = 已提交(⑦):
   *  ① 输入框不再持有本轮文本(原有判定);
   *  ② 输入框节点被页面换掉(isConnected=false —— React 提交后重渲染常整个
   *     换节点;脱离文档的旧节点 textContent 冻结,永读「文本还在」)⇒ 换
   *     当前输入框复查,新框没有文本 = 已消费;
   *  ③ 网络证据:本轮触发后补全请求帧里出现本轮文本 —— 请求只在提交后存在,
   *     输入框清空慢/换节点都骗不过它。到点三条都没中 = false。 */
  async function waitForConsumption(
    input: HTMLTextAreaElement | HTMLElement,
    text: string,
    budgetMs: number,
    triggeredSeq: number,
  ): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs) {
      await sleep(150)
      if (profile.requireRequestEvidence === true) {
        // 只认「真的发了补全请求」；正文指纹是否匹配交给驱动做归属，
        // 不在这里卡 —— 指纹解析漂移时也不能因此再发第二次。
        if (completionRequestSince(triggeredSeq)) return true
        continue
      }
      if (!inputStillHolds(input, text)) return true
      if (!input.isConnected) {
        const fresh = findInput()
        if (!fresh || !inputStillHolds(fresh, text)) return true
      }
      if (requestWithTextSince(triggeredSeq, text)) return true
    }
    return false
  }

  /**
   * 等「迟到的提交证据」（2026-10-30 豆包真机）：上一轮触发过但没确认，
   * 重试又进来时先给宽限窗轮询 —— 请求帧出现 / 当前输入框不再持有本轮
   * 文本，任一成立 = 上次触发其实有效，绝不能再注入。
   *
   * ⚠️ 这里整圈扫描（fromSeq=0）是安全的：本函数只会在**同一个 turnId**
   *  触过之后被调用（见 WEB_CHAT_SEND 的 await-evidence 分支），任何
   *  匹配请求都是这一逻辑轮自己的；与 2026-10-27 禁整圈扫描的场景
   * （新的一轮、同样的文本）不冲突 —— 那种情况 turnId 不同，进不来。
   */
  async function waitForLateEvidence(text: string, budgetMs: number): Promise<boolean> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs) {
      await sleep(300)
      if (profile.requireRequestEvidence === true) {
        if (completionRequestSince(0)) return true
        continue
      }
      if (requestWithTextSince(0, text)) return true
      const fresh = findInput()
      if (fresh && !inputStillHolds(fresh, text)) return true
    }
    return false
  }

  /**
   * 会话历史拉取 —— **站点答案**（只有支持会话接口的站点提供实现）。
   * 内核只负责调用与兜错；原始 JSON 的映射在扩展侧 history-pull.ts。
   */
  function pullConversationHistory(): Promise<HistoryPullResult> {
    try {
      return profile.pullHistory?.() ?? Promise.resolve({ ok: false, error: 'unsupported' })
    } catch (err) {
      return Promise.resolve({ ok: false, error: `fetch-failed:${err instanceof Error ? err.message : String(err)}` })
    }
  }

  chrome.runtime.onMessage.addListener((message: { type?: string; text?: string; turnId?: string; protocolId?: string; homeUrl?: string; quick?: boolean; waitLong?: boolean; waitMs?: number; files?: WebAttachFile[] }, _sender, sendResponse) => {
    /**
     * 附件投递（2026-10-31）：驱动先把本轮的图/文档摘出来发这条命令，
     * 桥再合成事件交给页面上传管线 —— **必须在 WEB_CHAT_SEND 之前**，
     * 否则文字先到、图后到，模型可能压根没看见图。
     */
    if (message?.type === 'WEB_CHAT_ATTACH' && Array.isArray(message.files)) {
      const attachTurnId = typeof message.turnId === 'string' ? message.turnId : ''
      const already = attachTurnId ? deliveredAttachments.get(attachTurnId) : undefined
      if (already) {
        // 同一轮重投：芯片还在输入坞里（页面没发送就一直挂着）⇒ 不重复投
        console.info('[occ-web-chat] bridge attach: 本轮已投过,不重复投递', attachTurnId)
        sendResponse({ ok: true, reused: true, delivered: already.count })
        return true
      }
      void deliverAttachments(message.files).then((result) => {
        if (result.ok && attachTurnId) {
          const now = Date.now()
          for (const [id, rec] of deliveredAttachments) {
            if (now - rec.at > TURN_SEND_TTL_MS) deliveredAttachments.delete(id)
          }
          deliveredAttachments.set(attachTurnId, { count: result.delivered ?? 0, at: now })
        }
        console.info('[occ-web-chat] bridge attach:', JSON.stringify(result))
        sendResponse(result)
      })
      return true
    }
    if (message?.type === 'WEB_CHAT_PULL_HISTORY') {
      void Promise.resolve()
        .then(pullConversationHistory)
        .then(sendResponse)
      return true
    }
    if (message?.type === 'WEB_CHAT_SWEEP_IMAGES') {
      // 产物收割(§6.14):quick(轮开始时打底)只扫一遍立即回;常规(轮结束
      // 收割)**轮询到 DOM 稳定**再回 ——
      // · 每 1.2s 扫一遍;签名(key 串)变了 = 图在换/在多,稳定计数清零;
      // · 连续 3 轮无变化提前收工;
      // · waitLong(流里有 gen_image 痕迹,图可能比文字晚到 20s+,2026-10-26
      //   真机换棍子猴轮):图还没出现就不算稳定,最多等 28s;
      // · **返回最终态快照**(最后一遍扫描结果)而非历史并集 —— 豆包内部会
      //   先出一版再换最终版,并集会把候选+终版都当答案(真机:页面 1 张、
      //   脑洞 2 张近似图)。
      // 应答自带 location.href —— 调用方(驱动器/旁路)要的「会话地址」。
      ;(async () => {
        try {
          const first = sweepGeneratedImages()
          if (message.quick) {
            sendResponse({ ok: true, images: first, url: location.href })
            return
          }
          const deadline = Date.now() + (message.waitMs ?? (message.waitLong === true ? 28_000 : 7_200))
          let current = first.slice()
          let signature = first.map(item => item.key).join('|')
          let stableRounds = 0
          while (Date.now() < deadline) {
            await sleep(1200)
            const now = sweepGeneratedImages()
            const nowSignature = now.map(item => item.key).join('|')
            if (nowSignature !== signature) {
              current = now.slice()
              signature = nowSignature
              stableRounds = 0
            } else {
              stableRounds += 1
            }
            // 等图模式:一张都还没有 = 生图未完,继续等(不计稳定)
            if (message.waitLong === true && current.length === 0) {
              stableRounds = 0
              continue
            }
            if (stableRounds >= 3) break
          }
          sendResponse({
            ok: true,
            images: current.slice(0, 12),
            url: location.href,
          })
        } catch {
          sendResponse({ ok: false, images: [] })
        }
      })()
      return true
    }
    if (message?.type === 'WEB_CHAT_PING') {
      // 先向钩子要一张在位证明,短暂等回音再答(hello 回得来 ⇒ fetch 包装真在 MAIN world)。
      // 异步应答必须 return true,定时器保证一定会答。
      probeHook()
      setTimeout(() => {
        const input = findInput()
        const pong = {
          ok: true,
          hasInput: !!input,
          url: location.href,
          hookReady: hookHelloAt > 0,
          // 版本自愈:扩展重载后旧页面里的钩子/桥不会自动更新
          layerVersion: LAYER_VERSION,
          hookVersion,
          // ready 门:文档加载完才算「页面就绪」—— 驱动器对新开标签等这个信号,
          // 输入框在 ≠ 可交互(见 WEB_CHAT_SEND 的轮换触发注释)
          settled: document.readyState === 'complete',
        }
        console.info('[occ-web-chat] bridge ping', pong)
        sendResponse(pong)
      }, 150)
      return true
    }
    if (message?.type === 'WEB_CHAT_MEDIA_STATUS') {
      let entries: MediaStatusEntry[] = []
      try {
        entries = profile.readMediaStatus?.(document) ?? []
      } catch {
        entries = []
      }
      const baseline = mediaBaseline ?? new Set<string>()
      sendResponse({
        ok: true,
        items: entries.filter((entry) => !baseline.has(entry.key)),
      })
      return false
    }
    if (message?.type === 'WEB_CHAT_SEND' && typeof message.text === 'string') {
      const text = message.text
      /**
       * 跨重试稳定的轮次 id（2026-10-29）：同一轮已经提交过就直接回 `reused`，
       * 不再注入 —— 驱动/会话层的自动重试会再走一次这里，重注入就是页面上
       * 两条一样的用户消息（用户已遇到多次，DeepSeek）。
       */
      const turnId = typeof message.turnId === 'string' ? message.turnId : ''
      const textHash = turnFingerprint(text)
      const dupPlan = planDuplicateSend(turnSends, turnAttempts, turnId, textHash)
      if (dupPlan === 'reused') {
        console.info('[occ-web-chat] bridge send: 同一轮已经提交过 ⇒ 不重复注入', turnId)
        sendResponse({ ok: true, reused: true })
        return true
      }
      /**
       * 注入次数到顶（2026-10-31「不停重试」）：这一轮已经往页面上送过
       * `TURN_MAX_INJECTIONS` 次，页面始终没给提交证据。继续注入＝在页面上刷
       * 第三条一模一样的用户消息（用户真机截图正是三条），而「收没收下」靠
       * 继续添加气泡是证不出来的 ⇒ 直接判失败交驱动报错，让人看得见。
       */
      if (dupPlan === 'exhausted') {
        console.warn('[occ-web-chat] bridge send: 本轮已注入到顶,不再重试',
          turnId, `attempts=${turnAttempts.get(turnId)?.n ?? '?'}`)
        sendResponse({ ok: false, reason: 'not-submitted' })
        return true
      }
      // 先记产物基线：发送前就存在的容器 = 历史轮次，不参与本轮占位
      if (profile.readMediaStatus) {
        try {
          mediaBaseline = new Set(profile.readMediaStatus(document).map((entry) => entry.key))
        } catch {
          mediaBaseline = new Set()
        }
      }
      ;(async () => {
        let responded = false
        const respond = (payload: { ok: boolean; reason?: string; reused?: boolean }): void => {
          if (responded) return
          responded = true
          // 只有「真的提交成功」才记账：not-submitted 的重试必须允许重新注入
          if (payload.ok && turnId) rememberTurnSend(turnSends, turnId, textHash)
          sendResponse(payload)
        }
        console.info('[occ-web-chat] bridge send: composer =', lastComposerDesc || '(not found)',
          `len=${text.length}`, `visibility=${document.visibilityState}`)
        /** 最近一次触发的环形缓冲 seq 快照:网络级提交证据从这之后找(⑦) */
        let triggeredSeq = 0
        /** 「页面已提交」的终局判定:网络证据在,或当前输入框已不含本轮文本 */
        const submitted = (): boolean => {
          // Gemini 这类站点：DOM 清空可能是编辑器重渲染/回滚，不算提交；
          // 只认触发之后真的出现过补全请求（指纹匹配归驱动，不在此卡）。
          if (profile.requireRequestEvidence === true) return completionRequestSince(triggeredSeq)
          if (requestWithTextSince(triggeredSeq, text)) return true
          const fresh = findInput()
          return fresh != null && !inputStillHolds(fresh, text)
        }
        // ⚠️ 这里**不能**拿整圈历史帧做「已提交」判断（2026-10-27 豆包真机）：
        // 旧实现 `requestWithTextSince(0, text)` 会在发送前扫描桥的环形缓冲，
        // 用户重复发同一段话时上一轮的补全请求还躺在环里 ⇒ 被误判成「本轮已
        // 提交」⇒ 直接 return ok、页面根本没发新请求 ⇒ 驱动干等 45s 报
        // 「网页端点响应超时」。
        // 跨轮重复的判据归驱动：它在发之前已经连好端口，若上一轮迟到的请求
        // 真的到了，`matchedRequestId` 会被置上，驱动自己跳过发送。
        //
        // 「触发过但没确认」的宽限窗（2026-10-30 豆包真机「还是两条」）：
        // 离屏页定时器被节流，上一轮的已提交证据比验证窗慢 —— 我们报了
        // not-submitted，页面其实慢半拍提交了。此刻立刻重注入 = 页面上的
        // 第二条。先等迟到证据：命中 ⇒ 按 reused 收口；宽限期无证据 ⇒
        // 上次触发真丢了（React 未接管），放行下面的正常重发。
        if (dupPlan === 'await-evidence') {
          if (await waitForLateEvidence(text, LATE_EVIDENCE_MS)) {
            console.info('[occ-web-chat] bridge send: 迟到证据在 —— 上一轮其实已提交,按 reused 收口(防重复)', turnId)
            respond({ ok: true, reused: true })
            return
          }
          console.info('[occ-web-chat] bridge send: 宽限期无提交证据 —— 上次触发真丢了,允许重发', turnId)
        }
        // 后台标签:请钩子在发送窗口内谎报可见性/焦点(豆包对不可见文档挂起
        // 交互 —— 编辑器不落账输入);发送结束/异常一律撤销(finally)
        const wasHidden = profile.needsVisibilityLie === true && document.visibilityState === 'hidden'
        if (wasHidden) {
          postVisibilityLie(true)
          // ctl 是 postMessage 异步送达,留一拍让谎报先生效再开打
          await sleep(60)
        }
        // 发送循环:每轮 = 重注入(幂等,旧文本还在就覆盖)→ 触发(按钮/Enter
        // 交替)→ 等页面消费。只认「输入框被页面清空/请求帧出现」为提交成功
        // —— 比「点了按钮」可信(点丢了自己不知道)。
        // 2026-10-29：1.2s 的验证窗对 DeepSeek 偏短 —— 页面清输入框/发请求
        // 慢一点就会被判成「没消费」，round 1 再触发一次 ⇒ 页面上两条。放宽
        // 到 2.5s，只留一轮重试；跨调用再由 turnId 账本兜底。
        // 2026-10-30：隐藏/离屏页（节流）**只触发一次**、验证窗放宽到 6s ——
        // 证据慢是常态，补枪就是第二条；「点击真丢了」的恢复交给驱动重试轮
        // （强制前台 + 上面的迟到证据宽限窗），不在隐藏页里硬补。
        const SEND_ROUNDS = wasHidden ? 1 : 2
        const ROUND_VERIFY_MS = wasHidden ? 6000 : 2500
        try {
        for (let round = 0; round < SEND_ROUNDS; round += 1) {
          // 轮间查账(⑦,重触发前先对账):上一轮触发后页面其实已提交
          // (请求帧出现/输入框已清)⇒ 本轮绝不再触发 —— 重发就是页面上的
          // 第二条(真机豆包 2026-10-25:同一消息两条,各得一个回复)
          if (round > 0 && submitted()) {
            console.info(`[occ-web-chat] bridge send: 已提交证据在,round ${round} 不再触发(防重复)`)
            respond({ ok: true })
            return
          }
          const input = await findInputWhenPrimaryReady()
          if (!input) {
            // 输入框没了:多半是登录页/验证页;页面重挂载时也会短暂缺席,留到最后一轮才下结论
            console.info(`[occ-web-chat] bridge send: no input (round ${round + 1})`)
            if (round === SEND_ROUNDS - 1) {
              respond({ ok: false, reason: 'login-required' })
              return
            }
            await sleep(400)
            continue
          }
          if (!(await injectForSite(input, text))) {
            console.info(`[occ-web-chat] bridge send: inject failed (round ${round + 1})`)
            if (round === SEND_ROUNDS - 1) {
              respond({ ok: false, reason: 'inject-failed' })
              return
            }
            await sleep(400)
            continue
          }
          // 注入后留一拍再触发:Lexical/ProseMirror 系对 input 事件的落账是
          // 异步微任务,立刻点发送可能读到「空状态」而按兵不动(真机豆包)。
          // 留拍前先敲一轮键(⑧):千问类站点的发送键要编辑器收过键盘事件
          // 才解锁 —— 敲 'a' 再 Backspace,净零,但「已敲键」状态被点亮
          if (profile.keystrokeWarmup) touchComposerWithKeystroke(input)
          await sleep(120)
          // 先记账再触发:request 帧可能在 click/Enter 之后立刻到达,
          // 晚记会让它被误判成「用户手动发的」
          rememberSend(text)
          // 触发即记「在途账」:不管最后确认与否 —— 本轮重试再进来时
          // 据此走「先等迟到证据」,而不是立刻重注入(2026-10-30 豆包两条)
          if (turnId) bumpTurnAttempt(turnAttempts, turnId, textHash)
          triggeredSeq = seq
          const preferEnter = round % 2 === 1
          triggerSend(input, preferEnter, wasHidden)
          console.info(`[occ-web-chat] bridge send: round ${round + 1} trigger`,
            preferEnter ? 'Enter' : `button ${lastSendButtonDesc || '(none)'}`, `hidden=${wasHidden}`)
          if (await waitForConsumption(input, text, ROUND_VERIFY_MS, triggeredSeq)) {
            console.info(`[occ-web-chat] bridge send: submitted (round ${round + 1}), ${text.length} chars`)
            respond({ ok: true })
            return
          }
          console.warn(`[occ-web-chat] bridge send: not consumed (round ${round + 1}), ${round === SEND_ROUNDS - 1 ? 'giving up' : 'retrying'}`)
        }
        // 终判前再核一次账(⑦):慢页面可能刚好在最后一个预算窗之后才提交
        if (submitted()) {
          console.info('[occ-web-chat] bridge send: 终判补核 —— 已提交证据在,按成功收口(防重复)')
          respond({ ok: true })
          return
        }
        console.warn('[occ-web-chat] bridge send: result not-submitted')
        respond({ ok: false, reason: 'not-submitted' })
        } finally {
          if (wasHidden) postVisibilityLie(false)
        }
      })()
      return true
    }
    return false
  })

  // DOM 兜底轮次捕获（2026-10-31 Gemini）：补全协议迁到钩子看不见的传输
  // 形态（WebChannel 二进制 protobuf）的站点，桥直接盯页面 DOM 出帧 ——
  // 帧经 window.postMessage 走与钩子**同一条**管道（上面的统一入口），
  // 归属/环形缓冲/回放/广播全部复用，驱动侧零改动。
  if (profile.watchTurns) {
    try {
      profile.watchTurns()
      console.info('[occ-web-chat] bridge: DOM 轮次兜底已开启 (site=' + profile.id + ')')
    } catch (err) {
      // 监视失败只丢兜底通道，不影响注入/网络捕获主链路
      console.warn('[occ-web-chat] bridge: DOM 轮次兜底启动失败', err)
    }
  }
}
