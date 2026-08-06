/**
 * 消息工具函数（开源抽离版）— think 标签剥离
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
