/**
 * ChatGPT 网页版 SSE 帧解析(2026-10-26,web-tab 第三实例)。
 *
 * 输入:MAIN world 钩子转发的**原始 SSE 文本块**(可能跨块断行);
 * 输出:与 API 适配器同构的增量帧(content / thinking / done / error)。
 *
 * ## 协议形状(2026-10 逆向共识 + 容错设计)
 *
 * 补全端点 `POST /backend-api/(f/)?conversation`,响应 SSE:
 * `data: {json}` 行 + 结尾 `data: [DONE]`(无 event 名,判定只看 data 载荷)。
 * 载荷有**两代形态**,解析器双形态容错、按首帧锁模:
 *
 * · **全量快照**(经典,2024-2025 主流):每帧是整条 assistant 消息的快照,
 *   `message.content.parts[0]` **累积增长**,页面渲染最后一张快照。
 *   ⇒ 按 message.id 分桶记「已收长度」,delta = 全文.slice(已收);
 *   换 id(新消息/思考段)即重置基线。
 * · **v 增量**(更新的协议):`{"v": "文本"}`(增量)或
 *   `{"p": 路径, "o": "APPEND", "v": "文本"}`(补丁风格,与 DeepSeek 同形)。
 *   ⇒ v 字符串直接当增量;非 APPEND 的操作当 unknown 诊断。
 *   ⚠️ 裸 v / APPEND / REPLACE 三种帧**混排**是真实形态:replace 带的是
 *   **权威全量快照**,增量 = 快照 − 已发前缀(按路径记账,见
 *   `patchContent/patchThinking`);前缀对不上(页面重写了已发文本)发
 *   `reset` 帧让下游覆盖 —— 2026-10-29 真机:长度基线在混排下把已发尾巴
 *   整段重发,正文句中碎片交错重复两遍。
 * · 思考:推理模型的思考段是 `content.content_type === "thinking"` 的
 *   独立消息(或 reasoning 摘要),同快照切分逻辑分流到 thinking 通道。
 * · 错误:`error` 字段非空(风控/额度/审核),或 `data: [DONE]` 前的非 JSON 行。
 *
 * ⚠️ 纸面资料可能落后于页面真身(DeepSeek 初版全军覆没的教训还热着):
 * 首轮真机看 [occ-web-chat] 的 unknown 计数(驱动器 done 时会打)校正这里。
 * 规格:docs/implementation/deepseek-web-endpoint-2026-10-23.md(§6.15)。
 */

import type { WebChatFrame } from './deepseek-frames'

/** 快照里的 content 形状(只取我们关心的字段) */
interface SnapshotContent {
  content_type?: string
  parts?: unknown[]
}

interface SnapshotMessage {
  id?: string
  status?: string
  author?: { role?: string }
  /** 消息流向:'all' = 发给用户的可见消息;'image_gen' 等工具名 = 工具调用
   *  消息(content.parts 里是调用参数 JSON,页面不渲染)—— 绝不能当正文 */
  recipient?: unknown
  content?: SnapshotContent
}

export class ChatGPTFrameParser {
  private buffer = ''
  /** 'snapshot' = message 快照形态;'delta' = v 增量形态;null = 未锁定 */
  private mode: 'snapshot' | 'delta' | null = null
  /** 快照切分基线:当前 assistant 消息 id → **已发文本**(前缀对齐用) */
  private snapId = ''
  private snapText = ''
  private thinkId = ''
  private thinkText = ''
  /**
   * patch 分支的「已发文本」账本(2026-10-30 重写修复)。
   *
   * ⚠️ 为什么按路径记账,而不是记一个长度:replace 帧带的是**权威全量快照**,
   * 增量 = 快照 − 已发前缀。已发文本来自**三种帧的合力**(裸 v / patch APPEND /
   * replace 自己),只记 replace 的长度的话,append 过的尾巴会在下一个 replace
   * 到来时**整段重发**(2026-10-29 真机:正文句中碎片交错重复两遍)。
   */
  private patchContent = new Map<string, string>()
  private patchThinking = new Map<string, string>()
  /** 还没有路径归属的已发正文(裸 v / 无路径 v-array;首个 replace 到来时对齐用) */
  private bareContent = ''
  private bareThinking = ''
  /** 最近一次 patch 的目标路径(裸 v 的归属地) */
  private lastContentPath = ''
  private lastThinkPath = ''
  private readonly unknownLimit: number
  private unknownCount = 0

