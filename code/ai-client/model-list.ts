/**
 * 模型列表查询
 *
 * 失败必须抛错（而非静默返回空数组）：调用方（添加链接弹窗）要在下拉
 * 下方明确提示原因——CORS 拦截 / 401 / 网络不通是三类不同问题，
 * 全吞成「空列表」用户永远不知道模型列表为什么出不来。
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
    if (response.status === 401 || response.status === 403) {
      throw new Error('API Key 无效或无权限（401/403），请检查密钥')
    }
    if (!response.ok) throw new Error(`接口返回 ${response.status}`)
    const data = parseJson(await response.text())
    const models = Array.isArray(data?.data) ? data.data : []
    return models
      .map((item: { id?: string }) => item?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
  } catch (err) {
    // CORS 拦截（"Failed to fetch"）在浏览器里没有可读 message，翻译成人话
    if (err instanceof TypeError) {
      throw new Error('请求被浏览器拦截或网络不通（可能 CORS/跨域限制），请检查地址与密钥后重试')
    }
    throw err
  }
}
