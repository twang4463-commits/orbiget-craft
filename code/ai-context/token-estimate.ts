/**
 * Token 估算 —— **单源**(2026-10-26)。
 *
 * ## 为什么在协议层
 *
 * 三处都要同一份口径,否则同一个会话在两个页面算出来的量不一样:
 * · 网页端点的**上限判断**(拍平后的历史能不能塞进页面输入框);
 * · 网页端点的**用量展示**(拿不到真实 usage,只能估算);
 * · 脑洞子项目的**用量统计**。
 *
 * ## 折算口径(中英混合,按分词逻辑而非「字数」)
 *
 * · 中文/日文/韩文:1 字 ≈ 1.5 token(CJK 的 BPE 通常 1-2 token)
 * · 英文:1 词 ≈ 1 token
 * · 数字:1 位 ≈ 0.25 token
 * · 标点/符号:1 字符 ≈ 0.3 token
 *
 * **为什么不是固定的「1 字 = 1 token」,也不是 chars/2.5**:中文一篇小说
 * 比同字数英文贵 50%;chars/2.5 对中文偏高、对英文偏低。按**分词逻辑**
 * 折算才接近真实。
 *
 * ## 为什么不引真 tokenizer
 *
 * 真 tokenizer(tiktoken/gpt-tokenizer)要带几 MB 的词表,且各家的
 * BPE 词表不同(DeepSeek/豆包/千问各一套)——引入后仍只能「猜这家是
 * 哪套」。折算口径够用(量级正确、UI 明示「估算」),不背这个依赖。
 */

/** 中日韩字符(一字 ≈ 1.5 token) */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/

/** 英文单词(一词 ≈ 1 token) */
const EN_WORD_RE = /[a-zA-Z]+/g

/** 数字(一位 ≈ 0.25 token) */
const DIGIT_RE = /\d+/g

/**
 * 估算文本的 token 数。
 *
 * ⚠️ **估算不等于精确**:给的是「大致量级」,用于用量展示、限流预警、
 * 上限判断 —— 不做精确结算。UI 上标注「估算」,别当真账。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let count = 0
  for (const char of text) {
    if (CJK_RE.test(char)) count += 1.5
    else if (/\s/.test(char)) count += 0
    else if (/[a-zA-Z]/.test(char)) count += 0 // 英文按词折算,词内字符不重复计
    else if (/\d/.test(char)) count += 0 // 数字按位折算,位内字符不重复计
    else count += 0.3 // 标点/符号
  }
  const enWords = text.match(EN_WORD_RE)
  if (enWords) count += enWords.length
  const digits = text.match(DIGIT_RE)
  if (digits) {
    for (const d of digits) count += d.length * 0.25
  }
  return Math.round(count)
}

/** 多段文本 → 总估算(每段独立估后求和) */
export function estimateMessagesTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + estimateTokens(t), 0)
}
