/**
 * Gemini 网页版流解析(2026-10-26,web-tab 第四实例)。
 *
 * 输入:MAIN world 钩子转发的**原始响应块**(可能跨块断行);
 * 输出:与 API 适配器同构的增量帧(content / done / error)。
 *
 * ## 协议形状(逆向共识 + 容错设计)
 *
 * Gemini 的流**不是 SSE**:响应体是一段段 `)]}'` 前缀的 JSON 文档
 * (Google 前端惯例哨兵),每段是一棵**深度嵌套的数组树**;正文增量藏在
 * 树的某个稳定路径上,跨段**累积增长**。⇒ 不去猜具体下标(必随版本漂移),
 * 用**路径级累积切分**:
 * · 对每段 JSON 深走,收集 (路径, 字符串值) 对;
 * · 同路径比上一次更长的部分就是增量(路径用 walk 下标/键拼出,流内稳定);
 * · 回声过滤:构造时传入本轮发送文本(折叠空白后缀),值里含它的是
 *   「我们发的话被整段回显」—— 跳过,绝不当正文;
 * · 噪音过滤:纯 uuid/hex、纯数字、URL、无空白长串(token/base64)、
 *   单字符 —— 都不是正文。
 *
 * ⚠️ Gemini 协议公开逆向资料最少(比 DeepSeek 初版还薄),首测大概率要
 * 照 ChatGPT 的路径走「unknown 样本 → 按样本修」。unknown 原文已进驱动器
 * done 日志(带载荷),真机一轮直接对账。
 * 规格:docs/implementation/deepseek-web-endpoint-2026-10-23.md(§6.17)。
 */

import type { WebChatFrame } from './deepseek-frames'

/** 折叠全部空白(回声比对口径,与桥/驱动器指纹一致) */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, '')
}

