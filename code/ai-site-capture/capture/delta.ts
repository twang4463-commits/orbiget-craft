/**
 * 「同分支只发新增」—— 让页面线程当工作记忆（2026-10-27）。
 *
 * ## 为什么改
 *
 * 原做法（规格 §2.3 的「每轮新会话 + 全量拍平」）：每轮把**全量历史**拍平成
 * 一条消息贴进页面输入框。代价有三个：
 *
 * · 页面里堆着**对话的 N 份副本** —— 上下文按轮次平方地涨，很快撞站点窗口
 *   （8k 回放 × N 轮 + 回答）；
 * · 往输入框里贴几千字：站点要处理大 contenteditable 粘贴 + 长文本校验 ⇒ 慢；
 * · 撞上限只能裁（丢历史、裁提问），而且是**静默**的。
 *
 * 改成：**同一条分支（同一模型 + 同一页面线程）只发新增的那一轮**，历史让页面
 * 自己留着（它本来就在每次请求里带全量上下文）。本地档案仍是权威副本 ——
 * 用来对账，以及「线程丢了就重放一次」。
 *
 * ## 页面自己的回答（2026-10-29 补）
 *
 * `sent` 是**发送那一刻**的本地历史，它一定以「本轮用户消息」结尾；页面答完
 * 会把回答追加进本地历史 —— 那条 assistant **页面自己已经有了**，不能再发。
 * 所以「缺的部分」从 `sent.length + 1` 开始（跳过紧跟其后的那条 assistant）。
 *
 * ## 跨窗口补记（2026-10-29）
 *
 * 同一个会话换了模型又切回来时，本地历史里多了**别家窗口**聊的轮次 —— 这些
 * 页面没有。它们不是「本轮新增」，但也不能丢：把缺的几条（用户 + 助手）拼成
 * 一条「补记」发过去，让页面接上这段上下文，然后才问本轮的问题。
 * 只有「缺的正好就是本轮这一条用户消息」时才走纯增量（页面里是一段正常对话）。
 *
 * ## 什么时候必须退回全量（replay）
 *
 * · **第一轮**：页面线程还是空的 ⇒ 页面没有历史，必须把历史带过去；
 * · **历史不接续了**（编辑 / 删除 / 重生成 / 压缩）⇒ 差集不再是「新增」；
 * · **线程换过**（会话地址变了，见 `threadChangedBetween`；专窗被回收）⇒ 页面里的历史已经不是我们的了。
 *
 * 这三种都退回全量拍平 —— 与改造前完全一致，**没有行为回退风险**。
 */
/** 内容分片的最小形状（OpenAI vision 格式；只关心 type） */
export type CaptureContentPart = { type: string } & Record<string, unknown>

function hasAttachmentPart(content: string | CaptureContentPart[]): boolean {
  if (typeof content === 'string') return false
  return content.some((p) => p.type === 'image_url' || p.type === 'file')
}

/** 纯附件轮次（只有图/文件、没有文字）在文本通道里的占位正文 */
export const ATTACHMENT_ONLY_TEXT = '（见附件）'

/** 一条消息的快照（只留判定需要的两个字段） */
export interface TurnSnapshot {
  role: string
  text: string
}

/** 发送计划：只发新增 / 补记跨窗口缺的轮次 / 退回全量 */
export type DeltaPlan =
  | { mode: 'delta'; added: TurnSnapshot[] }
  | { mode: 'supplement'; missing: TurnSnapshot[] }
  | { mode: 'replay'; reason: 'first-turn' | 'not-extended' | 'thread-changed' | 'no-user-turn' }

