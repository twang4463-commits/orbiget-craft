/**
 * 粘贴超长段落自动分段 — 纯函数内核。
 *
 * ## 起因
 *
 * 用户 2026-10-13 实证：从别处复制粘贴扩写到 48,654 字，编辑器**没崩**
 * （实测单段 20 万字击键仅 1.74ms，与 400 段布局无差别 —— 段数不影响击键成本）。
 * 但结构被打坏了：
 *
 *   · 落盘 markdown 只有 **1 行**（48,664 字的单行文件，任何编辑器都难读）
 *   · `version-diff.ts` 的 `split(/\n\s*\n/)` 只认空行 → 版本对比退化成**1 个块**，
 *     改一个字整块变红，对比功能等于报废
 *
 * 所以本模块**不以"防崩溃"立论**（那个理由经实测不成立），而是修**结构**：
 * 一个段落不该是几万字。
 *
 * ## 三条硬纪律
 *
 * 1. **不增删不改任何字符** —— 只在句读边界**插入** `\n\n`。
 *    粘贴的内容原样保留，分段是排版，不是改写。
 * 2. **只在句末标点后断** —— 不切开一个句子。找不到句末才硬切（兜底）。
 * 3. **命中不了就不动** —— 没有超长段落的粘贴零改动；含内联原子节点（图片/附件）
 *    的段落一律不切（位置映射不可靠，宁可不动）。
 *
 * 纯函数：不碰 ProseMirror / Vue / DOM，可单测。
 */

/** 单段超过此长度才处理（字）。远高于人写的段落（常见 100~400 字），
 *  远低于任何会破坏结构的体量。 */
export const DEFAULT_MAX_PARAGRAPH_CHARS = 2_000

/**
 * 句末标点（中英）。切点落在这些字符**之后**。
 * 不含逗号顿号 —— 那不是句子结束，按逗号断会把长句切碎。
 */
const SENTENCE_END = new Set([
  '。', '！', '？', '；', '…',
  '.', '!', '?', ';',
  '”', '’', '」', '』', '"', "'",
  '）', '】', '》', ')', ']', '}',
])

/** 句末标点之后可以顺带吃掉的收尾字符（引号/括号 + 空白）——
 *  不断在这里会让下一段以「』」开头，违反中文排版禁则。 */
const TRAILING_CLOSERS = new Set([
  '”', '’', '」', '』', '"', "'", '）', '】', '》', ')', ']', '}',
  ' ', '\t', '\u3000',
])

/**
 * 算出切点集合（升序，元素是「该处之前断开」的字符下标）。
 *
 * @param text 单段纯文本
 * @param maxChars 单段上限
 * @returns 切点数组；空数组 = 不需要切
 */
export function computeParagraphCuts(text: string, maxChars: number = DEFAULT_MAX_PARAGRAPH_CHARS): number[] {
  if (!text || text.length <= maxChars) return []
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0
  if (!limit) return []

  const cuts: number[] = []
  let i = 0
  while (i + limit < text.length) {
    // 从「本段应当结束的位置」往回找最近的句末标点
    const hardEnd = i + limit
    let cut = -1
    for (let j = hardEnd - 1; j > i; j--) {
      if (SENTENCE_END.has(text[j])) { cut = j + 1; break }
    }
    // 找不到句末 → 硬切（这台段落可能是无标点的长串，如 URL / 英文长句）
    if (cut <= i) cut = hardEnd

    // 吃掉收尾引号/括号/空白：避免下一段以「』」「）」起头
    while (cut < text.length && TRAILING_CLOSERS.has(text[cut])) cut++

    // 防御：不前进就退出，否则死循环
    if (cut <= i) break
    cuts.push(cut)
    i = cut
  }
  return cuts
}

/** 按切点把单段切成多段（纯文本）。只在切点处插入分隔符，其余字符原样。 */
export function splitParagraphText(text: string, maxChars?: number): string[] {
  const cuts = computeParagraphCuts(text, maxChars)
  if (cuts.length === 0) return [text]
  const parts: string[] = []
  let prev = 0
  for (const cut of cuts) {
    parts.push(text.slice(prev, cut))
    prev = cut
  }
  parts.push(text.slice(prev))
  return parts.filter(p => p.length > 0)
}

/**
 * 在「按空行分段」的 markdown 上，对每个超长段做同样处理。
 * 供非 ProseMirror 场景（导入 / 纯文本处理）复用同一口径。
 */
export function splitOversizedParagraphs(md: string, maxChars?: number): string {
  if (!md) return md
  return md
    .split(/\n\s*\n/)
    .map(block => splitParagraphText(block, maxChars).join('\n\n'))
    .join('\n\n')
}
