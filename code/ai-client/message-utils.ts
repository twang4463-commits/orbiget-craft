/**
 * 消息工具函数 — think 标签剥离
 */

/**
 * 从 AI 响应文本中剥离 <think>...</think> 推理标签。
 * DeepSeek-R1、腾讯混元等推理模型会在响应中包含思考过程，
 * 这些内容不应直接展示给用户。
 */
export function stripThinkTags(text: string): { content: string; thinking: string } {
  let thinking = ''
  // 匹配完整的 <think>...</think> 标签
  const content = text.replace(/<think>([\s\S]*?)<\/think>/g, (_match: string, inner: string) => {
    thinking += inner.trim() + '\n'
    return ''
  // 处理未闭合的 <think> 标签（截断响应）
  }).replace(/<think>[\s\S]*$/g, (match: string) => {
    thinking += match.replace(/<think>/, '').trim() + '\n'
    return ''
  }).trim()
  return { content, thinking }
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/**
 * 流式**跨 chunk 有状态**的 think 标签剥离器。
 *
 * 为什么不能直接对每个增量跑 {@link stripThinkTags}：那条正则只认**同一个增量内
 * 完整闭合**的标签对，而 SSE 的切分位置由厂商随意决定，标签几乎必然跨块。实测
 * MiniMax-M3（思考型，`reasoningMode: 'tags'`）会把几百字思考摊成很多小增量，
 * `</think>` 单独落在某一块里 —— 闭合正则匹配不上，整段思考连同 `</think>`
 * 一起留在正文，用户直接看到模型的内心戏。
 *
 * 更糟的是它会**沉淀**：`stripThinking` 剥过的正文照样存进会话历史再回放给模型，
 * 于是模型下一轮读到自己上一轮的「用户发了 111，似乎是在测试」，人格被自己的
 * 思维链带跑，越聊越离谱（2026-10-18 用户实证）。所以这里必须跨块有状态。
 *
 * 用法：`push(chunk)` 逐块喂，流结束时 `flush()` 冲刷尾巴；两块分开累积即可。
 * 未闭合的 `<think>`（推理被 max_tokens 掐断）按推理内容处理，与 stripThinkTags 一致。
 */
export interface ThinkTagStreamFilter {
  /** 喂一个流式增量，分流出「正文」与「推理」两部分 */
  push: (chunk: string) => { content: string; thinking: string }
  /** 流结束：冲刷残留缓冲（已到句尾的文本此时才确定不是标签前缀） */
  flush: () => { content: string; thinking: string }
}

/**
 * 从 `from` 起，末尾可能构成 `tag` 真前缀的那段尾巴的起点。
 * 返回值用于「这段先别吐、留着等下一个块」—— 少了它，「<thi」+「nk>」会被漏判成正文。
 */
function partialTagTailStart(s: string, from: number, tag: string): number {
  const tail = s.slice(from)
  const max = Math.min(tag.length - 1, tail.length)
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(tail.slice(tail.length - k))) return s.length - k
  }
  return s.length
}

export function createThinkTagStreamFilter(): ThinkTagStreamFilter {
  let inThink = false
  /** 跨块保留的未定文本（最多 tag.length-1 个字符，只在含 `<` 时才会真的攒下来） */
  let hold = ''

  function drain(into: { content: string; thinking: string }) {
    let i = 0
    while (i < hold.length) {
      const tag = inThink ? THINK_CLOSE : THINK_OPEN
      const idx = hold.indexOf(tag, i)
      if (idx === -1) {
        // 找不到完整标签：把「可能构成标签前缀的尾巴」留在 hold，其余安全吐出
        const safeEnd = partialTagTailStart(hold, i, tag)
        const run = hold.slice(i, safeEnd)
        if (inThink) into.thinking += run
        else into.content += run
        hold = hold.slice(safeEnd)
        return
      }
      const run = hold.slice(i, idx)
      if (inThink) into.thinking += run
      else into.content += run
      inThink = !inThink
      i = idx + tag.length
    }
    hold = ''
  }

  return {
    push(chunk: string) {
      const out = { content: '', thinking: '' }
      if (!chunk) return out
      // 快路径：没有残留、且本块不含 `<` → 不可能是任何标签的任何一部分，原样透传。
      // 这条保证普通回复（几乎没有 `<`）零缓冲、零延迟地进 UI。
      //
      // ⚠️ **透传的去向要看 inThink**（2026-10-22 用户实证）：「本块不含 `<`」
      // 只说明它**不是标签**，不代表它是**正文** —— 思考块内部的普通文字照样不含 `<`。
      // 漏判的后果是整段思维链以正文身份进 UI：实测 MiniMax-M3 把 `<think>` 与
      // 思考的第一个词放在同一块（「<think>The」），后续思考增量里再没有 `<` ⇒
      // 全部走快路径 ⇒ 正文变成「The user is asking again what tools I have…」，
      // 而 `thinking` 只剩与标签同块的那一个词（实测就是 "The"）。
      if (!hold && !chunk.includes('<')) {
        if (inThink) out.thinking = chunk
        else out.content = chunk
        return out
      }
      hold += chunk
      drain(out)
      return out
    },
    flush() {
      const out = { content: '', thinking: '' }
      if (hold) {
        // 推理中途被掐断：尾巴里的未闭合内容算推理（与 stripThinkTags 的兜底一致）
        if (inThink) out.thinking = hold
        else out.content = hold
        hold = ''
      }
      return out
    },
  }
}

/**
 * 从模型输出里宽松提取 JSON。
 * 容忍：代码围栏（```json …```）、前后杂文/思维链散文、多余空白。
 * 策略：先整体试 parse；失败则取首个 `{…}` 或 `[…]` 子串再试；都不行抛错。
 * 与模板 json 契约配合：输出同构 JSON，这里只做最后的宽容兜底。
 */
export function parseJsonLoose(text: string): unknown {
  const t = String(text ?? '').trim()
  if (!t) throw new Error('empty')
  const fenced = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const candidates: string[] = [fenced]
  const obj = fenced.match(/\{[^]*\}/)
  if (obj) candidates.push(obj[0])
  const arr = fenced.match(/\[[^]*\]/)
  if (arr) candidates.push(arr[0])
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 试下一个候选
    }
  }
  throw new Error('not-json')
}
