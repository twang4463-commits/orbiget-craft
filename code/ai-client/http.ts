/**
 * HTTP 层（开源抽离版）— 请求发送、头部构建、URL 拼接、JSON 解析、参数解析
 *
 * 与生产代码 src/ai/client/http.ts 一致，仅调整 import 来源。
 * 核心语义不变：
 * - postJson：总时长闸门
 * - streamFetchLines：空闲闸门（只要持续有新数据就不会超时，长产出不被误杀）
 * - 外部中断（用户「停止」）与内部超时合并为同一 AbortController
 */
import type { AIConnection, AIProfile } from './types'
import { AIClientError, type AIChatRequest } from './types'

// ─── URL 工具 ───

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return `${base}/${suffix}`
}

// ─── JSON 解析 ───

export function parseJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

// ─── 头部构建 ───

export function buildHeaders(settings: AIConnection): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`
  }
  return headers
}

// ─── 参数解析 ───

/** 解析单个调优参数：请求显式覆盖优先，否则回退 settings，再回退默认值 */
export function resolveParam(settings: AIConnection, request: AIChatRequest, key: keyof AIProfile, fallback: number): number {
  const reqVal = (request as unknown as Record<string, unknown>)[key as string]
  if (typeof reqVal === 'number' && Number.isFinite(reqVal)) return reqVal
  const setVal = (settings as unknown as Record<string, unknown>)[key as string]
  if (typeof setVal === 'number' && Number.isFinite(setVal)) return setVal
  return fallback
}

// ─── 非流式请求 ───

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutSeconds: number,
  externalSignal?: AbortSignal,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000)
  // 外部中断（用户「停止」）与内部超时合并：任一触发都断开 fetch
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    const data = text ? parseJson(text) : null
    if (!response.ok) {
      throw new AIClientError(
        data?.error?.message || data?.message || `AI provider returned ${response.status}`,
        'provider-error',
        data || text,
      )
    }
    return data
  } catch (error) {
    if (error instanceof AIClientError) throw error
    // 透传真实原因：外部中断、超时、网络错误分开说，别都压成一句 "AI request failed"
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) throw new AIClientError('已停止', 'aborted', error)
      throw new AIClientError(`请求超时（${timeoutSeconds}s）：模型未在时限内完成输出，可稍后重试或在设置中调大超时`, 'network', error)
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new AIClientError(`AI 请求未到达服务商（${reason}）：检查网络或站点权限`, 'network', error)
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

// ─── 流式请求（SSE / NDJSON 通用骨架） ───

/**
 * 流式读取响应并按行回调：处理 fetch + AbortController（外部中断 + 空闲超时合并）
 * + reader + 跨 chunk 行缓冲。调用方在 onLine 里解析每行（SSE 的 `data:` 前缀、
 * NDJSON 的裸 JSON 等）。
 *
 * 与 postJson 的超时语义不同：postJson 是总时长闸门，流式是空闲闸门——
 * 只要持续有新数据就不会超时，长产出不被误杀。
 */
export async function streamFetchLines(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutSeconds: number,
  externalSignal: AbortSignal | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), Math.max(15, timeoutSeconds) * 1000)
  }
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  resetIdle()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
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
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      resetIdle()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    }
    // flush 末行（无换行结尾的残留）
    if (buffer) onLine(buffer)
  } catch (error) {
    if (error instanceof AIClientError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) throw new AIClientError('已停止', 'aborted', error)
      throw new AIClientError(`流式请求空闲超时（${timeoutSeconds}s 无新数据）`, 'network', error)
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new AIClientError(`AI 流式请求失败（${reason}）`, 'network', error)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}