  constructor(options?: { unknownLimit?: number }) {
    this.unknownLimit = options?.unknownLimit ?? 8
  }

  push(chunk: string): WebChatFrame[] {
    this.buffer += chunk
    const frames: WebChatFrame[] = []
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
    if (!trimmed || !trimmed.startsWith('data:')) return [] // 空行/event 行:ChatGPT 不用 event 名,忽略
    const payload = trimmed.slice(5).trim()
    if (!payload) return []
    if (payload === '[DONE]') return [{ type: 'done' }]

    let obj: unknown
    try {
      obj = JSON.parse(payload)
    } catch {
      // 心跳/进度注释等非 JSON 行不算错误,静默忽略(页面自己也不解析它们)
      return []
    }
    if (obj == null || typeof obj !== 'object') return []
    const data = obj as Record<string, unknown>

    // ── type 信封(2026-10-26 真机样本:新流每帧带 type)──
    // 已确认无正文的元数据事件:直接忽略(不进 unknown,别刷诊断计数)
    const envelopeType = typeof data.type === 'string' ? data.type : ''
    if (IGNORE_EVENT_TYPES.has(envelopeType)) return []
    // 完成信号事件:等价 [DONE](有的轮次没有 [DONE] 行,靠它收口)
    if (envelopeType === 'message_stream_complete') return [{ type: 'done' }]

    // 错误优先:风控/额度/审核(页面拿到的错误卡同源)
    if (data.error != null) {
      const message = pickError(data.error)
      return [{ type: 'error', message: message || 'ChatGPT 页面返回错误' }]
    }

    // 思考型事件(thinking/reasoning 系):其增量分流 thinking 通道
    const thinkEvent = /think|reason/i.test(envelopeType)

    // ── v 帧族(2026-10-26 真机:正文增量是信封里带 v 的帧;「你想」两字
    //    就是从这里拼出来的)──
    if (typeof data.v === 'string' && data.v) {
      const patchPath = typeof data.p === 'string' ? data.p : ''
      // replace:作用在 content/parts 上是**权威全量快照**(整段替换)——
      // 按「已发前缀」切增量;对不上前缀(页面重写了已发文本)发 reset 全量替换。
      // status/metadata 的 replace 是元数据,不收
      if (typeof data.o === 'string' && data.o.toLowerCase() === 'replace') {
        if (patchPath && /parts|content/i.test(patchPath) && !/status|metadata/i.test(patchPath)) {
          const ledger = thinkEvent ? this.patchThinking : this.patchContent
          const prev = ledger.get(patchPath)
          ledger.set(patchPath, data.v)
          if (thinkEvent) this.lastThinkPath = patchPath
          else this.lastContentPath = patchPath
          // 同路径且已发文本是快照前缀 ⇒ 正常追加
          if (prev !== undefined && data.v.startsWith(prev)) {
            const delta = data.v.slice(prev.length)
            return delta
              ? [thinkEvent ? { type: 'thinking', delta } : { type: 'content', delta }]
              : []
          }
          if (prev === undefined) {
            // 该路径首次 replace:若与「无路径累积」同源(裸 v 先行、replace 才带路径),
            // 按前缀切;无关(换段:工具参数 → 正文)全量作为增量(旧行为)
            const bare = thinkEvent ? this.bareThinking : this.bareContent
            if (bare && data.v.startsWith(bare)) {
              const delta = data.v.slice(bare.length)
              if (thinkEvent) this.bareThinking = ''
              else this.bareContent = ''
              return delta
                ? [thinkEvent ? { type: 'thinking', delta } : { type: 'content', delta }]
                : []
            }
            return [thinkEvent ? { type: 'thinking', delta: data.v } : { type: 'content', delta: data.v }]
          }
          // 已发过但前缀分叉 / 文本变短 ⇒ 页面重写了已发文本,
          // 增量切不出干净边界(切了就是句中碎片重复) ⇒ 发 reset 让下游覆盖
          return [{ type: 'reset', channel: thinkEvent ? 'thinking' : 'content', text: data.v }]
        }
        return [{ type: 'unknown', raw: `patch:replace:${patchPath || '?'}:${data.v.slice(0, 120)}` }]
      }
      // 补丁操作不是 APPEND(REPLACE 上面已处理/DELETE…):语义不同,不瞎拼
      if (typeof data.o === 'string' && data.o.toUpperCase() !== 'APPEND') {
        return [{ type: 'unknown', raw: `patch:${String(data.o)}:${data.v.slice(0, 120)}` }]
      }
      // 显式补丁语义(带 p 或 o)不受锁模限制 —— 快照态下的 APPEND 照样追加
      if (patchPath || typeof data.o === 'string') {
        this.recordAppend(thinkEvent, patchPath, data.v)
        return [thinkEvent ? { type: 'thinking', delta: data.v } : { type: 'content', delta: data.v }]
      }
      // 裸 v:当增量追加(2026-10-30 起不再按锁模丢 —— replace 快照与裸增量
      // 混排是新协议的真实形态,丢了正文就缺一段)
      this.recordAppend(thinkEvent, '', data.v)
      return [thinkEvent ? { type: 'thinking', delta: data.v } : { type: 'content', delta: data.v }]
    }
    if (Array.isArray(data.v)) {
      const patchPath = typeof data.p === 'string' ? data.p : ''
      // v 数组(2026-10-26 真机二轮:正文增量的主流形状,`o` 常为 "patch"
      // 或缺省)—— 元素不是纯字符串,是 **patch 操作对象**(JSON-Patch 风格
      // {op,path,value} 一族):按「值语义」深挖,只收 value/v/text/content
      // 等字段,op/path 这类控制字段不进正文。
      const joined = collectArrayPatch(data.v)
      const op = typeof data.o === 'string' ? data.o.toUpperCase() : ''
      const okOp = op === '' || op === 'APPEND' || op === 'PATCH' || op === 'ADD'
      if (joined.text && okOp) {
        this.recordAppend(thinkEvent, joined.path || patchPath, joined.text)
        return [thinkEvent ? { type: 'thinking', delta: joined.text } : { type: 'content', delta: joined.text }]
      }
      // 采样带载荷:残留形态下一轮样本直接可读(这轮吃过「只回 v-array:」的亏)
      return [{ type: 'unknown', raw: `v-array:${String(data.o ?? '')}:${JSON.stringify(data.v).slice(0, 240)}` }]
    }
    if (data.v != null && typeof data.v === 'object') {
      // v 对象:内嵌 message 快照(新协议的首帧形态)就按快照解析
      const inner = (data.v as Record<string, unknown>).message
      if (inner != null && typeof inner === 'object') {
        this.mode = 'snapshot'
        return this.parseSnapshot(inner as SnapshotMessage)
      }
      // 采样带载荷:图片轮的资产指针(image_asset_pointer 一类)大概率藏在
      // 这类帧里 —— 下一轮样本直接可读
      return [{ type: 'unknown', raw: `v-object:${JSON.stringify(data.v).slice(0, 240)}` }]
    }
    // 信封里的另外两类潜在增量形状:parts 数组 / text 字段(无 v 的变体)
    if (Array.isArray(data.parts) || typeof data.text === 'string') {
      const joined = Array.isArray(data.parts)
        ? data.parts.filter(s => typeof s === 'string').join('')
        : (data.text as string)
      if (joined) {
        return [thinkEvent ? { type: 'thinking', delta: joined } : { type: 'content', delta: joined }]
      }
    }
    if (typeof data.p === 'string' || typeof data.o === 'string') {
      // 补丁风格但 v 不是字符串(状态/元数据 patch):unknown 诊断
      return [{ type: 'unknown', raw: `patch:${String(data.o ?? '')}` }]
    }

    // ── message 快照形态 ──
    const message = data.message
    if (message && typeof message === 'object') {
      return this.parseSnapshot(message as SnapshotMessage)
    }
    // 心跳/元数据帧(conversation_id 单独帧、moderation 等):不认识但无害
    return [{ type: 'unknown', raw: payload.slice(0, 120) }]
  }

