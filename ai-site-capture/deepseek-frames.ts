/**
 * DeepSeek 网页端点 SSE 帧解析(2026-10-23;2026-10-24 按真机协议重写)
 *
 * 输入:MAIN world 钩子转发的**原始 SSE 文本块**(可能跨块断行);
 * 输出:与 API 适配器同构的增量帧(content / thinking / done / error)。
 *
 * ## 真机协议(2026-10-24 第四轮真机定案,逆向资料核对)
 *
 * DeepSeek 网页的补全流是 **JSON-Patch 风格**(`p` 路径 / `o` 操作 / `v` 值),
 * 不是 OpenAI 的 choices[].delta:
 *
 * · 普通模式正文:`{"p":"response/content","o":"APPEND","v":"文本"}`
 * · 深度思考(专家模式):先来一张快照 `{"v":{"response":{"fragments":[…]}}}`,
 *   之后增量走 `{"p":"response/fragments/-1/content","o":"APPEND","v":"…"}`,
 *   按**当前 fragment 类型**分流(THINK 段算思考,RESPONSE 段算正文);
 *   切段是 `{"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE",…}]}`
 *   (种子内容直接带在段上)。
 * · 纯 token 帧:`{"v":"文本"}`(无 p/o)——同样按当前 fragment 类型分流。
 * · 结束信号:`{"p":"response/status","v":"FINISHED"}`(**没有 [DONE]**)。
 * · 风控/限流错误:`type:"error"` 的 toast/hint 载荷(SSE `event: toast` 行被
 *   忽略,错误判定只看 data 载荷自身),或非零 `code` 帧。
 *
 * ⚠️ 初版纸面假设(`v` 字符串=思考、结束=[DONE])在真机上全军覆没:整段正文被
 * 归类成思考、content 恒空 ⇒ 脑洞侧「模型返回了空回复」。教训已写进规格
 * (deepseek-web-endpoint-2026-10-23.md 第四轮真机定案)。
 *
 * 容错设计:未识别帧进 unknown 诊断计数(不丢、不炸);驱动器在 done 时把计数
 * 打进日志 —— 协议再漂移时控制台一眼可辨。旧纸面形态(扁平 content /
 * choices[].delta / reasoning_content / [DONE])保留为兜底,留着无害。
 */

import type { WebChatFrame } from './types'

/** 兼容旧引用：契约现已居中在 `types.ts`（站点无关） */
export type { WebChatFrame } from './types'

/**
 * 增量解析器:维持行缓冲,feed 任意切割的文本块。
 * 用法:push(chunk) 返回本块解析出的帧;结束时 end() 冲刷残留缓冲。
 */
export class DeepSeekFrameParser {
  private buffer = ''
  /** 专家模式当前 fragment 类型:THINK 段增量算思考,RESPONSE 段算正文(缺省正文) */
  private fragmentKind: 'thinking' | 'content' = 'content'
  private readonly unknownLimit: number
  private unknownCount = 0

  constructor(options?: { /** 每个解析器实例保留的 unknown 帧原文条数(诊断用) */ unknownLimit?: number }) {
    this.unknownLimit = options?.unknownLimit ?? 4
  }

