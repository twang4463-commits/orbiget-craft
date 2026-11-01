/**
 * 豆包网页版 SSE 帧解析(2026-10-24;2026-10-27 对齐现网事件名)。
 *
 * 输入:MAIN world 钩子转发的**原始 SSE 文本块**(可能跨块断行);
 * 输出:与 API 适配器同构的增量帧(content / thinking / done / error)。
 *
 * ## 协议形状(2026-05 逆向资料 + 2026-10-27 现网 JS 核对)
 *
 * 豆包补全端点 /samantha/chat/completion 与 /chat/completion,响应 SSE:
 *
 * · 行首 `event: <NAME>` 带语义(与 DeepSeek 不同,判定**要看事件名**):
 *   CHUNK_DELTA / STREAM_MSG_NOTIFY / SSE_REPLY_END / STREAM_ERROR / ACK。
 *   ⚠️ 现网 JS 的事件枚举里**没有 STREAM_DONE** —— 结束事件是
 *   `SSE_REPLY_END`(数字码 100005);STREAM_DONE 仅旧页面遗留,继续认。
 * · CHUNK_DELTA:紧凑增量 `{"text":"…"}` —— 页面带 support_chunk_delta 时主流。
 * · STREAM_MSG_NOTIFY / patch_op 事件:结构化块
 *   `content.content_block[]` / `patch_op[].patch_value.content_block[]` /
 *   `content_blocks_v2[]`(现网消息形态),每块
 *   `{ block_type, content: { text_block: { text } } }`:
 *   - 10040 思考分隔符(第一次=进入思考,第二次=退出);
 *   - 2008 思考链增量;2001 正文增量;10000 思考模式下的主文本(按 inThinking 分流);
 * · STREAM_ERROR / 非零 error_code:错误(710022004 = 风控/验证码)。
 * · `data: {}` 心跳:忽略。
 *
 * ⚠️ 逆向资料是 2026-05 的豆包页面;装好后首轮真机如 unknown 计数暴涨,
 * 对照页面控制台 [occ-web-chat] 的 URL/事件足迹修这里。
 */

import type { WebChatFrame } from './deepseek-frames'

/** 结构化块里带 text 的位置(content.content_block / patch_value.content_block 同构) */
interface ContentBlock {
  block_type?: number
  content?: { text_block?: { text?: string } }
}

/**
 * 结束事件：现网是 `SSE_REPLY_END`（数字码 100005）；`STREAM_DONE` 是旧版
 * 逆向资料里的名字，继续认（旧页面/灰度）。
 */
const DONE_EVENTS = new Set(['STREAM_DONE', 'SSE_REPLY_END', '100005'])
/** 错误事件（现网 STREAM_ERROR / STREAM_MSG_ERROR；数字码 100006 / 109015） */
const ERROR_EVENTS = new Set(['STREAM_ERROR', 'STREAM_MSG_ERROR', '100006', '109015'])
/**
 * 认识但当前不产出正文的事件名 —— 不解析它们不会导致丢内容，但**不能**算
 * 协议漂移（否则 unknown 计数被心跳/控制事件淹没）。
 */
const KNOWN_EVENTS = new Set([
  'ACK', 'SSE_ACK', 'SSE_HEARTBEAT', 'SSE_LOADING_STATE', 'SSE_REPLY_END',
  'CHUNK_DELTA', 'STREAM_MSG_NOTIFY', 'STREAM_CHUNK', 'STREAM_MSG_START',
  'STREAM_MSG_END', 'STREAM_MSG_ERROR', 'FULL_MSG', 'FULL_MSG_NOTIFY',
  'ASYNC_CHUNK_SNAPSHOT', 'STREAM_TIMEOUT_CONTROL', 'FETCH_STREAM',
])

function isDoneCode(value: unknown): boolean {
  return value === 100005 || value === '100005' || value === 'SSE_REPLY_END'
}

function isErrorCode(value: unknown): boolean {
  return value === 100006 || value === '100006'
    || value === 109015 || value === '109015'
    || value === 'STREAM_ERROR' || value === 'STREAM_MSG_ERROR'
}

export class DoubaoFrameParser {
  private buffer = ''
  private currentEvent = ''
  /** 10040 分隔符计数:奇数次进入思考,偶数次退出 */
  private thinkSeparators = 0
  private readonly unknownLimit: number
  private unknownCount = 0
  /** 打点(2026-10-27 用户要求):每个 SSE 事件名只报一次 + 首条数据样本 */
  private readonly seenEvents = new Set<string>()
  private readonly sampledEvents = new Set<string>()
  private pendingSampleEvent = ''

