/**
 * 模型列表查询（开源抽离版）
 */
import type { AIAuthScheme } from './types'
import { joinUrl, parseJson } from './http'

export async function listAIModels(baseUrl: string, apiKey: string, authScheme: AIAuthScheme): Promise<string[]> {
  const url = joinUrl(baseUrl, 'models')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authScheme === 'bearer' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  } else if (authScheme === 'x-api-key' && apiKey.trim()) {
    headers['x-api-key'] = apiKey.trim()
  }
  try {
    const response = await fetch(url, { headers })
    if (!response.ok) return []
    const data = parseJson(await response.text())
    const models = Array.isArray(data?.data) ? data.data : []
    return models
      .map((item: { id?: string }) => item?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
  } catch {
    return []
  }
}