  /** 快照切分:按 message.id 分桶,正文/思考各自记「已发文本」(前缀对齐) */
  private parseSnapshot(message: SnapshotMessage): WebChatFrame[] {
    const role = (message.author?.role ?? '').toLowerCase()
    if (role !== 'assistant') return [] // user/system/工具消息快照:忽略
    // 工具调用消息(2026-10-26 真机生图轮):recipient 指向工具名
    // (image_gen 等),content.parts 里是**调用参数 JSON** —— 页面不渲染,
    // 收进正文就是一段 JSON 噪音。发给用户的可见消息 recipient 是 'all'。
    const recipient = typeof message.recipient === 'string' ? message.recipient.trim() : ''
    if (recipient && recipient.toLowerCase() !== 'all') return []
    this.mode = 'snapshot'
    const content = message.content
    const contentType = content?.content_type ?? 'text'
    const text = (content?.parts ?? [])
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
    const isThinking = contentType === 'thinking' || contentType.startsWith('reasoning')
    if (!text) return []
    if (isThinking) {
      const sameId = message.id != null && message.id === this.thinkId
      const prev = sameId ? this.thinkText : ''
      // 同 id 但前缀对不上 = 重写 ⇒ 增量切不出干净边界,发 reset 全量替换
      if (sameId && !text.startsWith(prev)) {
        return [{ type: 'reset', channel: 'thinking', text }]
      }
      const delta = text.slice(prev.length)
      this.thinkId = message.id ?? ''
      this.thinkText = text
      return delta ? [{ type: 'thinking', delta }] : []
    }
    const sameId = message.id != null && message.id === this.snapId
    const prev = sameId ? this.snapText : ''
    if (sameId && !text.startsWith(prev)) {
      return [{ type: 'reset', channel: 'content', text }]
    }
    const delta = text.slice(prev.length)
    this.snapId = message.id ?? ''
    this.snapText = text
    return delta ? [{ type: 'content', delta }] : []
  }

