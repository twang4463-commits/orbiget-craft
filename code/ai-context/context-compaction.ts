/**
 * Context Compaction — 历史消息的确定性压缩管道（**唯一真身**）
 *
 * 目标：让单次请求的上下文有稳定上限（历史是唯一没有硬顶的注入块）。
 * 分层策略（全部确定性，不做 LLM 二次摘要）：
 *   1. 近期消息保真：最后 RECENT_VERBATIM_COUNT 条只做超长保护截断；
 *   2. 旧消息瘦身：普通消息截到 OLDER_MAX_CHARS；
 *      旧工具结果（跨请求携带已无细节价值）压到 TOOL_RESULT_MAX_CHARS；
 *   3. 预算折叠：仍超 HISTORY_TOKEN_BUDGET 时，把最旧的消息折叠成
 *      单条「早前对话摘要」块，每条一行。
 *
 * 当轮新产生的工具结果不经此管道（本轮就要用全量），只在下次请求
 * 作为历史进来时被压缩。
 *
 * ## ⚠️ 为什么是「唯一真身」（2026-10-22 归一）
 *
 * 这里原先有**两份**判据逐字相同的实现：宿主这份（字符串内容）与
 * 脑洞子项目那份（内容可带图片分片），8 个预算常量全同。
 * 两份各改各的 ⇒ 同一个模型在不同页面记性不一样 ⇒ 已归一到本文件。
 *
 * 归一后的形状**兼容两者**：
 * · 宿主的 `AgentMessage`（content 是 string）直接能用；
 * · 脑洞的多模态消息（content 是分片数组）也能用 ——
 *   **只截文本分片，图片分片原样保留**（图片是「这一轮」的语义，
 *   截掉会改变这一轮的意思）。
 *
 * ## ⚠️ 多模态的「体积估算」
 *
 * 图片分片**不计文本量**（`textOf` 只取 text 分片）。
 * 这不是漏算：脑洞的历史里最多只留**最后一条**带图消息
 * （`brainstorm-chat.ts` 的 `lastImageIdx`），一张图 ≈ 4000 字符，
 * 相对 180k 的历史预算可忽略。
 *
 * ## 本文件的依赖边界
 *
 * 刻意不引任何**宿主/类型**依赖（包括 `AgentMessage`）⇒ 本文件
 * **运行时零外部依赖**，于是它能同时进 `@orbiget/craft-ai/protocol` 入口 ⇒
 * 脑洞子项目（独立运行时、零宿主依赖）直接 import 同一份实现。
 *
 * 唯一例外：同层的 `./token-estimate`（纯函数、零依赖）—— token 折算
 * 要与协议层那份同源，2026-10-26 之前这里是 chars/2.5 粗估，中英混排
 * 时误差能差一倍以上。
 */
import { estimateTokens } from './token-estimate'

// ── 预算参数 ──
//
// 2026-08-12 全部放开到 200k 窗口量级：原值（历史 6000 token / 30 条 / 600 字）
// 是按「省钱 + 保速度」定的小预算，但 200k 模型下输入成本可忽略（DeepSeek 输入
// ¥2/M），省这几千 token 换来的是模型记不住你们聊过什么。现在的档位只在逼近
// 200k 时才压缩，正常对话几乎永远全量保真。

/** 近期保真消息条数（约 3 个来回） */
const RECENT_VERBATIM_COUNT = 6
/** 近期消息的超长保护上限（防整章粘贴撑爆；200k 窗口下放宽到 2 万字） */
const RECENT_MAX_CHARS = 20000
/** 旧普通消息上限 */
const OLDER_MAX_CHARS = 6000
/** 旧工具结果上限（保留"查过什么、结论是什么"即可） */
const TOOL_RESULT_MAX_CHARS = 3000
/** 历史总预算（token，粗估口径与 context-builder 一致：chars / 2.5）。200k 窗口留出
 *  system prompt + 环境快照 + 输出的余量，取 180k。 */
const HISTORY_TOKEN_BUDGET = 180000
/**
 * 工作栈条数硬上限。200k 窗口下条数不再是瓶颈，放宽到 300 条（每条约 600 token
 * 时即接近预算，届时 token 折叠先触发）；只剩「消息极短但条数极多」的极端场景兜底。
 */