/** 是否「不是正文」的噪音值(单字符不算噪音 —— 交给 looksLikeProse 的散文闸) */
function isNoise(value: string): boolean {
  const v = value.trim()
  if (!v) return true // 空
  if (/^https?:\/\//i.test(v)) return true // URL
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true // uuid
  if (/^\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return true // 纯数字
  const collapsed = collapseWs(v)
  // 无空白超长串 = token/base64/签名,不是人话
  //
  // ⚠️ **中文正文没有空格**(2026-10-30 实测):照旧判,长中文会被整段当
  //   token —— 一次到齐的回答 ⇒ **0 字**(用户报「Gemini 无法返回消息」);
  //   流式回答跨过 120 字 ⇒ **在临界点停摆,后面全丢**(回答被截断)。
  //   ⇒ 含 CJK 就是人话,不进这条闸;token/base64 不含 CJK,照旧被滤。
  if (collapsed.length > 120 && !/\s/.test(v) && !/[\u3400-\u9fff\uf900-\ufaff]/.test(v)) return true
  return false
}

/**
 * 是否「像正文」(首见值的发放闸;2026-10-26 设计):Gemini 的树里有海量
 * 结构字符串('user'/'model'/'wrb.fr'/路径片段),首见就发会把它们全灌进
 * 正文 —— 只有含 CJK、或够长带空白的拉丁散文才认。代价:纯拉丁短回复
 * 的首段可能被吞,但它随后会增长(累积快照),增量照发。
 */
function looksLikeProse(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(v)) return true // CJK(单字也算)
  return v.length >= 12 && /\s/.test(v)
}

export class GeminiFrameParser {
  private buffer = ''
  /** 路径 → 已收长度(累积快照切增量的基线) */
  private lastByPath = new Map<string, string>()
  /** 本轮发送文本的折叠后缀(回声过滤;构造时传入) */
  private readonly sentCollapsed: string
  /** JSON 字符串递归深度(wrb.fr 的第三段是「JSON 字符串」状态,解一层继续走) */
  private jsonDepth = 0
  private readonly unknownLimit: number
  private unknownCount = 0

  constructor(options?: { unknownLimit?: number; sentText?: string }) {
    this.sentCollapsed = collapseWs(options?.sentText ?? '').slice(-400)
    this.unknownLimit = options?.unknownLimit ?? 8
  }

  push(chunk: string): WebChatFrame[] {
    this.buffer += chunk
    const frames: WebChatFrame[] = []
    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIndex + 1)
      for (const frame of this.processLine(line)) {
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

  /** 流结束:冲残留(最后一行可能没换行) */
  end(): WebChatFrame[] {
    const rest = this.buffer
    this.buffer = ''
    if (!rest.trim()) return []
    return this.processLine(rest)
  }

  get unknownFrameCount(): number {
    return this.unknownCount
  }

  private processLine(line: string): WebChatFrame[] {
    let trimmed = line.trim()
    if (!trimmed) return []
    // Google 哨兵 )]}' —— 一段 JSON 文档的前缀(可出现在行首)
    if (trimmed.startsWith(")]}'")) trimmed = trimmed.slice(4).trim()
    if (!trimmed) return []
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
      // 非文档行(纯哨兵残片等):静默忽略,不刷诊断
      return []
    }
    let doc: unknown
    try {
      doc = JSON.parse(trimmed)
    } catch {
      // 可能是跨块断了一半的文档:不进 unknown(换行重拼由缓冲负责),
      // 只有流结束时 end() 还解不开才当漂移
      return []
    }
    const frames: WebChatFrame[] = []
    this.walk(doc, '', frames)
    return frames
  }

  /** 深走 JSON 树,按路径比对累积长度,发增量 */
  private walk(node: unknown, path: string, frames: WebChatFrame[]): void {
    if (node == null) return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) this.walk(node[i], `${path}.${i}`, frames)
      return
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
      // JSON 字符串子树(jsonDepth ≥ 1)里的**对象**只走 "0" 键 —— 响应候选
      // 容器;其余键("7" 活动文案/"18" id 等)是元数据,不碰
      const filtered = this.jsonDepth >= 1
        ? entries.filter(([key]) => key === '0')
        : entries
      for (const [key, value] of filtered) this.walk(value, `${path}.${key}`, frames)
      return
    }
    if (typeof node !== 'string') return
    const value = node

    // JSON 字符串递归(2026-10-26 真机:wrb.fr 的第三段是「JSON 字符串」,
    // 真正文藏在它解析后的 "0" 键里 —— 响应候选容器;status/活动文案在别的
    // 键(如 "7" 的 "Organizing workshop structure"),不碰,免得混进正文。
    if ((value.startsWith('[') || value.startsWith('{')) && this.jsonDepth < 3) {
      this.jsonDepth += 1
      try {
        const inner = JSON.parse(value) as unknown
        if (Array.isArray(inner)) {
          this.walk(inner, `${path}:j`, frames)
        } else if (inner != null && typeof inner === 'object') {
          const zero = (inner as Record<string, unknown>)['0']
          if (zero != null) this.walk(zero, `${path}:j0`, frames)
        }
        this.jsonDepth -= 1
        return
      } catch {
        this.jsonDepth -= 1
        // 不是合法 JSON(比如 "[笑]"):按普通字符串继续走下面的闸
      }
    }

    // 噪音与回声:记名但不发(防止同一路径后续增长时被当成「首见」)
    if (isNoise(value)) {
      this.lastByPath.set(path, value)
      return
    }
    if (this.sentCollapsed && collapseWs(value).includes(this.sentCollapsed)) {
      this.lastByPath.set(path, value)
      return
    }
    const prev = this.lastByPath.get(path)
    if (prev != null) {
      if (value.length <= prev.length) return // 旧快照更短/等长:不退不重
      const delta = value.slice(prev.length)
      this.lastByPath.set(path, value)
      if (delta && looksLikeProse(delta)) frames.push({ type: 'content', delta })
      return
    }
    // 首见:只有「像正文」的才发(结构字符串只记名,不发)
    this.lastByPath.set(path, value)
    if (looksLikeProse(value)) frames.push({ type: 'content', delta: value })
  }
}
