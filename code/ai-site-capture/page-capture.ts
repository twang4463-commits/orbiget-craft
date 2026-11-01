/**
 * 页面旁路监听（2026-10-25）——「页面负责录入，App 负责记账」。
 *
 * 钩子捕获页面上的**所有**补全流（不分谁发起），桥把它们广播给所有端口；
 * 驱动器只认自己指纹的流，其余 `foreign` 流由本模块收下：按站点解析器拼出
 * 正文，一轮结束发 `CapturedPageTurn`。
 *
 * 为什么单独一条链路，不复用驱动器：
 * · 驱动器是「我发一条、等一条」的一次性连接，旁路是长驻监听；
 * · 驱动器按请求体指纹归属流，非自己的流直接丢弃 —— 这里收的恰好是那些流；
 * · 旁路只读回流，不注入、不触发、不碰页面状态。
 *
 * 不碰签名/鉴权/上传管线：用户在页面上手动发图、发文件、用语音，页面自己
 * 完成，旁路只负责把这一轮的回答带回会话。图片只带「疑似地址」做含图证据
 * （签名链接会过期），原图不落 —— v1 不抢上传管线。
 */
import { stripSiteFooter } from './site-footer'
import type { BridgeFrame, WebEndpointSpec, WebFrameParser } from './types'
import { GEN_IMAGE_TOOL_HINT_RE, GenImageScanner, genImageKeyOf, type GenImageRef } from './gen-image-scan'
import { extractLastUserText } from './capture/turn-text'

/**
 * 请求体 → 本轮用户文本的解析器在 `capture/turn-text.ts`（2026-10-27 拆出：
 * 桥的流归属判定也要用，不能让内容脚本把整条页面接力链路拖进 bundle）。
 * 这里保留导出，既有调用方与测试不用改。
 */
export { extractLastUserText }

/** 桥端口的最小面（chrome.runtime.Port 的子集；测试可注入假端口） */
export interface CapturePort {
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: { addListener(cb: (frame: BridgeFrame) => void): void }
  onDisconnect: { addListener(cb: () => void): void }
}

export interface CapturedPageTurn {
  protocolId: string
  tabId: number
  requestId: string
  at: number
  /** 请求体里解析出的最后一条用户消息（可能为空：纯图片/文件轮次） */
  userText: string
  /** 本轮回答正文 */
  assistantText: string
  /** 思考过程（站点有的话） */
  thinking?: string
  /** 请求体里疑似图片地址（去重，最多 4 条；可能过期，不落库） */
  imageUrls: string[]
  /** 请求体里是否有图片/附件痕迹（纯图片轮次没有 userText，靠它落账） */
  hasImage: boolean
  /** 本轮回答里**生成**的图片(豆包海报等;流内扫 + DOM 扫双源,§6.14)。
   *  key = 未签名 objectKey(去重/回源),url = 签名地址(实测十年期)。 */
  generatedImages?: GenImageRef[]
  /** 本轮回答里生成的视频/音频直链(v2.3;blob:/m3u8 收不到,如实空着) */
  generatedVideos?: GenImageRef[]
  generatedAudios?: GenImageRef[]
  /** 这轮对话在页面上的地址（「回页面看原会话」的入口） */
  conversationUrl?: string
}

