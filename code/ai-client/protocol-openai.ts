/**
 * OpenAI 兼容协议适配器（OpenAI / vLLM / SGLang / LM Studio / DeepSeek / 混元 / OpenRouter 等）
 */
import type { AIConnection, AIProtocolPreset } from './types'
import { supportsServerSearch } from './types'
import type { AIChatMessage, AIChatRequest, AIChatResponse } from './types'
import { AIClientError, messageText } from './types'
import { createThinkTagStreamFilter, stripThinkTags } from './message-utils'
import { buildHeaders, joinUrl, parseJson, postJson, providerError, resolveParam, toRequestError } from './http'
import { parseOpenAIToolCalls, assertContentOrToolCalls } from './tool-format'
import { DEFAULT_MAX_OUTPUT_TOKENS } from './types'

// ─── Body 构建 ───

/**
 * 内部 AIChatMessage → OpenAI 线格式：
 * tool 角色取 tool_call_id；assistant 带 tool_calls 时转 OpenAI 结构
 * （arguments 对象 → JSON 字符串、补 type:'function'、空 content → null）；
 * 普通消息原样透传。function calling 回填轮的必要转换（2026-09-16）。
 */
function toWireMessages(messages: AIChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m): Record<string, unknown> => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id }
    }
    if (m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: messageText(m.content) || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

export function buildOpenAIChatBody(
  settings: AIConnection,
  request: AIChatRequest,
  messages: AIChatMessage[],
  meta: AIProtocolPreset,
): Record<string, unknown> {
  const model = request.model || settings.model
  const supported = meta.supportedParams
  // 请求级 reasoning 优先于连接级（模板类快速任务在 handler 里强制 enabled:false，
  // 直接请求非思考，不被连接的推理配置带偏）
  const reasoningOn = request.reasoning != null
    ? Boolean(request.reasoning.enabled)
    : Boolean(settings.reasoning?.enabled)
  const effortReasoning = reasoningOn && meta.reasoningMode === 'effort'

  const body: Record<string, unknown> = {
    model,
    messages: toWireMessages(messages),
    stream: false,
  }

  // 非思考请求：tags 协议「默认思考」模型（deepseek-v4-flash 等）直接发非思考开关，
  // 让标题/润色等快速模板请求真·非思考，而不是让模型先思考再在协议层剥离。
  // 思考开启时（agent 对话等）不发——模型默认思考即可。
  if (!reasoningOn && meta.reasoningMode === 'tags' && meta.thinkingOffBody) {
    Object.assign(body, meta.thinkingOffBody)
  }

  if (request.tools?.length) {
    body.tools = request.tools
    body.tool_choice = request.toolChoice || 'auto'
  }

  // 请求级联网开关（聊天输入坞「联网搜索」）：enable_search 是 DashScope 私有参数，
  // 只有点开才发；协议级 serverSearch 声明在此仅作为「能力允许」条件
  if (request.webSearch && supportsServerSearch({ protocol: settings.protocol, model, baseUrl: settings.baseUrl })) {
    body.enable_search = true
  }

  if (effortReasoning) {
    body.reasoning_effort = settings.reasoning!.effort
    body.max_completion_tokens = resolveParam(settings, request, 'maxTokens', DEFAULT_MAX_OUTPUT_TOKENS)
  } else {
    body.temperature = request.temperature ?? settings.temperature
    if (supported.maxTokens) body.max_tokens = resolveParam(settings, request, 'maxTokens', DEFAULT_MAX_OUTPUT_TOKENS)
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
  const stripped = stripThinkTags(rawText)
  const text = stripThinking ? stripped.content : rawText
  // 推理过程两个来源：think 标签（本地模型常见）与 reasoning_content（DeepSeek/混元）。
  // 保留它才能让 AI 球显示人话思考，而不是「正在规划下一步」这类状态机术语。
  const thinking = [stripped.thinking, choice?.message?.reasoning_content]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n')
    .trim()
  const toolCalls = parseOpenAIToolCalls(choice?.message?.tool_calls)
  assertContentOrToolCalls(text, toolCalls, data, {
    finishReason: choice?.finish_reason,
    reasoningContent: choice?.message?.reasoning_content,
  })
  return {
    text,
    toolCalls,
    ...(thinking ? { thinking } : {}),
    provider: meta.id,
    model: data?.model || model,
    usage: data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
          // DeepSeek 提示词缓存上报（其他厂商无此字段则 undefined）
          ...(typeof data.usage.prompt_cache_hit_tokens === 'number'
            ? { cacheHitTokens: data.usage.prompt_cache_hit_tokens }
            : {}),
          ...(typeof data.usage.prompt_cache_miss_tokens === 'number'
            ? { cacheMissTokens: data.usage.prompt_cache_miss_tokens }
            : {}),
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
  onThinkingDelta?: (delta: string) => void,
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
      throw providerError(response, text)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    let respModel = model
    let usage: AIChatResponse['usage']
    let raw: unknown
    /** 推理过程累积：reasoning_content（DeepSeek/混元流式）+ content 内剥出的 think 标签 */
    let thinkingAcc = ''
    // think 标签**跨块**剥离器（流式必须跨块有状态，逐块跑 stripThinkTags 会在
    // 标签跨 SSE 块时失效，把整段思维链漏进正文 —— 见 message-utils 的说明）
    const thinkFilter = stripThinking ? createThinkTagStreamFilter() : null
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
            ...(typeof chunk.usage.prompt_cache_hit_tokens === 'number'
              ? { cacheHitTokens: chunk.usage.prompt_cache_hit_tokens }
              : {}),
            ...(typeof chunk.usage.prompt_cache_miss_tokens === 'number'
              ? { cacheMissTokens: chunk.usage.prompt_cache_miss_tokens }
              : {}),
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
        const thinkPiece = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
        if (thinkPiece) {
          thinkingAcc += thinkPiece
          onThinkingDelta?.(thinkPiece)
        }
        if (!piece) continue
        if (thinkFilter) {
          const { content: clean, thinking: thinkOut } = thinkFilter.push(piece)
          if (thinkOut) {
            thinkingAcc += thinkOut
            onThinkingDelta?.(thinkOut)
          }
          if (clean) {
            fullText += clean
            onDelta(clean)
          }
        } else {
          fullText += piece
          onDelta(piece)
        }
      }
    }

    // 流结束：冲刷过滤器的跨块残留（正常回复此时为空；推理被 max_tokens 掐断时带出尾巴）
    if (thinkFilter) {
      const tail = thinkFilter.flush()
      if (tail.thinking) {
        thinkingAcc += tail.thinking
        onThinkingDelta?.(tail.thinking)
      }
      if (tail.content) {
        fullText += tail.content
        onDelta(tail.content)
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
    const thinking = thinkingAcc.trim()
    return {
      text: fullText,
      toolCalls,
      provider: meta.id,
      model: respModel,
      usage,
      ...(thinking ? { thinking } : {}),
      raw,
    }
  } catch (error) {
    throw toRequestError(error, {
      externallyAborted: signal?.aborted,
      timeoutMessage: `流式请求空闲超时（${timeoutSeconds}s 无新数据）`,
      failurePrefix: 'AI 流式请求失败',
    })
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