const MAX_WORKING_MESSAGES = 300
/** 折叠摘要中每条消息占一行的上限 */
const DIGEST_LINE_CHARS = 100

/**
 * 摘要块开头 —— **两层的协议**，只有这一份。
 *
 * 它同时是：
 * · 确定性管道折出来的摘要块的开头（`buildDigest` 写它）；
 * · LLM 摘要器（脑洞 `chat/compaction.ts` 产的摘要块）的开头。
 *
 * ⚠️ 两边**必须一致**：管道靠这个标记认出「这块已经压过了」⇒
 * 不一致就会把 LLM 摘要再折一次（摘要套摘要）。
 * ⇒ 脑洞那份 `COMPACTION_HEADER` 改为从这里取，不再各写一份字面量。
 */
export const COMPACTION_DIGEST_HEADER = '〔早前对话摘要（已压缩）〕'

// ── 形状 ──

/**
 * 消息分片 —— 只关心 `type` 与 `text`。
 *
 * 其余字段（图片的 `image_url` 等）原样保留，管道不碰。
 */
export interface CompressibleContentPart {
  type: string
  text?: string
}

/**
 * 一条可压缩的消息 —— `content` 可以是纯文本，也可以是分片数组。
 *
 * 宿主（`AgentMessage`，content 是 string）与脑洞（多模态，content 是分片数组）
 * 都满足这个形状。
 */
export interface CompressibleMessage {
  role: string
  content: string | CompressibleContentPart[]
}

/** 管道内部用的宽松形状（泛型外的实现细节） */
type LooseMessage = {
  role: string
  content: string | CompressibleContentPart[]
}

// ── 工具函数 ──

/** 取纯文本（图片等非文本分片不计文本量） */
function textOf(content: string | CompressibleContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('\n')
}

/**
 * 消息数组的 token 估算(供会话用量表复用)。
 *
 * ⚠️ 2026-10-26:口径从「chars/2.5 粗估」改为**与 token-estimate.ts 同一份
 * 折算**(中英分算)—— 中文与英文的粗估误差方向相反,混排时能差一倍以上。
 */
export function estimateMessagesTokens<M extends CompressibleMessage>(messages: M[]): number {
  let total = 0
  for (const m of messages) total += estimateTokens(textOf(m.content as LooseMessage['content']))
  return total
}

