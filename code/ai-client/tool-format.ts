/**
 * 工具格式转换 — OpenAI 兼容协议工具解析
 */
import { AIClientError, type AIToolCall } from './types'
import { parseDsmlToolCalls as parseDsmlToolCallsBase, stripDsmlBlocks } from './dsml'

// ─── 响应解析 ───

export function parseOpenAIToolCalls(rawToolCalls: unknown): AIToolCall[] | undefined {
  if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) return undefined
  return rawToolCalls.map((tc: {
    id?: string
    function?: { name?: string; arguments?: string | Record<string, unknown> }
  }) => {
    let args: Record<string, unknown> = {}
    const rawArgs = tc.function?.arguments
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs || '{}') } catch {}
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs as Record<string, unknown>
    }
    return {
      id: tc.id || '',
      name: tc.function?.name || '',
      arguments: args,
    }
  })
}

// ─── DSML 内嵌工具调用解析（2026-09-16 脑洞实测）───

/**
 * ⚠️ **实现真身已归位到 `protocol/dsml.ts`**（2026-10-24）。
 *
 * 归一前宿主这份与脑洞子项目 `src/dsml.ts` 逐字相同（33 行对 33 行）⇒ 两份各改各的。
 * 现在**只有 protocol 那一份**，本文件只保留 client 侧的返回类型（`AIToolCall`）。
 */
export function parseDsmlToolCalls(text: string): AIToolCall[] {
  return parseDsmlToolCallsBase(text)
}

export { stripDsmlBlocks }


function safeJsonSnippet(raw: unknown): string {
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
    return (s || '').slice(0, 240)
  } catch {
    return ''
  }
}

export function assertContentOrToolCalls(
  text: string,
  toolCalls: AIToolCall[] | undefined,
  raw: unknown,
  opts?: { finishReason?: string; reasoningContent?: string },
) {
  if (!text.trim() && !toolCalls?.length) {
    const snippet = safeJsonSnippet(raw)
    // 思考模型 + 预算被 thinking 吃光：chat.completion 里 reasoning_content 有货、
    // content 为空 → 连接其实是通的，把原始响应带出来避免误当「空响应」
    const hasReasoning = typeof opts?.reasoningContent === 'string' && opts.reasoningContent.trim().length > 0
    throw new AIClientError(
      hasReasoning
        ? `AI 返回了思考但未写出正文（finish_reason=${opts?.finishReason ?? '?'}）：模型把输出预算耗在了思考上，可加大 max_tokens 重试${snippet ? `。原始响应：${snippet}` : ''}`
        : `AI 返回空内容（未找到 choices[].message.content）${snippet ? `。原始响应：${snippet}` : ''}`,
      'provider-error',
      raw,
    )
  }
  // 思考模式截断：finish_reason=length + 有 reasoning + 没写出 tool_calls。
  // 此时模型已开了思考（reasoning_content 非空），却因预算耗尽无法把工具调用
  // 写进原生 tool_calls 字段 —— 它往往会退而在 content 里用**文本**模拟调用
  // （「调用能力 X，参数 {...}」）。这里主动抛错，让 Agent 层识别后加大预算重试；
  // 不抛的话，raw JSON 文本会被当成正常回答漏给用户（截图里的"执行失败"）。
  if (
    opts?.finishReason === 'length'
    && !toolCalls?.length
    && typeof opts.reasoningContent === 'string'
    && opts.reasoningContent.trim().length > 0
  ) {
    throw new AIClientError('模型思考耗尽输出预算，工具调用未完成（finish_reason=length）', 'provider-error', raw)
  }
}