export interface PageCaptureOptions {
  spec: WebEndpointSpec
  tabId: number
  connect: (tabId: number) => CapturePort
  onTurn: (turn: CapturedPageTurn) => void
  /**
   * 一轮**开始**（2026-10-29）：请求体里已经能解析出用户文本 —— App 据此立刻
   * 建一条 pending 消息，**用户发出去那一刻**就能看到，而不是等整轮答完。
   *
   * ⚠️ 只对「像一轮对话」的请求发（有用户文本或有图片证据）：标题生成 /
   *   建议词这类旁路补全请求不发，免得在会话里留一堆空壳。
   */
  onTurnStart?: (turn: CapturedTurnStart) => void
  /**
   * 正文增量（**累计值**，不是差量）：消费方直接覆盖 pending 消息的正文即可。
   *
   * ⚠️ 只在 `onTurnStart` 之后发；没 start 过的轮次（标题请求等）不发。
   */
  onTurnDelta?: (turn: CapturedTurnDelta) => void
  /** 端口断开（页面关闭/刷新）：调用方据此重连 */
  onDisconnect?: () => void
  /** 桥侧产物 sweep（WEB_CHAT_SWEEP_IMAGES；壳/SW 用 chrome.tabs.sendMessage 实现）。
   *  waitLong = 流里有生成媒体痕迹,桥侧轮询;waitMs 覆盖等待上限(视频 100s)。
   *  缺省 = 只靠流内扫描收生成媒体,不采 DOM 源也不带会话地址。 */
  sweep?: (quick: boolean, waitLong?: boolean, waitMs?: number) => Promise<{ images?: GenImageRef[]; url?: string } | null>
}

/** 一轮开始时能确定的信息（用户文本来自请求体，不等回答） */
export interface CapturedTurnStart {
  protocolId: string
  tabId: number
  requestId: string
  userText: string
  imageUrls: string[]
  hasImage: boolean
  at: number
}

/** 正文增量（累计值） */
export interface CapturedTurnDelta {
  requestId: string
  content: string
  thinking: string
}

interface PendingTurn {
  requestId: string
  /** 已经发过 `onTurnStart`（正文增量只对这类轮次发） */
  started: boolean
  parser: WebFrameParser
  content: string
  thinking: string
  userText: string
  imageUrls: string[]
  hasImage: boolean
  /** 产物收割·流内源（§6.14）：对原始流文本扫生成图 URL */
  genScanner: GenImageScanner
  /** 流里出现过图片工具调用名(ChatGPT 生图轮:资产指针不走 SSE 明文时,
   *  这是「图在路上」的唯一流内证据 —— 据此放宽 DOM 等待到 waitLong 档) */
  sawImageToolHint: boolean
  at: number
}

/**
 * 挂一个旁路监听。返回句柄用于主动断开（标签关闭/设置关闭）。
 *
 * ⚠️ 必须在用户手动发送**之前**连上：桥的回放只补「未完结」的流，
 * 已完成的轮次不会重放。App 侧靠启动扫描 + 标签加载事件提前挂好。
 */