  push(chunk: string): WebChatFrame[] {
    this.buffer += chunk
    const frames: WebChatFrame[] = []
    // SSE 以行为单位;\r\n 与 \n 都认
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)
      for (const frame of this.parseLine(line)) {
        if (frame.type === 'unknown') {
          this.unknownCount++
          if (this.unknownCount <= this.unknownLimit) frames.push(frame)
        } else {
          frames.push(frame)
        }
      }
    }
    return frames
  }

  /** 流结束:缓冲里若还有未换行的残留 data 行,按最后一帧尝试解析 */
  end(): WebChatFrame[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (!rest) return []
    return this.parseLine(rest)
  }

  get unknownFrameCount(): number {
    return this.unknownCount
  }

  private parseLine(line: string): WebChatFrame[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    if (!trimmed.startsWith('data:')) return [] // 注释行/事件行:忽略(event 名不带语义,判定只看 data 载荷)

    const payload = trimmed.slice(5).trim()
    if (!payload) return []
    if (payload === '[DONE]') return [{ type: 'done' }]

    let obj: unknown
    try {
      obj = JSON.parse(payload)
    } catch {
      return [{ type: 'unknown', raw: payload.slice(0, 200) }]
    }
    if (obj == null || typeof obj !== 'object') return [{ type: 'unknown', raw: payload.slice(0, 200) }]
    const data = obj as Record<string, unknown>

    const error = parseErrorFrame(data)
    if (error) return [error]

    // ── JSON-Patch 帧(p/o/v):真机主流形态 ──
    if (typeof data.p === 'string' || typeof data.o === 'string') {
      return this.parsePatchFrame(data)
    }

    // ── 初始快照:v 是对象(response.fragments / response.content / status) ──
    if (data.v != null && typeof data.v === 'object') {
      return this.parseSnapshotFrame(data.v as Record<string, unknown>)
    }

    // ── 纯 token 帧:v 字符串(无 p/o):按当前 fragment 类型分流(缺省正文) ──
    if (typeof data.v === 'string') {
      return data.v ? [{ type: this.fragmentKind, delta: data.v }] : []
    }

    // ── 旧纸面形态兜底(API 风格;真实网页流不用,留着无害) ──
    const delta = getDelta(data)
    const content = typeof data.content === 'string' ? data.content
      : typeof delta?.content === 'string' ? delta.content
      : ''
    const thinking = typeof data.reasoning_content === 'string' ? data.reasoning_content
      : typeof delta?.reasoning_content === 'string' ? delta.reasoning_content
      : ''
    const finishReason = delta?.finish_reason ?? firstChoiceMessage(data)?.finish_reason
    const usage = extractUsage(data)
    const frames: WebChatFrame[] = []
    if (content) frames.push({ type: 'content', delta: content })
    if (thinking) frames.push({ type: 'thinking', delta: thinking })
    if (finishReason || usage) {
      frames.push({ type: 'done', ...(usage ? { usage } : {}) })
    }
    if (frames.length === 0) {
      // 心跳/空 delta 帧等:不算错误,静默忽略但计数
      return [{ type: 'unknown', raw: payload.slice(0, 200) }]
    }
    return frames
  }

  private parsePatchFrame(data: Record<string, unknown>): WebChatFrame[] {
    const p = typeof data.p === 'string' ? data.p : ''
    const v = data.v
    // 普通模式正文增量
    if (p === 'response/content') {
      return typeof v === 'string' && v ? [{ type: 'content', delta: v }] : []
    }
    // 专家模式 fragment 内增量:按当前 fragment 类型分流
    if (p === 'response/fragments/-1/content') {
      return typeof v === 'string' && v ? [{ type: this.fragmentKind, delta: v }] : []
    }
    // fragment 切段(THINK → RESPONSE):类型归位 + 种子内容
    if (p === 'response/fragments' && Array.isArray(v)) {
      return this.applyFragmentSeed(v[0] as Record<string, unknown> | undefined)
    }
    // 结束信号:status = FINISHED(其他状态值如进行中不算)
    if (p === 'response/status') {
      return v === 'FINISHED' ? [{ type: 'done' }] : []
    }

    // ── 三元组身份(2026-10-27)────────────────────────────────────────
    // 原先这几条全走「unknown 计数当漂移信号」,但它们是**本轮消息的身份证**
    // —— 对账全靠它们,不能当噪声丢。
    //
    // · 路径含 session / conversation / chat ⇒ 对话 id
    // · 路径含 message / msg / id ⇒ 本轮 assistant 消息 id
    //   (⚠️ `parent_message_id` 是**上一条**的 id,不收;本轮 id 只认
    //    `message_id` / `id` 这种不带 parent 的)
    //
    // 真机样本还没把字段名钉死(2026-10-27 纸面推断),所以**宽进**:匹配到
    // 哪个就报哪个;一个都没匹配上才退回 unknown(漂移信号仍在)。
    const ident = parseIdentPatch(p, v)
    if (ident) return [ident]

    // 其余路径:unknown 计数当漂移信号
    return [{ type: 'unknown', raw: p || String(data.o) }]
  }

  private parseSnapshotFrame(v: Record<string, unknown>): WebChatFrame[] {
    const response = v.response
    if (response == null || typeof response !== 'object') {
      return [{ type: 'unknown', raw: 'v-object' }]
    }
    const r = response as Record<string, unknown>
    if (Array.isArray(r.fragments) && r.fragments.length > 0) {
      return this.applyFragmentSeed(r.fragments[0] as Record<string, unknown> | undefined)
    }
    const frames: WebChatFrame[] = []
    const content = typeof r.content === 'string' ? r.content : ''
    if (content) frames.push({ type: 'content', delta: content })
    if (r.status === 'FINISHED') frames.push({ type: 'done' })
    if (frames.length === 0) return [{ type: 'unknown', raw: 'v-response' }]
    return frames
  }

  /** 记住 fragment 类型并(若有)发出种子内容;THINK/THINKING 都认,其余(RESPONSE)算正文 */
  private applyFragmentSeed(fragment: Record<string, unknown> | null | undefined): WebChatFrame[] {
    if (fragment == null || typeof fragment !== 'object') return []
    const type = typeof fragment.type === 'string' ? fragment.type : ''
    this.fragmentKind = type.toLowerCase().startsWith('think') ? 'thinking' : 'content'
    const seed = typeof fragment.content === 'string' ? fragment.content : ''
    return seed ? [{ type: this.fragmentKind, delta: seed }] : []
  }
}