/** 掐头去尾式截断：保留开头与结尾，中间标注省略字数 */
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = Math.floor(maxChars * 0.25)
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n…〔中间省略 ${omitted} 字〕…\n${text.slice(text.length - tail)}`
}

/**
 * 旧工具结果消息：loop 注入的「工具 "X" 执行结果…」与确认闸门回执的
 * 「用户已确认/确认/取消了执行工具 "X"…」都按旧工具结果档位压缩，
 * 否则确认回执会被当普通消息（600 字档）截断，压缩分级失效。
 */
function isToolResultMessage(msg: LooseMessage): boolean {
  if (msg.role !== 'user') return false
  return /^(工具 "|用户已确认执行工具 "|用户确认执行工具 "|用户取消了执行工具 ")/.test(textOf(msg.content))
}

function toDigestLine(msg: LooseMessage): string {
  const who = msg.role === 'assistant' ? '助手' : '用户'
  const flat = textOf(msg.content).replace(/\s+/g, ' ').trim()
  const brief = flat.length > DIGEST_LINE_CHARS ? `${flat.slice(0, DIGEST_LINE_CHARS)}…` : flat
  return `- ${who}: ${brief}`
}

/** 把一批消息折成单条「早前对话摘要」块（已有的摘要块内容并入，避免摘要套摘要） */
function buildDigest(messages: LooseMessage[]): LooseMessage {
  const digestLines = messages
    .filter((m) => !textOf(m.content).startsWith(COMPACTION_DIGEST_HEADER))
    .map(toDigestLine)
  const carriedDigest = messages
    .filter((m) => textOf(m.content).startsWith(COMPACTION_DIGEST_HEADER))
    .map((m) => textOf(m.content).split('\n').slice(1).join('\n'))
    .filter(Boolean)
  return {
    role: 'user',
    content: [COMPACTION_DIGEST_HEADER, ...carriedDigest, ...digestLines].join('\n'),
  }
}

// ── 主管道 ──

export interface CompactionResult<M = CompressibleMessage> {
  messages: M[]
  /** 是否发生了任何压缩（供 debug 观测） */
  compacted: boolean
}

/** 主管道的实现（跑在宽松形状上，公开入口负责保型） */
function compressLoose(history: LooseMessage[], maxTokens = HISTORY_TOKEN_BUDGET): CompactionResult<LooseMessage> {
  if (history.length === 0) return { messages: [], compacted: false }

  let compacted = false
  const recentStart = Math.max(0, history.length - RECENT_VERBATIM_COUNT)

  // 1/2. 分层截断（全量，先于折叠 —— 保证摘要块不被二次截断丢数据）
  const clipped: LooseMessage[] = history.map((msg, i) => {
    const limit = i >= recentStart
      ? RECENT_MAX_CHARS
      : isToolResultMessage(msg)
        ? TOOL_RESULT_MAX_CHARS
        : OLDER_MAX_CHARS
    // 纯文本消息：整条按档位截断
    if (typeof msg.content === 'string') {
      const content = clipText(msg.content, limit)
      if (content !== msg.content) compacted = true
      return content === msg.content ? msg : { ...msg, content }
    }
    // 多模态：只对文本分片做保护性截断（拼接后判断超限才截）
    const text = textOf(msg.content)
    if (text.length <= limit) return msg
    const clippedText = clipText(text, limit)
    compacted = true
    return {
      ...msg,
      content: msg.content.map((p) =>
        p.type === 'text' ? { ...p, text: clippedText } : p,
      ),
    }
  })

  // 0. 条数硬上限：clipped 超过 MAX_WORKING_MESSAGES 条 → 折叠最旧的为摘要块
  //    保证工作栈永远 ≤ MAX 条 + 1 条摘要（聊再多也恒定，老的不丢只压缩）
  let source = clipped
  if (clipped.length > MAX_WORKING_MESSAGES) {
    const overflow = clipped.slice(0, clipped.length - MAX_WORKING_MESSAGES)
    const recent = clipped.slice(clipped.length - MAX_WORKING_MESSAGES)
    source = [buildDigest(overflow), ...recent]
    compacted = true
  }

  // 3. 仍超 token 预算 → 再折叠最旧的非近期消息为单条摘要块
  const foldStart = Math.max(0, source.length - RECENT_VERBATIM_COUNT)
  if (estimateMessagesTokens(source) <= maxTokens || foldStart === 0) {
    return { messages: source, compacted }
  }

  const older = source.slice(0, foldStart)
  const recent = source.slice(foldStart)
  const digest = buildDigest(older)
  return { messages: [digest, ...recent], compacted: true }
}

/**
 * 压缩历史消息。输入应为已 sanitize 的历史（不含 system prompt）。
 * 幂等：已压缩过的摘要块不会被二次折叠。
 *
 * 泛型保型：调用方拿到的是**自己的**消息类型（宿主的 `AgentMessage`
 * 不会被降级成宽松形状）。
 *
 * `maxTokens`：调用方给的**本连接**的历史预算（token 粗估）。
 * 默认 180k(200k 窗口的 API 连接)。**网页端点的历史预算小得多** ——
 * 页面输入框才是硬约束(容量由通道 adapter 声明,见 `protocol/ai-adapters.ts`):
 * 沿用大预算 ⇒ 历史永远压不下去 ⇒ 拍平时被粗暴丢弃(老的不留痕)。
 * 传小预算 ⇒ 老消息在这里就折成「早前对话摘要」(留痕、可复用)。
 */
export function compressHistoryMessages<M extends CompressibleMessage>(
  history: M[],
  options: { maxTokens?: number } = {},
): CompactionResult<M> {
  const result = compressLoose(history as unknown as LooseMessage[], options.maxTokens)
  return {
    messages: result.messages as unknown as M[],
    compacted: result.compacted,
  }
}
