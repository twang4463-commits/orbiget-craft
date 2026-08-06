/**
 * 最小使用示例（开源抽离版）
 *
 * 展示协议层的调用方式：非流式 + 流式。运行前把下面 connection 里的
 * baseUrl / apiKey / model 换成你自己的（或本地 Ollama）。
 *
 * 运行：tsx demo.ts（需要网络请求权限的环境，Node 18+ / Deno / 浏览器均可）
 */
import type { AIProtocolPreset, AIConnection, AIChatMessage } from './types'
import { callOpenAICompatible, callOpenAICompatibleStream } from './protocol-openai'
import { callOllama } from './protocol-ollama'
import { listAIModels } from './model-list'

/** 一个最小的协议预设（生产代码里每家服务商一个预设，此处仅示例结构） */
const openAICompatPreset: AIProtocolPreset = {
  id: 'openai-compatible',
  name: 'OpenAI 兼容接口',
  callProtocol: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  suggestedModels: [],
  requiresApiKey: true,
  authScheme: 'bearer',
  capabilities: { streaming: true, toolUse: true },
  tuningDefault: { temperature: 0.7, maxTokens: 2048, topP: 1, topK: 40, frequencyPenalty: 0, presencePenalty: 0 },
  supportedParams: { temperature: true, maxTokens: true, topP: true, topK: false, frequencyPenalty: true, presencePenalty: true, reasoning: false },
}

const connection: AIConnection = {
  enabled: true,
  protocol: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-...', // ← 换成你的 key
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  topK: 40,
  frequencyPenalty: 0,
  presencePenalty: 0,
  reasoning: { enabled: false, effort: 'medium', budgetTokens: 2048 },
  timeoutSeconds: 60,
}

const messages: AIChatMessage[] = [
  { role: 'system', content: '你是 OrbiGet Craft 的复盘助手，用简洁的中文回答。' },
  { role: 'user', content: '用一句话总结：本周创作节奏的复盘应该看哪三个指标？' },
]

// 非流式
const resp = await callOpenAICompatible(connection, {}, messages, true, openAICompatPreset)
console.log('非流式回复:', resp.text)
console.log('usage:', resp.usage)

// 流式
let streamed = ''
await callOpenAICompatibleStream(connection, {}, messages, true, openAICompatPreset, (delta) => {
  streamed += delta
})
console.log('流式回复:', streamed)

// 模型列表
const models = await listAIModels(connection.baseUrl, connection.apiKey, 'bearer')
console.log('可用模型:', models.slice(0, 5))

// 本地 Ollama（可选）
const ollamaPreset: AIProtocolPreset = {
  id: 'ollama',
  name: 'Ollama 本地模型',
  callProtocol: 'ollama',
  baseUrl: 'http://localhost:11434',
  defaultModel: 'qwen2.5:7b',
  suggestedModels: [],
  requiresApiKey: false,
  authScheme: 'none',
  capabilities: { streaming: true },
  tuningDefault: { temperature: 0.7, maxTokens: 2048, topP: 1, topK: 40, frequencyPenalty: 0, presencePenalty: 0 },
  supportedParams: { temperature: true, maxTokens: true, topP: true, topK: true, frequencyPenalty: false, presencePenalty: false, reasoning: false },
}
// const local = await callOllama({ ...connection, baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen2.5:7b' }, {}, messages, true, ollamaPreset)
// console.log('Ollama 回复:', local.text)