/**
 * 三元组身份帧(2026-10-27)—— 把 JSON-Patch 里的会话 id / 消息 id 捞出来。
 *
 * ⚠️ 真机字段名还没钉死(纸面推断 + 用户截图的 DOM key),所以这里**宽进**:
 * 路径含 session / conversation / chat ⇒ 对话 id;含 message / msg / id ⇒
 * 消息 id(`parent_message_id` 是上一条的,不收)。拿到啥报啥;匹配不上
 * 返回 null,调用方退回 unknown 计数 —— 漂移信号不会因此丢。
 *
 * 真机样本一到就把这里收窄成精确字段名;现在宁可多认,不可漏认。
 */
function parseIdentPatch(p: string, v: unknown): WebChatFrame | null {
  const lower = p.toLowerCase()
  // parent_message_id 是上一条消息的 id,不是本轮的
  if (lower.includes('parent')) return null
  const value = typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : ''
  if (!value) return null

  // 对话 id:chat_session_id / session_id / conversation_id / conv_id …
  if (/session|conversation|conv\b|chat_id/.test(lower)) {
    return { type: 'ident', conversationId: value, role: 'assistant' }
  }
  // 本轮消息 id:message_id / msg_id / id(不带 parent)
  if (/message|msg|\/id$|\.id$|^id$/.test(lower)) {
    return { type: 'ident', messageId: value, role: 'assistant' }
  }
  return null
}

/** 错误帧三种形态:非零 code / type:"error" 载荷 / 内嵌 toast|hint 对象 */
function parseErrorFrame(data: Record<string, unknown>): { type: 'error'; message: string } | null {
  if (typeof data.code === 'number' && data.code !== 0) {
    return { type: 'error', message: pickErrorMessage(data) || `provider error code ${data.code}` }
  }
  const carriers: unknown[] = [data, data.toast, data.hint]
  for (const carrier of carriers) {
    if (carrier && typeof carrier === 'object' && (carrier as Record<string, unknown>).type === 'error') {
      return { type: 'error', message: pickErrorMessage(carrier as Record<string, unknown>) || 'provider error' }
    }
  }
  return null
}

function pickErrorMessage(data: Record<string, unknown>): string {
  for (const key of ['content', 'msg', 'message', 'description', 'finish_reason']) {
    const value = data[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** OpenAI 风格 choices[0].delta(真机网页流不用;API 风格兜底保留) */
function getDelta(data: Record<string, unknown>): Record<string, unknown> | null {
  const choices = data.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (first == null || typeof first !== 'object') return null
  const delta = (first as Record<string, unknown>).delta
  return delta != null && typeof delta === 'object' ? delta as Record<string, unknown> : null
}

function firstChoiceMessage(data: Record<string, unknown>): Record<string, unknown> | null {
  const choices = data.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (first == null || typeof first !== 'object') return null
  const message = (first as Record<string, unknown>).message
  return message != null && typeof message === 'object' ? message as Record<string, unknown> : null
}

function extractUsage(data: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = data.usage
  if (usage == null || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const inputTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined
  const outputTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined
  if (inputTokens == null && outputTokens == null) return undefined
  return { inputTokens, outputTokens }
}
