/**
 * DeepSeek 网页端点 —— 站点答案的唯一落点。
 *
 * 端点：chat.deepseek.com，补全 `/api/v0/chat/completion`（XHR）。
 * 输入框是 textarea（原生 setter 注入，不依赖焦点）⇒ 首轮静默发送。
 */
import { DeepSeekFrameParser } from '../deepseek-frames'
import type { WebSite } from './types'

export const DEEPSEEK_SITE: WebSite = {
  id: 'deepseek',
  spec: {
    protocolId: 'deepseek-web',
    displayName: 'DeepSeek',
    urlPatterns: ['https://chat.deepseek.com/*'],
    homeUrl: 'https://chat.deepseek.com/',
    loginUrl: 'https://chat.deepseek.com/',
    backgroundFirst: true,
    activateOncePerSession: true,
    /**
     * 增量发送（2026-10-29 用户定案）：
     * 「每个对话都记着上一轮的原始地址；地址没变就不该把内容压一遍再发回去。」
     *
     * ⇒ 同一线程（页面 URL 未变、本地历史是上一轮的延伸）只发新增的那一轮，
     *   历史由页面自己留着。任何不确定（首轮 / 编辑 / 压缩 / 换线程）都退回
     *   全量拍平 —— 见 `capture/delta.ts` 的 `planDelta`。
     */
    sendMode: 'delta',
    hookScript: 'web-chat-hook--deepseek.js',
    bridgeScript: 'web-chat-bridge--deepseek.js',
    createParser: () => new DeepSeekFrameParser(),
  },
  hook: {
    id: 'deepseek',
    // 补全路径含 completion（文档口径 /api/v0/chat/completion）
    isCompletionUrl: pathname => pathname.includes('completion'),
  },
  bridge: {
    id: 'deepseek',
    // textarea 是 DeepSeek 的形态；真实页面上可能还有搜索框，findInput 会
    // 用「可见 + 容器里有发送键」挑出聊天输入区。
    //
    // ⚠️ 2026-10-31 真机：`textarea#chat-input` 在今天的页面上**匹配不到**
    //   （真实 textarea 没有 id，只有 placeholder）⇒ 命中的是第二条。
    composerSelectors: [
      'textarea#chat-input',
      'textarea[placeholder]',
      'textarea[spellcheck="false"]',
      'textarea',
    ],
    /**
     * 发送键的**真身**（2026-10-31 真机）。
     *
     * DeepSeek 换成了自定义控件：`div.ds-button` + `role="button"`，
     * 上传键是 `ds-button--iconLabelPrimary`、发送键是 `ds-button--primary
     * ds-button--filled` —— **没有** `aria-label`、**不是** `<button>`，
     * 于是下面那张通用选择器表在真页面上命中数**全是 0**。
     *
     * 定位法：从输入框往上找，找到第一个「里面有实心按钮」的祖先，
     * 取其中**最后一个**（发送键在上传键右边）。比全局 querySelector 准 ——
     * 页面上别处也有 ds-button。
     */
    findSendButton(doc: Document): HTMLElement | null {
      const composer = doc.querySelector('textarea')
      if (!composer) return null
      let node: HTMLElement | null = composer
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const buttons = Array.from(node.querySelectorAll<HTMLElement>('[role="button"].ds-button--filled'))
        if (buttons.length) return buttons[buttons.length - 1]
        node = node.parentElement
      }
      return null
    },
    sendButtonSelectors: [
      'button[type="submit"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[class*="send" i]',
      '[role="button"][aria-label*="发送"]',
      '[role="button"][aria-label*="Send"]',
      '[role="button"][class*="send" i]',
    ],
    /**
     * 附件投递（2026-10-31 真机）：DeepSeek 的输入坞**收图片与文档**。
     *
     * 手法用 `paste`：合成 `ClipboardEvent`，`clipboardData` 里带 File ——
     * 页面的 paste 处理器（挂在输入框元素上）把文件交给自己的上传管线
     * （`/api/v0/file/upload_file`），模型随后就能读到图/正文
     * （实测：红方块 → 回答「红色」；txt 附件 → 读出正文里的暗号）。
     *
     * 拖拽也收（document 级捕获），但 paste 是两站通用的手法 ⇒ 统一用它。
     */
    attachments: { mode: 'paste' },
    keystrokeWarmup: false,
    needsVisibilityLie: false,
    decodeEscapedFingerprint: false,
  },
}
