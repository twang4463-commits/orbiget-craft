/**
 * Gemini 网页端点 —— 站点答案的唯一落点。
 *
 * ⚠️ **协议形态（2026-10-31 定案）**：Google 于 2026-10-20 把补全从
 * `batchexecute`/`StreamGenerate`（JSON 流）全面迁移到 **WebChannel 全双工
 * 二进制 Protobuf**（`…/v1/processSession`）。钩子在网络层再也看不见补全
 * 请求/响应 —— 抓取改走 **DOM 兜底**（`bridge.watchTurns`）：Gemini 页面的
 * `user-query` / `model-response` 语义标签多年稳定，桥直接出帧，驱动管线
 * 复用。chunk 是纯文本增量 ⇒ 解析器为直通（PlainTextFrameParser）。
 * 旧 StreamGenerate 的判定与 GeminiFrameParser 保留在案（协议随时可能回跳/
 * A/B 共存，回来时恢复即可）。
 */
import { sweepDirectMedia } from '../capture/media'
import { PlainTextFrameParser } from '../plain-frames'
import { DomTurnTracker, WEB_CHAT_FRAME_SOURCE } from '../capture/dom-turns'
import type { WebSite } from './types'

export const GEMINI_SITE: WebSite = {
  id: 'gemini',
  spec: {
    protocolId: 'gemini-web',
    displayName: 'Gemini',
    urlPatterns: ['https://gemini.google.com/*'],
    homeUrl: 'https://gemini.google.com/app',
    loginUrl: 'https://gemini.google.com/app',
    // 仍然要走**专窗**（场次⇄会话隔离，能力前提，见 driver 的 acquireOwnedTab）
    backgroundFirst: true,
    /**
     * 这站的发送窗口必须**真前台**（2026-10-30 深夜真机定案）。谎报只骗
     * 页面 JS，骗不到浏览器层（被遮挡窗口不渲染/不派发）—— DOM 兜底捕获
     * 也依赖页面真实渲染（MutationObserver 要看到 model-response 长出来），
     * 真前台同时对两者成立。发送后 1.5s 把焦点还给用户原窗口。
     */
    needRealForeground: true,
    hookScript: 'web-chat-hook--gemini.js',
    bridgeScript: 'web-chat-bridge--gemini.js',
    /**
     * 增量发送（2026-10-31 用户点名「同一线程只有第一次转发时发压缩回放」）：
     * 与 DeepSeek/豆包/ChatGPT 同款 —— 首轮发一次全量回放，之后每轮只发
     * 新消息（页面线程自己保留历史）。线程地址 = 标签 URL（首轮发出后
     * Gemini 把地址改成 /app/<会话id>，与驱动的记账时机天然吻合）；
     * 判定不确定（重开/换线程/账本缺失）自动退回全量，无丢失风险。
     * DOM 兜底也因此更干净：注入的短消息气泡指纹逐字命中，绝不会再把
     * 回放块误判成手动轮贴进 app 会话。
     */
    sendMode: 'delta',
    // DOM 兜底出的是纯文本增量，不需要任何协议解析
    createParser: () => new PlainTextFrameParser(),
  },
  hook: {
    id: 'gemini',
    /**
     * ⚠️ 2026-10-31：补全已迁 WebChannel 二进制 protobuf，网络层判定
     * **一律不认**（认了就会和 DOM 兜底对同一轮双记）。保留旧判定在注释里，
     * 协议回跳时恢复：
     *   if (/streamgenerate/i.test(pathname)) return true
     *   return /batchexecute/i.test(pathname) && /rpcids=[^&]*streamgenerate/i.test(rawUrl)
     */
    isCompletionUrl: () => false,
    // Google 的 JSON 流（旧协议）：首块以 )]}' 哨兵开头，不是 text/event-stream
    isExtraStream: (_contentType, head) => head.startsWith(")]}'"),
    streamLabel: (_contentType, head) => (head.startsWith(")]}'") ? 'json-stream' : 'sse'),
    /**
     * 发送窗口谎报 visible/focused —— 后台窗口的辅助能力（不是根因答案；
     * 2026-10-31 修正见 bridge.requireRequestEvidence 的注释）。
     * ⚠️ 必须在 hook 与 bridge **两边都开**：桥发 ctl、钩子执行，漏一边就断半路。
     */
    needsVisibilityLie: true,
  },
  bridge: {
    id: 'gemini',
    composerSelectors: [
      'rich-textarea [contenteditable="true"]',
      '[role="textbox"][contenteditable]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    sendButtonSelectors: [
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[type="submit"]',
      'button[class*="send" i]',
      '[role="button"][aria-label*="Send"]',
    ],
    keystrokeWarmup: false,
    /** 与 hook 侧成对开启（桥发 ctl、钩子执行；漏一边谎报就断在半路） */
    needsVisibilityLie: true,
    /**
     * 「已提交」只认补全请求帧（2026-10-31 真机）：之前按钮一点、输入框
     * 清空就报 `submitted`，但页面一个补全请求都没发。那是富文本
     * 重渲染/状态回滚造成的假阳性。开了以后 DOM 清空不再算证据；
     * DOM 兜底出的 request 帧（user-query 气泡一出现就有）恰好接上
     * 这条证据链 —— 页面真的收下了消息，验证窗立刻放行。
     */
    requireRequestEvidence: true,
    /**
     * 注入落账必须等到**发送键解锁**（2026-10-31 深夜真机两连）：
     * ① 合成 paste 只进 DOM 不进框架模型 —— DOM 有文本、发送键 (none)，
     *    点按钮/Enter 都按兵不动，还白等了一整轮；
     * ② 主编辑器（rich-textarea）未 hydrate 时，兜底选择器把文本灌进了
     *    暗桩 textarea，点了个「可见」的发送键，空编辑器毫无反应。
     * 开启后：DOM 落账不算数，等不到按钮就换手法（paste→execCommand→
     * 合成事件），全失败快速 inject-failed 交还驱动重试。
     */
    verifySendButtonUnlock: true,
    sweepMedia: doc => sweepDirectMedia(doc),
    /**
     * DOM 兜底轮次捕获（2026-10-31）：补全走 WebChannel 二进制 protobuf，
     * 钩子在网络层抓不到 ⇒ 桥盯 DOM 出帧。`user-query` / `model-response`
     * 是 Gemini 多年稳定的语义标签；响应正文取 `.markdown`（渲染后的
     * textContent 增长基本前缀稳定，整段重写走 reset 帧覆盖）。
     */
    watchTurns: () => {
      // 流式期间页面显示「停止」按钮（aria-label Stop response / 停止），
      // 消失即回答结束 —— 这是唯一可靠的完成信号：思考/联网停顿经常远超
      // 1.5s settle 时限，不抑制会把回答截在开头（真机：app 只收到「这就」）。
      const isGenerating = (): boolean =>
        !!document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"]')
      const tracker = new DomTurnTracker(
        {
          request: (id, body) => {
            window.postMessage({ source: WEB_CHAT_FRAME_SOURCE, kind: 'request', requestId: id, body }, '*')
          },
          chunk: (id, delta) => {
            window.postMessage({ source: WEB_CHAT_FRAME_SOURCE, kind: 'chunk', requestId: id, text: delta }, '*')
          },
          reset: (id, text) => {
            window.postMessage({ source: WEB_CHAT_FRAME_SOURCE, kind: 'reset', requestId: id, text }, '*')
          },
          done: (id) => {
            window.postMessage({ source: WEB_CHAT_FRAME_SOURCE, kind: 'done', requestId: id }, '*')
          },
        },
        () => `dom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        isGenerating,
      )

      /** 响应正文：`.markdown` 是渲染正文容器（避开操作按钮/反馈条的文本） */
      const responseText = (el: Element): string =>
        (el.querySelector('.markdown')?.textContent ?? el.textContent ?? '').trim()
      /** 这条响应前面的用户消息（归属判定的 request body） */
      const userTextFor = (el: Element): string => {
        let p = el.previousElementSibling
        while (p) {
          if (p.tagName.toLowerCase() === 'user-query') return (p.textContent ?? '').trim()
          p = p.previousElementSibling
        }
        return ''
      }
      const feedEl = (el: Element): void => {
        if (el.tagName.toLowerCase() !== 'model-response') return
        tracker.feed(el, userTextFor(el), responseText(el))
      }
      const feedSubtree = (root: Element): void => {
        feedEl(root)
        for (const el of root.querySelectorAll('model-response')) feedEl(el)
      }

      // 用户气泡 → 立刻出 request 帧（2026-10-31 无限重试定案）：提交验证
      // 只认 request 帧，等回复正文出现才出帧会把「页面已收下」判成没提交
      // ⇒ 重注入 ⇒ 页面上真多一条 ⇒ 又判没提交，无限循环。
      // 气泡先出现时文本可能是空的（框架随即填字），所以按「元素首次非空」触发。
      const begunQueries = new WeakSet<Element>()
      const beginFromQuery = (qq: Element): void => {
        if (qq.tagName.toLowerCase() !== 'user-query') return
        if (begunQueries.has(qq)) return
        const text = (qq.textContent ?? '').trim()
        if (!text) return
        begunQueries.add(qq)
        tracker.beginTurn(text)
      }
      const beginInSubtree = (root: Element): void => {
        beginFromQuery(root)
        for (const el of root.querySelectorAll('user-query')) beginFromQuery(el)
      }
      // 观察起点：既有用户气泡记名，绝不重复报历史
      for (const q of document.querySelectorAll('user-query')) begunQueries.add(q)

      // 观察起点：页面上已有的响应全部按「已收完」记账，绝不回放历史
      tracker.seed(document.querySelectorAll('model-response'))
      const observer = new MutationObserver((muts) => {
        for (const m of muts) {
          // characterData 变更的 target 是 Text 节点，借 parentElement 归位
          const anchor = m.target instanceof Element ? m.target : m.target.parentElement
          if (anchor) {
            beginInSubtree(anchor)
            feedSubtree(anchor)
          }
          m.addedNodes.forEach((n) => {
            if (!(n instanceof Element)) return
            beginInSubtree(n)
            feedSubtree(n)
          })
          m.removedNodes.forEach((n) => {
            if (n instanceof Element) {
              if (n.tagName.toLowerCase() === 'model-response') tracker.drop(n)
              for (const el of n.querySelectorAll('model-response')) tracker.drop(el)
            }
          })
        }
        tracker.sweep()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      // sweep 兜底：变更停了也要收口（最后一帧之后不再有 mutation）
      setInterval(() => tracker.sweep(), 500)
    },
  },
}