  constructor(options?: { unknownLimit?: number }) {
    this.unknownLimit = options?.unknownLimit ?? 4
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

  private get inThinking(): boolean {
    return this.thinkSeparators % 2 === 1
  }

  private parseLine(line: string): WebChatFrame[] {
    const trimmed = line.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('event:')) {
      const name = trimmed.slice(6).trim()
      this.currentEvent = name
      if (name && !this.seenEvents.has(name)) {
        this.seenEvents.add(name)
        // 只报事件名（不报正文）：一轮下来就是豆包真实的 SSE 事件清单
        console.info('[occ-web-chat][doubao] SSE 事件:', name)
      }
      if (name && !this.sampledEvents.has(name)) this.pendingSampleEvent = name
      return []
    }
    if (trimmed.startsWith(':') || trimmed.startsWith('id:')) return []
    if (!trimmed.startsWith('data:')) return []
    const payload = trimmed.slice(5).trim()
    // 每个事件名的**首条**数据样本（截断 160 字）—— 帧形状核对用
    if (this.pendingSampleEvent) {
      const name = this.pendingSampleEvent
      this.pendingSampleEvent = ''
      this.sampledEvents.add(name)
      console.info('[occ-web-chat][doubao] 样本', name, '→', payload.slice(0, 160) || '(empty)')
    }
    if (!payload || payload === '{}' || payload === '[DONE]') {
      // 现网结束事件是 event: SSE_REPLY_END(数字码 100005),其后常跟 data: {};
      // 旧版 STREAM_DONE 与通用 [DONE] 继续认
      if (payload === '[DONE]' || DONE_EVENTS.has(this.currentEvent)) {
        return [{ type: 'done' }]
      }
      return []
    }

    let obj: unknown
    try {
      obj = JSON.parse(payload)
    } catch {
      return [{ type: 'unknown', raw: payload.slice(0, 200) }]
    }
    if (obj == null || typeof obj !== 'object') {
      return [{ type: 'unknown', raw: payload.slice(0, 200) }]
    }
    const data = obj as Record<string, unknown>
    /** 现网：事件类型也可能落在 payload 的 event_type 里（SSE event 名为空时） */
    const doneByData = isDoneCode(data.event_type)

    // 错误优先:事件名或非零 error_code(710022004 = 风控/验证码)
    if (ERROR_EVENTS.has(this.currentEvent) || isErrorCode(data.event_type) || nonZero(data.error_code)) {
      const message = str(data.error_msg) || str(data.event_data) || `豆包错误码 ${num(data.error_code)}`
      return [{ type: 'error', message }]
    }

    // CHUNK_DELTA:紧凑增量 {"text":"…"} —— 按当前思考状态分流
    const isChunkDelta = this.currentEvent === 'CHUNK_DELTA'
      || data.event_type === 1000010
      || data.event_type === 'CHUNK_DELTA'
    if (isChunkDelta && typeof data.text === 'string') {
      return data.text ? [{ type: this.inThinking ? 'thinking' : 'content', delta: data.text }] : []
    }

    // 结构化块:STREAM_MSG_NOTIFY 顶层 + patch_op 内嵌,同构遍历
    const blocks = collectBlocks(data)
    const frames: WebChatFrame[] = []
    for (const block of blocks) {
      const text = block.content?.text_block?.text
      const blockType = typeof block.block_type === 'number' ? block.block_type : 0
      if (blockType === 10040) {
        this.thinkSeparators += 1
        continue
      }
      if (!text) continue
      if (blockType === 2008) {
        frames.push({ type: 'thinking', delta: text })
      } else if (blockType === 2001) {
        frames.push({ type: 'content', delta: text })
      } else {
        // 10000(思考模式主文本)等:按当前思考状态分流
        frames.push({ type: this.inThinking ? 'thinking' : 'content', delta: text })
      }
    }

    if (DONE_EVENTS.has(this.currentEvent) || doneByData) {
      // 结束事件:先发完本行可能带的最后增量,再收口
      return frames.length > 0 ? [...frames, { type: 'done' }] : [{ type: 'done' }]
    }
    if (frames.length > 0) return frames
    // 纯分隔符(10040)/空文本块:已识别但无内容,不算漂移
    if (blocks.length > 0) return []
    // 认识的事件名 / 空 text 的 CHUNK_DELTA:同样不算漂移
    if (KNOWN_EVENTS.has(this.currentEvent) || isChunkDelta) {
      return []
    }
    return [{ type: 'unknown', raw: payload.slice(0, 200) }]
  }
}

/** 从事件对象里收集全部结构化块(content / patch_op / content_blocks_v2) */
function collectBlocks(data: Record<string, unknown>): ContentBlock[] {
  const out: ContentBlock[] = []
  const pushFrom = (holder: unknown): void => {
    if (Array.isArray(holder)) {
      for (const block of holder) {
        if (block && typeof block === 'object') out.push(block as ContentBlock)
      }
    }
  }
  // 现网消息形态(2026-10-27 线上 JS 核对):content_blocks_v2 数组直接挂在
  // 消息对象上;顶层与 message 里都收一份,形状仍是 { block_type, content: { text_block } }
  pushFrom(data.content_blocks_v2)
  const message = data.message
  if (message && typeof message === 'object') {
    pushFrom((message as Record<string, unknown>).content_blocks_v2)
  }
  const content = data.content
  if (content && typeof content === 'object') {
    pushFrom((content as Record<string, unknown>).content_block)
  }
  if (Array.isArray(data.patch_op)) {
    for (const op of data.patch_op) {
      if (!op || typeof op !== 'object') continue
      const pv = (op as Record<string, unknown>).patch_value
      if (!pv || typeof pv !== 'object') continue
      pushFrom((pv as Record<string, unknown>).content_block)
      // patch_object 102 的字符串 content 内嵌 {"text": "…"}(逆向资料里的兜底形态)
      const inner = (pv as Record<string, unknown>).content
      if (typeof inner === 'string' && inner) {
        try {
          const parsed = JSON.parse(inner) as { text?: string }
          if (typeof parsed.text === 'string' && parsed.text) {
            out.push({ block_type: 2001, content: { text_block: { text: parsed.text } } })
          }
        } catch {
          /* 不是 JSON 字符串就跳过 */
        }
      }
    }
  }
  // STREAM_MSG_NOTIFY 顶层也是 content_block(不带 content 包一层时的形态)
  pushFrom(data.content_block)
  return out
}

function nonZero(value: unknown): boolean {
  return typeof value === 'number' && value !== 0
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