  /**
   * 把一段 append 增量记进「已发文本」账本(2026-10-30)。
   *
   * 有路径 → 记到路径名下;无路径 → 记到最近路径(裸 v 延续上一次 replace 的
   * 目标),连最近路径都没有才进裸桶。后面的 replace 全量快照靠这本账对齐前缀,
   * 切出真正的增量 —— 记漏了就会整段重发(句中碎片重复的病根)。
   */
  private recordAppend(thinkEvent: boolean, patchPath: string, delta: string): void {
    if (!delta) return
    const ledger = thinkEvent ? this.patchThinking : this.patchContent
    const path = patchPath || (thinkEvent ? this.lastThinkPath : this.lastContentPath)
    if (path) {
      ledger.set(path, (ledger.get(path) ?? '') + delta)
      if (thinkEvent) this.lastThinkPath = path
      else this.lastContentPath = path
      return
    }
    if (thinkEvent) this.bareThinking += delta
    else this.bareContent += delta
  }
}

/** 确认无正文的信封事件(2026-10-26 真机样本):忽略,不进 unknown 计数 */
const IGNORE_EVENT_TYPES = new Set([
  'resume_conversation_token',
  'input_message',
  'message_marker',
  // 2026-10-26 图片轮样本:服务端遥测/会话元数据
  'server_ste_metadata',
  'conversation_detail_metadata',
])

/**
 * v 数组的「值语义」深挖:元素可能是纯字符串、字符串数组,或 patch 操作
 * 对象({op,path,value} 一族)—— 只收 value/v/text/content/part 字段里
 * 的文本,op/path 这类控制字段绝不进正文(拼错一个就是正文里混进
 * "APPEND" 之类的噪音)。
 *
 * 顺带回收**贡献了文本**的元素身上的 patch 路径:全部同路时作为这帧的
 * 归属路径(记账用);没有或有两个以上 ⇒ 空串(进裸桶)。
 */
function collectArrayPatch(arr: unknown[]): { text: string; path: string } {
  const out: string[] = []
  const paths = new Set<string>()
  const walk = (el: unknown, depth: number): void => {
    if (depth > 4 || el == null) return
    if (typeof el === 'string') {
      out.push(el)
      return
    }
    if (Array.isArray(el)) {
      for (const item of el) walk(item, depth + 1)
      return
    }
    if (typeof el === 'object') {
      const obj = el as Record<string, unknown>
      // 带 op 的操作对象:replace/remove 是状态与元数据 patch(status 等),
      // 只有 add/append/patch 是往正文追加 —— 其余不收(否则正文混进
      // "finished_successfully" 这类噪音)
      const op = typeof (obj.op ?? obj.o) === 'string' ? String(obj.op ?? obj.o).toLowerCase() : ''
      if (op === 'replace' || op === 'remove' || op === 'delete') return
      const path = typeof (obj.path ?? obj.p) === 'string' ? String(obj.path ?? obj.p) : ''
      if (path) paths.add(path)
      const val = obj.value ?? obj.v ?? obj.text ?? obj.content ?? obj.part
      walk(val, depth + 1)
    }
  }
  for (const item of arr) walk(item, 0)
  return { text: out.join(''), path: paths.size === 1 ? [...paths][0]! : '' }
}

/** error 字段的三种形态:字符串 / {message} / 嵌套 detail */
function pickError(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of ['message', 'detail', 'msg']) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
    }
  }
  return ''
}