/** 判定「这轮发什么」 */
export function planDelta(
  sent: TurnSnapshot[] | null,
  next: TurnSnapshot[],
  options: { threadChanged?: boolean } = {},
): DeltaPlan {
  if (options.threadChanged) return { mode: 'replay', reason: 'thread-changed' }
  if (!sent || sent.length === 0) return { mode: 'replay', reason: 'first-turn' }
  if (next.length <= sent.length) return { mode: 'replay', reason: 'not-extended' }
  // 前缀必须逐条相同 —— 否则历史被改过（编辑/删除/压缩），差集没有意义
  for (let i = 0; i < sent.length; i += 1) {
    if (sent[i].role !== next[i].role || sent[i].text !== next[i].text) {
      return { mode: 'replay', reason: 'not-extended' }
    }
  }
  // 紧跟在发送前缀后面的那条 assistant = 页面自己对上一轮的回答（页面已有）
  let pageHas = sent.length
  if (next[pageHas]?.role === 'assistant') pageHas += 1
  const missing = next.slice(pageHas)
  // 一条用户消息都没有 ⇒ 没有可问的（别发空）
  if (!missing.some((m) => m.role === 'user')) return { mode: 'replay', reason: 'no-user-turn' }
  // 只缺本轮这一条用户消息 ⇒ 正常增量（页面里就是一段正常对话）
  if (missing.length === 1 && missing[0].role === 'user') return { mode: 'delta', added: missing }
  // 缺了别的窗口聊的轮次 ⇒ 补记：用户 + 助手都要带上，页面才知道中间发生了什么
  return { mode: 'supplement', missing }
}

/**
 * 消息数组 → 快照（文本分片拼起来；图片在网页端点不参与，见 web-transport）。
 *
 * ⚠️ **system 不进快照**：增量模式下 system 只在分支首轮发一次（页面里留着），
 * 而 system 每轮可能变（项目地图刷新）⇒ 把它算进前缀比较会**每轮都退回全量**。
 */
export function toSnapshots(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
): TurnSnapshot[] {
  return messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    // 纯附件轮也要有非空正文：空串会让增量发送塌成空文本（归属指纹丢失），
    // 页面端随后把它当成「用户手动发的」再记一遍（2026-10-31 真机）。
    text: (typeof m.content === 'string'
      ? m.content
      : m.content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'))
      || (hasAttachmentPart(m.content as string | CaptureContentPart[]) ? ATTACHMENT_ONLY_TEXT : ''),
  }))
}

/**
 * 增量模式下贴进输入框的正文。
 *
 * 只有一条用户消息时就贴它本身（页面里就是一段正常对话）；多条用户消息不会
 * 走到这里 —— 跨窗口缺的轮次由 {@link renderSupplementText} 补记。
 */
export function renderDeltaText(added: TurnSnapshot[]): string {
  return added.map((m) => m.text).filter((t) => t.trim()).join('\n\n')
}

/**
 * 「补记」正文：把这个窗口没看到的几轮拼成一段上下文，末尾才是本轮的问题。
 *
 * 页面只能往输入框里贴**一条**消息 ⇒ 补记和本轮问题必须在同一条正文里；
 * 末尾放问题（而不是补记结束标记）—— 模型和指纹都以最后一段为准。
 */
export function renderSupplementText(missing: TurnSnapshot[]): string {
  const last = missing[missing.length - 1]
  const hasQuestion = last?.role === 'user'
  const context = hasQuestion ? missing.slice(0, -1) : missing
  const lines = context
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`)
    .filter((line) => line.trim())
  return [
    '〔补记 · 你不在这个窗口时，这边的对话继续了〕',
    ...(lines.length ? [lines.join('\n\n')] : []),
    '〔补记结束〕',
    ...(hasQuestion && last ? ['', last.text] : []),
  ].filter(Boolean).join('\n\n')
}

/**
 * 页面地址 → 会话路径（只留 pathname，去掉末尾斜杠；首页 = `''`）。
 *
 * 查询串 / 片段不算：同一条会话后面挂了参数，不能因此判成换线程。
 * 地址取不到或不是合法 URL ⇒ `undefined`。
 */
export function conversationPath(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).pathname.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/**
 * 线程是否换过：只比**会话路径**。
 *
 * ⚠️ 不能比原始地址：DeepSeek 在首页发出第一条消息后地址会变成 `/a/chat/s/<id>`，
 *   拿发送前的首页地址当「上一轮」⇒ 第二轮必然判成换线程 ⇒ 每轮都全量重放。
 * 地址取不到 ⇒ false（不下结论，交给其它判据）。
 */
export function threadChangedBetween(prevUrl: string | undefined, nextUrl: string | undefined): boolean {
  const prev = conversationPath(prevUrl)
  const next = conversationPath(nextUrl)
  if (prev === undefined || next === undefined) return false
  return prev !== next
}
