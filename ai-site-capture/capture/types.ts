/**
 * 抓取层（MAIN world 钩子 + ISOLATED world 桥）的站点契约。
 *
 * 设计红线：`hook-core.ts` / `bridge-core.ts` **不许出现任何站点名、站点
 * 选择器或站点路径**。所有站点答案由 `sites/<site>.ts` 提供，并且每站
 * 打成独立 bundle —— 改豆包只碰豆包的 profile 与 bundle，DeepSeek 页面
 * 根本不会加载豆包的代码。
 */

/** MAIN world 钩子需要的站点答案 */
export interface HookSiteProfile {
  /** 站点 id（与目录/产物名一致：deepseek / doubao / chatgpt / gemini） */
  id: string
  /** 这是不是本轮补全请求（只看 URL；查询串/哈希已剥离） */
  isCompletionUrl(pathname: string, rawUrl: string): boolean
  /**
   * 网关路径（2026-10-31 Gemini）：补全 RPC 走共享网关（如 batchexecute）
   * 且 **rpcid 在 POST body 里**，URL 判不出来 —— 命中这些路径的请求先取
   * body 再用 `isCompletionBody` 复判。空/缺省 = 站点不走网关形态。
   * ⚠️ 只对命中路径多一次 body 读取（字符串 body 零成本），其余请求零开销。
   */
  gatewayPaths?: RegExp[]
  /** 网关请求体的补全判定（与 isCompletionUrl 并联） */
  isCompletionBody?(body: string): boolean
  /**
   * 非 SSE 的流形态。默认只认 `text/event-stream`；Gemini 的
   * StreamGenerate 是 `application/json` 的流式 body（`)]}'` 哨兵）。
   * 只看首块，不得消费。
   */
  isExtraStream?(contentType: string, head: string): boolean
  /** 流类型日志标签（诊断用；缺省 'sse' / 'json'） */
  streamLabel?(contentType: string, head: string): string
  /** 发送窗口是否需要「可见性/焦点谎报」能力（豆包这类隐藏文档会挂起交互） */
  needsVisibilityLie?: boolean
  /** 产物动向：这个路径是不是「正在生成媒体」（站点 CDN 形态不同，内核不猜） */
  activityForPath?(pathname: string): 'gen-image' | 'gen-video' | null
}

/** 桥在 DOM 里找到的输入框 */
export interface ComposerHandle {
  el: HTMLTextAreaElement | HTMLElement
  /** 命中的 selector（日志用） */
  selector: string
}

/** 产物扫描结果（与驱动器 BridgeFrame 的 media 形状同源） */
export interface SweptMedia {
  key: string
  url: string
  kind: 'image' | 'video' | 'audio'
}

/**
 * 页面 DOM 里「本轮生成媒体」的一条状态（2026-10-27）。
 *
 * 只描述容器，不描述服务端任务：`finished` 来自站点自己的完成标记
 * （豆包的 `data-finished`、视频的直链 src）。`key` 用于和发送时的基线
 * 做差，排除历史轮次一直躺在 DOM 里的网格。
 */
export interface MediaStatusEntry {
  key: string
  kind: 'image' | 'video' | 'audio'
  finished: boolean
  /** 容器内预期/已出现的产物数（图片网格一格一张；视频/音频通常 1） */
  count: number
}

/** 会话历史拉取的原始结果（映射在扩展侧 history-pull.ts） */
export interface HistoryPullResult {
  ok: boolean
  conversationId?: string
  url?: string
  raw?: string
  error?: string
}

