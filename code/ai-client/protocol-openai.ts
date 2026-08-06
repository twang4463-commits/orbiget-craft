/**
 * OpenAI 兼容协议适配器（开源抽离版）
 *
 * 支持 OpenAI / vLLM / SGLang / LM Studio / DeepSeek / 混元 / OpenRouter 等
 * 所有实现 /chat/completions 的服务商。
 *
 * 与生产代码 src/ai/client/protocol-openai.ts 逻辑一致，仅将
 * supportsServerSearch 的预设查询内联为直接参数，去掉设置模块依赖。
 */
import type { AIConnection, AIProtocolPreset, AIChatMessage, AIChatRequest, AIChatResponse } from './types'
import { AIClientError } from './types'
import { stripThinkTags } from './message-utils'
import { joinUrl, buildHeaders, postJson, resolveParam, parseJson } from './http'
import { parseOpenAIToolCalls, assertContentOrToolCalls } from './tool-format'

/**
 * 该连接是否支持服务端联网搜索（配置感知）。
 * ① 协议预设声明 serverSearch（qwen/DashScope）→ 达标；
 * ② 自定义兼容接口但端点就是 DashScope 且模型是 qwen 家族 → 也达标。
 * 达标 = 请求体自动带 enable_search，搜不搜由模型自行判断（DashScope 语义）；
 * 不达标 = 什么都不加，模型如实告知无联网能力。
 */
function supportsServerSearch(meta: AIProtocolPreset, model: string, baseUrl: string): boolean {
  if (meta.capabilities.serverSearch === true) return true
  // enable_search 是 DashScope 私有参数：端点必须是 dashscope，避免给其它服务商发未知字段
  if (
    meta.callProtocol === 'openai-compatible'
    && /dashscope\.aliyuncs\.com/i.test(baseUrl)
    && /qwen|qwq/i.test(model)
  ) {
    return true
  }
  return false
}

// ─── Body 构建 ───

export function buildOpenAIChatBody(
  settings: AIConnection,
  request: AIChatRequest,
  messages: AIChatMessage[],
  meta: AIProtocolPreset,
): Record<string, unknown> {
  const model = request.model || settings.model
  const supported = meta.supportedParams
  const reasoningOn = Boolean(settings.reasoning?.enabled)
  const effortReasoning = reasoningOn && meta.reasoningMode === 'effort'

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  }

  if (request.tools?.length) {
    body.tools = request.tools
    body.tool_choice = request.toolChoice || 'auto'
  }

  if (supportsServerSearch(meta, model, settings.baseUrl)) {
    body.enable_search = true
  }

  if (effortReasoning) {
    body.reasoning_effort = settings.reasoning!.effort
    body.max_completion_tokens = resolveParam(settings, request, 'maxTokens', 2048)
  } else {
    body.temperature = request.temperature ?? settings.temperature
    if (supported.maxTokens) body.max_tokens = resolveParam(settings, request, 'maxTokens', 2048)
    if (supported.topP) body.top_p = resolveParam(settings, request, 'topP', 1)
    if (supported.topK) body.top_k = resolveParam(settings, request, 'topK', 40)
    if (supported.frequencyPenalty) body.frequency_penalty = resolveParam(settings, request, 'frequencyPenalty', 0)
    if (supported.presencePenalty) body.presence_penalty = resolveParam(settings, request, 'presencePenalty', 0)
  }
  return body
}

// ─── 非流式 ───

export async function callOpenAICompatible(
  settings: AIConnection,
  request: AIChatRequest,
  messages: AIChatMessage[],
  stripThinking: boolean,
  meta: AIProtocolPreset,
  signal?: AbortSignal,
): Promise<AIChatResponse> {
  const model = request.model || settings.model
  const url = joinUrl(settings.baseUrl, 'chat/completions')
  const body = buildOpenAIChatBody(settings, request, messages, meta)
  const data = await postJson(url, body, buildHeaders(settings), request.timeoutSeconds ?? settings.timeoutSeconds ?? 60, signal)
  const choice = data?.choices?.[0]
  const rawText = choice?.message?.content ?? ''
  const text = stripThinking ? stripThinkTags(rawText).content : rawText
  const toolCalls = parseOpenAIToolCalls(choice?.message?.tool_calls)
  assertContentOrToolCalls(text, toolCalls, data)
  return {
    text,
    toolCalls,
    provider: meta.callProtocol,
    model: data?.model || model,
    usage: data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
    raw: data,
  }
}

// ─── 流式 ───

export async function callOpenAICompatibleStream(
  settings: AIConnection,
  request: AIChatRequest,
  messages: AIChatMessage[],
  stripThinking: boolean,
  meta: AIProtocolPreset,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AIChatResponse> {
  const model = request.model || settings.model
  const url = joinUrl(settings.baseUrl, 'chat/completions')
  // stream_options.include_usage: 让后端在流式结束时追加一个携带 usage 的 chunk
  // （OpenAI 默认流式不返回 usage，不加这个字段日志/统计就拿不到真实 token）
  const body = {
    ...buildOpenAIChatBody(settings, request, messages, meta),
    stream: true,
    stream_options: { include_usage: true },
  }
  const timeoutSeconds = request.timeoutSeconds ?? settings.timeoutSeconds ?? 60

  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), Math.max(15, timeoutSeconds) * 1000)
  }
  const onExternalAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  resetIdle()

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...buildHeaders(settings), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      const data = text ? parseJson(text) : null
      throw new AIClientError(
        data?.error?.message || data?.message || `AI provider returned ${response.status}`,
        'provider-error',
        data || text,
      )
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let respModel = model
    let usage: AIChatResponse['usage']
    let raw: unknown
    const toolCallAcc = new Map<number, { id: string; name: string; argsText: string }>()

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        const chunk = parseJson(payload)
        if (!chunk || typeof chunk !== 'object') continue
        raw = chunk
        if (chunk.model) respModel = chunk.model
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          }
        }
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0
            const acc = toolCallAcc.get(idx) ?? { id: '', name: '', argsText: '' }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (typeof tc.function?.arguments === 'string') acc.argsText += tc.function.arguments
            toolCallAcc.set(idx, acc)
          }
          continue
        }
        const piece = typeof delta.content === 'string' ? delta.content : ''
        if (!piece) continue
        const clean = stripThinking ? stripThinkTags(piece).content : piece
        if (clean) {
          fullText += clean
          onDelta(clean)
        }
      }
    }

    const toolCalls = toolCallAcc.size
      ? [...toolCallAcc.values()].map(tc => {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(tc.argsText || '{}') } catch {}
          return { id: tc.id, name: tc.name, arguments: args }
        })
      : undefined
    assertContentOrToolCalls(fullText, toolCalls, raw)
    return {
      text: fullText,
      toolCalls,
      provider: meta.callProtocol,
      model: respModel,
      usage,
      raw,
    }
  } catch (error) {
    if (error instanceof AIClientError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (signal?.aborted) throw new AIClientError('已停止', 'aborted', error)
      throw new AIClientError(`流式请求空闲超时（${timeoutSeconds}s 无新数据）`, 'network', error)
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new AIClientError(`AI 流式请求失败（${reason}）`, 'network', error)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
