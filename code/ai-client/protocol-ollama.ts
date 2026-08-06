/**
 * Ollama 协议适配器（开源抽离版）
 *
 * 与生产代码 src/ai/client/protocol-ollama.ts 一致，仅调整 import 来源。
 * 流式为 NDJSON（每行一个 JSON，非 SSE）。
 */
import type { AIConnection, AIProtocolPreset, AIChatMessage, AIChatRequest, AIChatResponse, AIToolCall } from './types'
import { stripThinkTags } from './message-utils'
import { joinUrl, postJson, resolveParam, streamFetchLines, parseJson } from './http'
import { parseOpenAIToolCalls, assertContentOrToolCalls } from './tool-format'

export async function callOllama(
  settings: AIConnection,
  request: AIChatRequest,
  messages: AIChatMessage[],
  stripThinking: boolean,
  meta: AIProtocolPreset,
  signal?: AbortSignal,
): Promise<AIChatResponse> {
  const model = request.model || settings.model
  const url = joinUrl(settings.baseUrl, 'api/chat')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    options: {
      temperature: resolveParam(settings, request, 'temperature', 0.7),
      top_p: resolveParam(settings, request, 'topP', 1),
      top_k: resolveParam(settings, request, 'topK', 40),
      num_predict: resolveParam(settings, request, 'maxTokens', 2048),
    },
  }
  if (request.tools?.length) {
    body.tools = request.tools
  }
  const data = await postJson(url, body, headers, request.timeoutSeconds ?? settings.timeoutSeconds ?? 120, signal)
  const rawText = data?.message?.content ?? ''
  const text = stripThinking ? stripThinkTags(rawText).content : rawText
  const toolCalls = parseOpenAIToolCalls(data?.message?.tool_calls)
  assertContentOrToolCalls(text, toolCalls, data)
  return {
    text,
    toolCalls,
    provider: 'ollama',
    model: data?.model || model,
    usage: data?.eval_count != null
      ? {
          inputTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
          totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        }
      : undefined,
    raw: data,
  }
}

// ─── 流式（NDJSON：每行一个 JSON，非 SSE） ───

export async function callOllamaStream(
  settings: AIConnection,
  request: AIChatRequest,
  messages: AIChatMessage[],
  stripThinking: boolean,
  meta: AIProtocolPreset,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AIChatResponse> {
  const model = request.model || settings.model
  const url = joinUrl(settings.baseUrl, 'api/chat')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    options: {
      temperature: resolveParam(settings, request, 'temperature', 0.7),
      top_p: resolveParam(settings, request, 'topP', 1),
      top_k: resolveParam(settings, request, 'topK', 40),
      num_predict: resolveParam(settings, request, 'maxTokens', 2048),
    },
  }
  if (request.tools?.length) {
    body.tools = request.tools
  }
  const timeoutSeconds = request.timeoutSeconds ?? settings.timeoutSeconds ?? 120

  let fullText = ''
  let usage: AIChatResponse['usage']
  let raw: unknown
  const toolCallBuffer: AIToolCall[] = []

  await streamFetchLines(url, headers, body, timeoutSeconds, signal, (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const chunk = parseJson(trimmed)
    if (!chunk || typeof chunk !== 'object') return
    raw = chunk
    const c = chunk as {
      done?: boolean
      eval_count?: number
      prompt_eval_count?: number
      model?: string
      message?: { content?: string; tool_calls?: unknown[] }
    }
    if (c.done) {
      if (c.eval_count != null) {
        usage = {
          inputTokens: c.prompt_eval_count,
          outputTokens: c.eval_count,
          totalTokens: (c.prompt_eval_count || 0) + (c.eval_count || 0),
        }
      }
      return
    }
    const content = c.message?.content
    if (typeof content === 'string' && content) {
      const piece = stripThinking ? stripThinkTags(content).content : content
      if (piece) {
        fullText += piece
        onDelta(piece)
      }
    }
    // Ollama 流式 tool_calls 通常在某个 chunk 完整出现（OpenAI 兼容格式）
    if (Array.isArray(c.message?.tool_calls) && c.message!.tool_calls!.length) {
      const parsed = parseOpenAIToolCalls(c.message!.tool_calls!)
      if (parsed) toolCallBuffer.push(...parsed)
    }
  })

  void meta
  const toolCalls = toolCallBuffer.length ? toolCallBuffer : undefined
  assertContentOrToolCalls(fullText, toolCalls, raw)
  return {
    text: fullText,
    toolCalls,
    provider: 'ollama',
    model: (raw as { model?: string })?.model || model,
    usage,
    raw,
  }
}