export function startPageCapture(options: PageCaptureOptions): { disconnect(): void } {
  const { spec, tabId, connect, onTurn, onDisconnect } = options
  const pending = new Map<string, PendingTurn>()
  /**
   * **用户自己发的那张图**的 key（累计）。
   *
   * 站点每轮都把整段对话重发 ⇒ 用户的那张图每轮都在请求体里。它**不是**
   * 「本轮生成的产物」—— 但站点回包里也常把它带一遍（豆包会把对话状态再发
   * 一次），于是 URL 扫描把它当成新生成的图 ⇒ 助手气泡每轮底下挂一张一样的图
   * （2026-10-27 真机）。
   *
   * ⇒ 累计记名：只要见过一次（它是「对话里早就有的图」），以后都不算产物。
   */
  const userImageKeys = new Set<string>()
  /** 已经报过一次的产物（跨轮记忆）—— 同一张图不该每轮都挂（2026-10-27 真机） */
  const reportedGenKeys = new Set<string>()
  /** 已收割过的生成图 objectKey（防旧轮次的 DOM 网格重复挂到新轮次,§6.14） */
  const seenGenKeys = new Set<string>()
  let closed = false
  const port = connect(tabId)

  function emit(turn: PendingTurn, media: GenImageRef[], conversationUrl?: string): void {
    pending.delete(turn.requestId)
    // 收尾是异步的(sweep):断开已发生就不再落账
    if (closed) return
    const assistantText = stripSiteFooter(turn.content)
    const thinking = turn.thinking.trim()
    const images = media.filter(item => (item.kind ?? 'image') === 'image')
    const videos = media.filter(item => item.kind === 'video')
    const audios = media.filter(item => item.kind === 'audio')
    // 纯媒体轮例外(2026-10-26 ChatGPT 生图轮):有生成媒体就不算空回答
    if (!assistantText && !thinking && media.length === 0) {
      console.info('[occ-web-chat] capture: 丢弃(回答为空)', turn.requestId, `user=${turn.userText.slice(0, 24)}`)
      return
    }
    // 没有用户消息也没有图片证据 = 不是一轮对话（标题生成/建议等旁路
    // completion 请求也会被钩子捕获）—— 不落账，免得假轮次污染会话
    if (!turn.userText && !turn.hasImage) {
      console.info('[occ-web-chat] capture: 丢弃(解析不出用户消息也无图片证据)', turn.requestId, `body 前 60 字未命中提取器`)
      return
    }
    console.info('[occ-web-chat] capture: 收到一轮', turn.requestId, `user=${turn.userText.slice(0, 24)} assistant=${assistantText.length} 字`,
      ...(media.length ? [`媒体 图${images.length}/视频${videos.length}/音频${audios.length}`] : []))
    onTurn({
      protocolId: spec.protocolId,
      tabId,
      requestId: turn.requestId,
      at: turn.at,
      userText: turn.userText,
      assistantText,
      ...(thinking ? { thinking } : {}),
      imageUrls: turn.imageUrls,
      hasImage: turn.hasImage,
      ...(images.length ? { generatedImages: images } : {}),
      ...(videos.length ? { generatedVideos: videos } : {}),
      ...(audios.length ? { generatedAudios: audios } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
    })
  }

  /** 轮开始打底（§6.14）：把页面上**已有**的生成图 key 记名 —— 本轮结束
   *  DOM sweep 只收「新出现的」;用户上传图渲染用同一套 testid,先到的
   *  也一并记名,不会被当成「本轮生成」。失败不阻塞(交回流内源)。 */
  function primeSweep(): void {
    if (!options.sweep) return
    void options.sweep(true)
      .then(res => {
        for (const item of res?.images ?? []) seenGenKeys.add(item.key)
      })
      .catch(() => { /* ignore */ })
  }

  /** 轮收尾:收割产物(流内源 + DOM 源)再落账。sweep 未配置时无 await,
   *  emit 仍在同步段执行(老调用方/老测试的时序不变)。
   *
   *  归属规则(2026-10-26 深夜,与驱动器同款):DOM 最终态快照是权威源 ——
   *  豆包内部先出候选再换终版,流里的候选让位;DOM 空才回退流内源。
   *  用户上传图(请求体里捞到的 key)两边都排除。 */
  async function finalizeTurn(turn: PendingTurn): Promise<void> {
    let collected = new Map<string, GenImageRef>()
    // 用户上传图(请求体里捞到的)不是「生成的产物」—— 同 CDN 时按 key 排除
    for (const url of turn.imageUrls) userImageKeys.add(genImageKeyOf(url))
    for (const ref of turn.genScanner.refs()) {
      // ⚠️ 流内源也要排用户的图:站点回包里常把整段对话(含那张图)再发一遍,
      // URL 扫描会把它当成「本轮生成的图」(2026-10-27 豆包真机:每轮挂一遍)
      if (userImageKeys.has(ref.key)) continue
      if (reportedGenKeys.has(ref.key)) continue
      collected.set(ref.key, ref)
    }
    const userKeys = userImageKeys
    let conversationUrl: string | undefined
    if (options.sweep) {
      try {
        const res = await options.sweep(
          false,
          turn.genScanner.sawAny || turn.sawImageToolHint,
          turn.genScanner.sawVideo ? 100_000 : undefined,
        )
        if (res) {
          if (typeof res.url === 'string' && res.url) conversationUrl = res.url
          const fresh = (res.images ?? [])
            .filter(item =>
              !seenGenKeys.has(item.key)
              && !userKeys.has(item.key)
              && !reportedGenKeys.has(item.key))
          for (const item of fresh) seenGenKeys.add(item.key)
          if ((res.images ?? []).length > 0) {
            collected = new Map(fresh.map(item => [item.key, item]))
          }
        }
      } catch {
        /* sweep 失败:流内源的照常带出去 */
      }
    }
    // 本轮报出去的产物记名(跨轮去重):同一个 key 只报一次
    for (const key of collected.keys()) reportedGenKeys.add(key)
    emit(turn, [...collected.values()].slice(0, 8), conversationUrl)
  }

  function consume(turn: PendingTurn, parsed: ReturnType<WebFrameParser['push']>): void {
    for (const frame of parsed) {
      if (frame.type === 'content') turn.content += frame.delta
      else if (frame.type === 'thinking') turn.thinking += frame.delta
      else if (frame.type === 'reset') {
        // 页面重写了已发文本(见 ChatGPTFrameParser):覆盖,不能追加 ——
        // 否则旧文本残留、句中碎片重复(2026-10-29 真机)
        if (frame.channel === 'thinking') turn.thinking = frame.text
        else turn.content = frame.text
      }
    }
  }

  port.onMessage.addListener((frame) => {
    if (closed) return
    if (frame.kind === 'request') {
      // 投递保证(2026-10-25 深夜三):收到带 seq 的请求帧即 ACK —— 桥销账,
      // 下次重连只重放「未确认」的;没 seq 的(旧桥回放)不确认也不报错
      if (typeof frame.seq === 'number') {
        try {
          port.postMessage({ kind: 'ack', seq: frame.seq })
        } catch {
          /* ignore */
        }
      }
      // 只收「不是 App 发的」流：App 自己的流由驱动器收，否则一条消息两份。
      // foreign 缺省（旧桥/识别不了）按不收处理 —— 宁可漏，不可重。
      console.info('[occ-web-chat] capture: request', frame.requestId, `foreign=${frame.foreign === true} body=${frame.body?.length ?? 0} 字`)
      if (frame.foreign !== true) {
        console.info('[occ-web-chat] capture: 丢弃(foreign≠true:App 自己发的/标记缺失)')
        return
      }
      const image = scanImages(frame.body)
      const turn: PendingTurn = {
        requestId: frame.requestId,
        started: false,
        // 站点解析器有状态，每轮一条
        parser: spec.createParser(),
        content: '',
        thinking: '',
        userText: extractLastUserText(frame.body),
        imageUrls: image.urls,
        hasImage: image.hasImage,
        genScanner: new GenImageScanner(),
        sawImageToolHint: false,
        at: Date.now(),
      }
      pending.set(frame.requestId, turn)
      // 一轮开始：有用户文本或图片证据才算「对话轮次」（标题/建议类请求不发 start）
      if (turn.userText || turn.hasImage) {
        turn.started = true
        options.onTurnStart?.({
          protocolId: spec.protocolId,
          tabId,
          requestId: turn.requestId,
          userText: turn.userText,
          imageUrls: turn.imageUrls,
          hasImage: turn.hasImage,
          at: turn.at,
        })
      }
      primeSweep()
      return
    }
    // 产物动向帧(2026-10-26):无 requestId,旁路不消费(App 自己那轮由驱动器转活动行)
    if (frame.kind === 'activity') return
    // 钩子诊断帧(2026-10-27):只给驱动日志看,旁路不消费
    if (frame.kind === 'diag') return
    const turn = pending.get(frame.requestId)
    if (!turn) return
    if (frame.kind === 'chunk') {
      turn.genScanner.push(frame.text)
      if (!turn.sawImageToolHint && GEN_IMAGE_TOOL_HINT_RE.test(frame.text)) turn.sawImageToolHint = true
      consume(turn, turn.parser.push(frame.text))
      // 实时回写：累计正文推给 App（只对「已经开过 start」的轮次发）
      if (turn.started) {
        options.onTurnDelta?.({
          requestId: turn.requestId,
          content: turn.content,
          thinking: turn.thinking,
        })
      }
      return
    }
    if (frame.kind === 'reset') {
      // DOM 兜底捕获的整段重写（2026-10-31 Gemini）：覆盖，不能追加
      consume(turn, [{ type: 'reset', channel: 'content', text: frame.text }])
      if (turn.started) {
        options.onTurnDelta?.({
          requestId: turn.requestId,
          content: turn.content,
          thinking: turn.thinking,
        })
      }
      return
    }
    if (frame.kind === 'done') {
      consume(turn, turn.parser.end())
      void finalizeTurn(turn)
      return
    }
    if (frame.kind === 'error' || frame.kind === 'response-error') {
      // 风控/断流：不留半截，清掉等下一轮（页面自己会给用户看错误）
      pending.delete(frame.requestId)
    }
  })

  port.onDisconnect.addListener(() => {
    if (closed) return
    pending.clear()
    onDisconnect?.()
  })

  return {
    disconnect() {
      if (closed) return
      closed = true
      pending.clear()
      try {
        port.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 从请求体里捞疑似图片地址（最多 4 条）+「有没有图」证据。
 *
 * 为什么证据要独立于 URL：纯图片轮次可能没有文字，图片也可能是无扩展名的
 * CDN key（tos-cn-...）—— 只数 URL 会把这种轮次漏掉。键名像 image/file/
 * attach、或路径像图，即算含图；URL 只作附加上下文（签名链接会过期，不落库）。
 */
export function extractImageUrls(body: string): string[] {
  return scanImages(body).urls
}

/** 请求体里是否有图片/附件痕迹（纯图片轮次没有 userText，靠它落账） */
export function hasImageEvidence(body: string): boolean {
  return scanImages(body).hasImage
}

interface ImageScan {
  urls: string[]
  hasImage: boolean
}

/** 一遍扫描同时产出 URL 列表与含图证据 */
function scanImages(body: string): ImageScan {
  if (!body) return { urls: [], hasImage: false }
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    return { urls: [], hasImage: false }
  }
  const urls = new Set<string>()
  const state = { hasImage: false }
  walkImages(root, '', urls, state, 0, false)
  return { urls: [...urls].slice(0, 4), hasImage: state.hasImage || urls.size > 0 }
}

function walkImages(
  value: unknown,
  key: string,
  urls: Set<string>,
  state: { hasImage: boolean },
  depth: number,
  imageContext: boolean,
): void {
  if (depth > 8) return
  const keyLooksImage = /(image|img|file|attach|upload|photo|pic)/i.test(key)
  // 祖先键已经是图片/附件 ⇒ 子孙（如 image.uri）都算含图证据
  const context = imageContext || keyLooksImage
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return
    if (context) state.hasImage = true
    if (/^https?:\/\//i.test(text)) {
      const keyLooksUrl = /(url|uri|src|href)/i.test(key)
      const looksLikeImage = /\.(png|jpe?g|webp|gif|heic|bmp)(\?|#|$)/i.test(text)
      const imagePath = /\/image|\/img\/|\/file\//i.test(text)
      // 键名像图/附件、路径像图、或已在图片上下文里（无扩展名的 CDN key）
      if (keyLooksImage || imagePath || context || (keyLooksUrl && looksLikeImage)) urls.add(text)
      return
    }
    if ((text.startsWith('{') || text.startsWith('[')) && depth < 3) {
      try {
        walkImages(JSON.parse(text), key, urls, state, depth + 1, context)
      } catch {
        /* 不是 JSON 字符串 */
      }
    }
    return
  }
  if (Array.isArray(value)) {
    if (context && value.length > 0) state.hasImage = true
    for (const item of value) walkImages(item, key, urls, state, depth + 1, context)
    return
  }
  if (value && typeof value === 'object') {
    if (context) state.hasImage = true
    for (const [childKey, child] of Object.entries(value)) {
      walkImages(child, childKey, urls, state, depth + 1, context)
    }
  }
}