/** ISOLATED world 桥需要的站点答案 */
export interface BridgeSiteProfile {
  /** 站点 id（与 HookSiteProfile.id 一致） */
  id: string
  /** 输入框候选（按优先级） */
  composerSelectors: string[]
  /** 发送键候选（按优先级） */
  sendButtonSelectors: string[]
  /**
   * 输入注入策略。缺省走通用管线（textarea 原生 setter / 富文本
   * paste→execCommand→合成事件）。只有确实需要特殊注入的站点才覆盖。
   */
  injectText?(composer: HTMLElement, text: string): boolean
  /** 发送前敲一轮键（部分富文本编辑器要「收过键盘事件」才解锁发送键） */
  keystrokeWarmup?: boolean
  /** 发送窗口是否需要可见性/焦点谎报 */
  needsVisibilityLie?: boolean
  /**
   * 「已提交」只认**补全请求帧**，不认输入框清空（2026-10-31 Gemini 真机）。
   *
   * 通用判据把「编辑器不再持有本轮文本」当提交成功，但富文本编辑器可能
   * 在重渲染/状态回滚时清空 DOM，实际一个请求都没发 ⇒ 桥报假 `submitted`，
   * 驱动干等 45s。开了以后 DOM 清空不再算证据；按钮未真正提交时还能走
   * Enter 重试轮，而不是假成功收口。
   */
  requireRequestEvidence?: boolean
  /**
   * 注入成功的判据升级为「发送键解锁」（2026-10-31 Gemini 真机）。
   *
   * 通用管线的落账检查只看「DOM 里出现了文本」，但 Gemini 的合成 paste
   * 只进 DOM 不进框架模型 —— DOM 有文本、发送键永远不亮，点发送/Enter
   * 都按兵不动。开了以后：每种注入手法落账后还要等到发送键出现才算
   * 成功；等不到就换下一种手法（paste → execCommand → 合成事件），
   * 全失败快速报 inject-failed，不再拿着假落账去点一个不存在的按钮。
   */
  verifySendButtonUnlock?: boolean
  /** 请求体指纹是否需要解 `\uXXXX` / HTML 实体（Gemini 的编码形态） */
  decodeEscapedFingerprint?: boolean
  /**
   * 发送键的**真身定位**（2026-10-31 真机；可选，优先于选择器表）。
   *
   * 为什么需要它：DeepSeek / 豆包现在的发送键都是**自定义控件**
   * （DeepSeek 是 `div.ds-button`，豆包是 `button[data-testid=…]`），
   * 没有任何一个能靠 `button[type=submit]` / `aria-label` / `class*=send`
   * 这类通用选择器命中 —— 真机实测那几个选择器的**命中数全是 0**。
   *
   * 站点答案可以给一个函数：按「输入坞容器里的实心/发送按钮」定位，
   * 比全局选择器准（页面上别处也有按钮，全局 querySelector 会挑错）。
   */
  findSendButton?(doc: Document): HTMLElement | null
  /**
   * 附件投递（2026-10-31 真机）。
   *
   * 网页端点也能把图片/文档送进模型 —— 靠**合成事件**把 `File` 交给页面
   * 自己的上传管线（我们不直接调它的接口：DeepSeek 的补全接口带 wasm
   * 工作量证明，页面自己发才是唯一正路）。
   *
   * 两种手法（真机都验过）：
   * · `paste`：合成 `ClipboardEvent`，`clipboardData` 里带 File ——
   *   **DeepSeek / 豆包都收**（豆包的拖拽只对「创作素材」功能开放，
   *   普通附件的入口就是粘贴）；
   * · `drop`：合成 `dragenter/dragover/drop` + `DataTransfer` ——
   *   DeepSeek 额外收（document 级捕获，路径含 completion）。
   *
   * 缺省 = **不支持**：站点没这条管线，或我们还没验过 ⇒ 驱动会明确报错，
   * 绝不静默把图丢掉（用户会以为图发出去了，模型只看到文字）。
   */
  attachments?: {
    /** 投递手法 */
    mode: 'paste' | 'drop'
    /**
     * 附件落地的判据（站点答案）：返回 true = 芯片已经出现。
     * 缺省用通用判据（输入坞里多了图或多了字）。
     */
    detect?(doc: Document): boolean
    /** 落地等待上限（ms）；缺省 8000 */
    settleMs?: number
  }
  /** 站点专属的「已生成媒体」DOM 扫描（缺省不扫） */
  sweepMedia?(doc: Document): SweptMedia[]
  /**
   * 本轮生成媒体的 DOM 状态（缺省不支持）。桥在发送时记一份 key 基线，
   * 之后驱动轮询只返回新出现的容器 —— 历史轮次的网格不会混进来。
   */
  readMediaStatus?(doc: Document): MediaStatusEntry[]
  /** 会话历史拉取（缺省 unsupported） */
  pullHistory?(): Promise<HistoryPullResult>
  /**
   * DOM 兜底轮次捕获（2026-10-31 Gemini）。补全协议迁到钩子看不见的
   * 传输形态（WebChannel 二进制 protobuf）时启用：桥安装即调，站点实现
   * 盯自己的语义标签（user-query / model-response），把轮次伪装成钩子
   * 同款 request/chunk/reset/done 帧发回同一条 postMessage 管道。
   * 归属判定、环形缓冲、回放、广播全部复用现有管线。
   */
  watchTurns?(): void
}
