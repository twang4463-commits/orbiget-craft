/**
 * 网页端点共享契约 —— **站点无关**。
 *
 * 这个文件只描述「一端网页聊天长什么样」，不包含任何一家站点的 URL、
 * 选择器、事件名或协议细节。站点差异全部收在 `sites/<site>.ts`。
 *
 * 历史包袱：`WebChatFrame` 原先定义在 DeepSeek 的解析器里，别的站点反过来
 * import DeepSeek —— 改豆包要先看懂 DeepSeek。现在契约居中，解析器只是
 * 契约的一个实现。
 */

/** 与 API 适配器同构的增量帧（所有站点解析器共用） */
export type WebChatFrame =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  /**
   * **全量替换**（2026-10-30，ChatGPT 重写修复）—— 站点把**已发过的文本**
   * 整段重写了（markdown 归一化 / 列表重渲染 / 换段），增量切分对不上前缀。
   * 消费方必须**覆盖**对应通道的已累计文本（`content = text`），不能追加 ——
   * 否则旧文本残留、新旧交错（2026-10-29 真机：正文句中碎片重复两遍）。
   */
  | { type: 'reset'; channel: 'content' | 'thinking'; text: string }
  | { type: 'done'; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; message: string }
  /**
   * **三元组身份**（2026-10-27，DeepSeek 先落）—— 一轮的身份证。
   *
   * ```
   * (conversationId, messageId, role)
   * ```
   *
   * 这三个一起定「这是哪一轮的哪一条消息」：
   * · `conversationId` —— 一条对话线程的根（站点 URL / 请求体里的会话 id）
   * · `messageId` —— 这条对话里这一条消息的 id（请求体 `parent_message_id`
   *   是上一条的 id，返回流里那条「会话 id 等」路径是本轮的 id）
   * · `role` —— user 还是 assistant
   *
   * **对账 = 一行比对**：拉历史回来一条，本地有 `(convId, msgId, role)` ⇒ 丢；
   * 没有 ⇒ 补。不需要比内容、比时间、比指纹 —— 内容判重那套退役。
   */
  | { type: 'ident'; conversationId?: string; messageId?: string; role: 'user' | 'assistant' }
  /** 未识别帧（仅诊断：计数 + 保留原始行，帮助定位钩子漂移） */
  | { type: 'unknown'; raw: string }

/** 站点帧解析器契约 */
export interface WebFrameParser {
  push(chunk: string): WebChatFrame[]
  end(): WebChatFrame[]
  readonly unknownFrameCount: number
}

/** 解析器初始化参数：sentText = 本轮发送文本（回声过滤用） */
export interface ParserInit {
  sentText?: string
}

/**
 * 驱动 → 桥的附件载荷（2026-10-31）。
 *
 * 网页端点送图**不走请求体**（请求体是我们拍平出来的一段文字）⇒ 图片/
 * 文档作为独立的一份载荷交给桥，桥把它还原成 `File` 塞进页面上传管线。
 *
 * 为什么是 base64 而不是 Blob/URL：
 * · 桥在 ISOLATED world，拿不到驱动侧的 Blob；
 * · 页面里的上传接口要的是字节，URL 还得多一次跨域 fetch。
 */
export interface WebAttachFile {
  /**
   * 文件名（**必须带扩展名**）：站点按扩展名过滤 ——
   * DeepSeek 的白名单是扩展名（.png/.jpg/.pdf/.txt…），扩展名不对直接拒收。
   */
  name: string
  /** MIME（image/png 等） */
  mime: string
  /** base64 载荷（**不含** `data:` 前缀） */
  base64: string
}

/**
 * 站点差异的**驱动侧**答案（一个网页端点 = 一个 spec）。
 *
 * 注意：这里只放驱动需要的站点答案；抓取层的差异（URL 判定、选择器、
 * 注入策略、产物扫描、历史拉取）在 `capture/types.ts` 的 profile 里。
 */
