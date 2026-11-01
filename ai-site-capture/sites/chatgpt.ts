/**
 * ChatGPT 网页端点 —— 站点答案的唯一落点。
 *
 * 端点：chatgpt.com（旧 chat.openai.com 服务端重定向），补全
 * `/backend-api/(f/)?conversation`（SSE）。
 * 输入框是 ProseMirror 的 contenteditable（`#prompt-textarea`）。
 * 生图轮的产物只活在 DOM 里（新协议资产指针不走 SSE 明文）⇒ 助手气泡内
 * 的 CDN 图片由本 profile 的 sweepMedia 收割。
 * 会话历史接口（`/backend-api/conversation/<id>`）也只在 ChatGPT 有。
 */
import { genKeyOf, mergeMedia, sweepDirectMedia } from '../capture/media'
import type { HistoryPullResult } from '../capture/types'
import { ChatGPTFrameParser } from '../chatgpt-frames'
import type { WebSite } from './types'

/** ChatGPT 页面的两步走会话拉取（cookie-only 会被新基建拒成 404） */
async function pullChatGptHistory(): Promise<HistoryPullResult> {
  // 会话 id：优先 /c/<uuid>/chat/<uuid> 显式段（GPTs/项目路径里前面可能
  // 有别的 uuid，不能盲取「最后一个」）；没有显式段再退回最后一个 uuid
  const pathname = location.pathname
  const explicit = /\/(?:c|chat)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(pathname)
  const uuidMatches = pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
  const conversationId = explicit?.[1] ?? (uuidMatches ? uuidMatches[uuidMatches.length - 1] : '')
  if (!conversationId) return { ok: false, error: 'no-conversation' }
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    try {
      const session = await fetch('/api/auth/session', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (session.ok) {
        const token = (await session.json())?.accessToken
        if (typeof token === 'string' && token) headers.Authorization = `Bearer ${token}`
      }
    } catch {
      /* session 拿不到就退回 cookie-only */
    }
    const res = await fetch(`/backend-api/conversation/${conversationId}`, {
      credentials: 'include',
      headers,
    })
    if (!res.ok) {
      // 带上响应体前 120 字：干净 404 与 Cloudflare 拦截页一眼可辨
      const body = await res.text().catch(() => '')
      return { ok: false, conversationId, error: `fetch-failed:HTTP ${res.status}:${body.slice(0, 120)}` }
    }
    return { ok: true, conversationId, url: location.href, raw: await res.text() }
  } catch (err) {
    return {
      ok: false,
      conversationId,
      error: `fetch-failed:${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export const CHATGPT_SITE: WebSite = {
  id: 'chatgpt',
  spec: {
    protocolId: 'chatgpt-web',
    displayName: 'ChatGPT',
    urlPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    homeUrl: 'https://chatgpt.com/',
    loginUrl: 'https://chatgpt.com/',
    backgroundFirst: true,
    activateOncePerSession: true,
    /**
     * 增量发送（2026-10-30 真机验过）：
     * 首轮建线程后，请求体带 `conversation_id` + `parent_message_id`，
     * 页面自己保留上下文 ⇒ 同分支只发新增那一轮。日志实证：全量模式下
     * 连续三轮是 1144 → 1153 → 2835 字符（第三轮把上一轮 1620 字的回答
     * 又重贴了一遍）；delta 后只有新问的那一句。
     */
    sendMode: 'delta',
    hookScript: 'web-chat-hook--chatgpt.js',
    bridgeScript: 'web-chat-bridge--chatgpt.js',
    createParser: () => new ChatGPTFrameParser(),
  },
  hook: {
    id: 'chatgpt',
    // 泛匹配 /conversation 会误收页面路由，必须限定 backend-api 前缀
    isCompletionUrl: pathname => /\/backend-api\/(f\/)?conversation$/.test(pathname),
  },
  bridge: {
    id: 'chatgpt',
    composerSelectors: [
      // 官方自动化锚点：ProseMirror/Lexical 级 contenteditable
      '#prompt-textarea',
      '[role="textbox"][contenteditable]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    sendButtonSelectors: [
      'button[data-testid="send-button"]',
      'button[type="submit"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[class*="send" i]',
      '[role="button"][aria-label*="Send"]',
    ],
    keystrokeWarmup: false,
    needsVisibilityLie: false,
    decodeEscapedFingerprint: false,
    sweepMedia(doc) {
      const out = new Map<string, ReturnType<typeof sweepDirectMedia>[number]>()
      try {
        // 限定助手气泡：用户上传图渲染在 user 气泡里，同域但不是产物
        for (const img of doc.querySelectorAll<HTMLImageElement>('img[src]')) {
          const src = img.getAttribute('src') || img.currentSrc || ''
          if (!/^https?:/i.test(src)) continue
          if (!/oaiusercontent\.com|sfile\.chatgpt\.com|chatgpt\.com\/(images|files)\//i.test(src)) continue
          if (!img.closest('[data-message-author-role="assistant"]')) continue
          const key = genKeyOf(src)
          if (key) out.set(key, { key, url: src, kind: 'image' })
        }
      } catch {
        /* DOM 读挂了：交回流内扫描那一源 */
      }
      mergeMedia(out, sweepDirectMedia(doc))
      return [...out.values()]
    },
    pullHistory: pullChatGptHistory,
  },
}
