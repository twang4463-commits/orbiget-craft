/**
 * 工具格式转换（开源抽离版）— OpenAI 兼容协议工具解析
 */
import { AIClientError, type AIToolCall } from './types'

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

export function assertContentOrToolCalls(text: string, toolCalls: AIToolCall[] | undefined, raw: unknown) {
  if (!text.trim() && !toolCalls?.length) {
    throw new AIClientError('AI provider returned an empty response', 'provider-error', raw)
  }
}
