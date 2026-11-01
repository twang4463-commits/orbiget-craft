/**
 * 豆包网页端点 —— 站点答案的唯一落点。
 *
 * 端点：www.doubao.com/chat，补全 `/samantha/chat/completion` 与
 * `/chat/completion`（路径含 completion）。
 * 输入框是富文本编辑器（contenteditable），隐藏文档会挂起交互 ⇒
 * 发送窗口需要可见性/焦点谎报；这类站点专属行为只在本 profile 里开。
 */
import { genKeyFromTrackKey, genKeyOf, mergeMedia, sweepDirectMedia } from '../capture/media'
import type { MediaStatusEntry } from '../capture/types'
import { DoubaoFrameParser } from '../doubao-frames'
import type { WebSite } from './types'

export const DOUBAO_SITE: WebSite = {
  id: 'doubao',
  spec: {
    protocolId: 'doubao-web',
    displayName: '豆包',
    urlPatterns: ['https://www.doubao.com/*'],
    homeUrl: 'https://www.doubao.com/chat/',
    loginUrl: 'https://www.doubao.com/chat/',
    backgroundFirst: true,
    activateOncePerSession: true,
    /**
     * 增量发送（2026-10-30 深夜，用户质疑「豆包每次都在放回放」）：
     * 之前豆包一直走全量拍平 —— 每轮把整段对话历史（含「以下是一段对话回放」
     * 导语 + 系统设定）贴进输入框，页面上每条消息都是一个巨型回放块。
     * 切增量后与 DeepSeek/ChatGPT 同款：首轮全量，之后同一条页面线程只发
     * 本轮那句用户消息，历史由页面线程自己留着。场次⇄会话地址登记、落盘
     * 账本、三种回退全量（首登/不接续/换线程）都是站点无关基建，无需豆包
     * 特殊处理 —— 判定不确定时自动退回全量，没有行为回退风险。
     */
    sendMode: 'delta',
    hookScript: 'web-chat-hook--doubao.js',
    bridgeScript: 'web-chat-bridge--doubao.js',
    createParser: () => new DoubaoFrameParser(),
  },
  hook: {
    id: 'doubao',
    isCompletionUrl: pathname => pathname.includes('completion'),
    /**
     * 发送窗口谎报：与 bridge 侧**成对**开启（2026-10-30 补）。
     *
     * 桥负责发 ctl、钩子负责执行，两个 profile 是各自 bundle 的独立对象 ——
     * 之前只在 bridge 侧开了 ⇒ 桥的 `postVisibilityLie` 发出去，钩子这个
     * `profile.needsVisibilityLie` 是 undefined ⇒ 收到 ctl 也不执行，
     * 谎报一直断在半路（hook/bridge 拆成两个 profile 时漏接的那一份）。
     */
    needsVisibilityLie: true,
    // 豆包产物 CDN：图走 gen_image 路径；视频/音频认直链扩展名
    activityForPath(pathname) {
      if (/gen_image/i.test(pathname)) return 'gen-image'
      if (/\.(mp4|webm|mov|m4v|mp3|wav|m4a|aac)(\?|#|$)/i.test(pathname)) return 'gen-video'
      return null
    },
  },
  bridge: {
    id: 'doubao',
    composerSelectors: [
      // 豆包真机：div[contenteditable="true"]；plaintext-only 与 role=textbox
      // 是同类编辑器的变体，留作兜底。textarea 放最后（页面上可能有暗桩）。
      '[role="textbox"][contenteditable]',
      'div[contenteditable="true"]',
      'div[contenteditable="plaintext-only"]',
      'textarea',
    ],
    /**
     * 发送键的**真身**（2026-10-31 真机）。
     *
     * 豆包的发送键带稳定 testid：`data-testid="chat_input_send_button"`
     * （旁边的 `id="flow-end-msg-send"` 也稳，但 testid 更规范）。
     * ⚠️ 下面那张通用选择器表在真页面上命中数**全是 0**（豆包的按钮没有
     *   `aria-label`、class 里也没有 "send"）⇒ 必须靠这个 testid。
     *
     * 定位法：从编辑器往上找，找到第一个「里面有发送键」的祖先，取最后一个
     * （页面上历史轮次里也有同名 testid 的按钮，取输入坞里的那个）。
     */
    findSendButton(doc: Document): HTMLElement | null {
      const editor = doc.querySelector<HTMLElement>(
        'div[contenteditable="true"], [role="textbox"][contenteditable]',
      )
      if (!editor) return null
      let node: HTMLElement | null = editor
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const buttons = Array.from(
          node.querySelectorAll<HTMLElement>('[data-testid="chat_input_send_button"]'),
        )
        if (buttons.length) return buttons[buttons.length - 1]
        node = node.parentElement
      }
      return null
    },
    sendButtonSelectors: [
      'button[type="submit"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'button[class*="send" i]',
      '[role="button"][aria-label*="发送"]',
      '[role="button"][aria-label*="Send"]',
      '[role="button"][class*="send" i]',
    ],
    /**
     * 附件投递（2026-10-31 真机）：豆包输入坞**收图片与文档**。
     *
     * 手法用 `paste`：合成 `ClipboardEvent`，`clipboardData` 里带 File ——
     * 页面把文件交给自己的上传管线（`/alice/resource/prepare_upload` → TOS
     * → `CommitImageUpload`，文档再走一步 `/samantha/aireader/document_info/get`
     * 解析成文本），模型随后就能读到图/正文（实测：三张图 → 回答
     * 「红色、绿色、蓝色」；txt / PDF 附件 → 读出正文里的暗号）。
     *
     * ⚠️ 豆包的**拖拽**只对「创作素材」功能开放（要 materialEnabled + 账号），
     *   普通附件的入口就是粘贴 ⇒ 手法固定 paste。
     */
    attachments: { mode: 'paste' },
    keystrokeWarmup: true,
    // 隐藏文档里编辑器会把输入回滚 ⇒ 发送窗口谎报 visible/focused（只骗页面 JS）
    needsVisibilityLie: true,
    decodeEscapedFingerprint: false,
    sweepMedia(doc) {
      const out = new Map<string, ReturnType<typeof sweepDirectMedia>[number]>()
      try {
        // 豆包产物容器带稳定 testid（哈希类名每构建都变，testid 不漂）
        for (const grid of doc.querySelectorAll('[data-testid="message_image_content"]')) {
          if (grid.getAttribute('data-finished') !== 'true') continue
          for (const cell of grid.querySelectorAll<HTMLElement>('[data-testid="mdbox_image"]')) {
            const img = cell.querySelector<HTMLImageElement>('img[data-track-key]')
              ?? cell.querySelector<HTMLImageElement>('img[src^="http"]')
            const trackKey = img?.getAttribute('data-track-key') ?? ''
            const src = img?.getAttribute('src') ?? img?.currentSrc ?? ''
            if (!src || !/gen_image/i.test(src)) continue
            const key = (trackKey ? genKeyFromTrackKey(trackKey) : '') || genKeyOf(src)
            if (key) out.set(key, { key, url: src, kind: 'image' })
          }
        }
      } catch {
        /* DOM 读挂了：交回流内扫描那一源 */
      }
      mergeMedia(out, sweepDirectMedia(doc))
      return [...out.values()]
    },
    /**
     * 生成中的媒体状态（2026-10-27）。图片网格在 `data-finished` 变 true
     * 之前就已经在 DOM 里 ⇒ 这就是「正在生成」的现成锚点；格子数 = 张数。
     * 视频/音频只认直链 src 为完成，生成中的空 `<video>/<audio>` 计为未完成；
     * 历史轮次由桥的发送基线排除。
     */
    readMediaStatus(doc): MediaStatusEntry[] {
      const out: MediaStatusEntry[] = []
      let imageIndex = 0
      for (const grid of doc.querySelectorAll('[data-testid="message_image_content"]')) {
        const cells = grid.querySelectorAll('[data-testid="mdbox_image"]').length
        out.push({
          key: `doubao-image-grid:${imageIndex++}`,
          kind: 'image',
          finished: grid.getAttribute('data-finished') === 'true',
          count: Math.max(1, cells),
        })
      }
      const mediaSrc = (el: HTMLMediaElement): string =>
        el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || ''
      let videoIndex = 0
      for (const video of doc.querySelectorAll<HTMLVideoElement>('video')) {
        out.push({
          key: `doubao-video:${videoIndex++}`,
          kind: 'video',
          finished: /^https?:\/\//i.test(mediaSrc(video)),
          count: 1,
        })
      }
      let audioIndex = 0
      for (const audio of doc.querySelectorAll<HTMLAudioElement>('audio')) {
        out.push({
          key: `doubao-audio:${audioIndex++}`,
          kind: 'audio',
          finished: /^https?:\/\//i.test(mediaSrc(audio)),
          count: 1,
        })
      }
      return out
    },
  },
}