export interface WebEndpointSpec {
  /** 协议 id（craft-ai preset 的 id；也作为 AIChatResponse.provider） */
  protocolId: string
  /** 展示名（错误文案：「豆包 页面未登录…」） */
  displayName: string
  /** 标签页 URL 模式（找标签 + 域名授权都用它） */
  urlPatterns: string[]
  /** 没有已开标签时新开的首页 */
  homeUrl: string
  /** 登录页（错误文案指路用） */
  loginUrl: string
  /** 首轮静默发送：不激活标签，后台驱动（2026-10-25） */
  backgroundFirst?: boolean
  /** 「激活一次，本会话不再抢」 */
  activateOncePerSession?: boolean
  /**
   * 发送窗口必须**真前台**（2026-10-30 深夜，Gemini 真机）。
   *
   * 谎报（`needsVisibilityLie`）骗的是**页面 JS**：`visibilityState` / `hidden` /
   * `hasFocus` 全是前台的样子。但站点还可能依赖浏览器层面只有真前台才给的东西
   * —— 被遮挡窗口里 `requestAnimationFrame` 不跑、渲染/合成停摆 —— 谎报够不着。
   *
   * 真机判据：Gemini 专窗离屏发送，桥 `submitted (round 1)` 成功（输入框已清），
   * 之后十来秒页面一直在打 Boq json / pagead 转化（页面 JS 是活的），却**一个
   * StreamGenerate 都没发** ⇒ 不是节流到死，是**选择性地不发**，谎报不能及。
   *
   * 开了这个开关 ⇒ 专窗也照样激活一次再发，发完 1.5s 把焦点还给用户原窗口
   * （沿用「抢完还回来」那套），且**每轮都激活**。
   */
  needRealForeground?: boolean
  /** 该站点专属的抓取脚本（每站独立 bundle；缺省用旧共享名） */
  hookScript?: string
  bridgeScript?: string
  /** 请求体指纹是否需要解码 \uXXXX / HTML 实体（Gemini 的编码形态） */
  decodeFingerprintEscapes?: boolean
  /**
   * 发送模式（2026-10-27）：
   * - `'replay'`（**默认**）：每轮把全量历史拍平成一条消息发出去 —— 页面每次
   *   都要重新吃一遍历史，页面上下文按轮次平方涨；
   * - `'delta'`：同一条分支（同一模型 + 同一页面线程）**只发新增的那一轮**，
   *   历史让页面自己留着（它本来就在每次请求里带全量上下文）。
   *
   * ⚠️ 默认仍是 `'replay'` —— 增量模式要真机验过（页面线程是否真的累积、
   * 指纹是否还对得上）再逐站翻默认。判定逻辑见 `capture/delta.ts`。
   */
  sendMode?: 'replay' | 'delta'
  createParser: (init?: ParserInit) => WebFrameParser
}



export function extractBodyIdent(body: string): { conversationId?: string; userMessageId?: string } {
  const out: { conversationId?: string; userMessageId?: string } = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return out
  }
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value == null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      const str = typeof val === 'string' && val ? val : typeof val === 'number' ? String(val) : ''
      if (str && !out.conversationId && /session|conversation|conv_id|chat_id/.test(lower)) {
        out.conversationId = str
      }
      if (str && !out.userMessageId && /parent_message|user_message|parent_msg|user_msg/.test(lower)) {
        out.userMessageId = str
      }
      walk(val, depth + 1)
    }
  }
  walk(parsed, 0)
  return out
}

/** 桥在端口上回放的帧形状（与 content-script/*-bridge.ts 入口对齐） */
export type BridgeFrame =
  | { kind: 'request'; requestId: string; body: string; foreign?: boolean; /** 广播序号（ACK 投递保证用；旧桥不带） */ seq?: number; /** 请求体形状摘要（键名/类型/长度，不含值） */ shape?: string }
  | { kind: 'chunk'; requestId: string; text: string }
  /** DOM 兜底捕获的整段重写（覆盖已累计文本，不能追加） */
  | { kind: 'reset'; requestId: string; text: string }
  | { kind: 'done'; requestId: string }
  | { kind: 'error'; requestId: string; message: string }
  | { kind: 'response-error'; requestId: string; status: number; contentType: string; preview: string }
  /** 产物动向：页面拉生成图 CDN，驱动器转 onToolStatus（正在画） */
  | { kind: 'activity'; label: string }
  /** 钩子诊断：响应头/首块/流结尾/请求体形状 —— 只进日志 */
  | { kind: 'diag'; requestId?: string; text: string }
