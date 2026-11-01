/**
 * AI 客户端公共类型定义（开源抽离版）
 *
 * 来自 OrbiGet Craft 生产代码 src/ai/client/，仅保留协议层所需类型，
 * 去掉对扩展内部模块（设置持久化、消息总线等）的依赖。
 */

/** 支持的协议/服务商标识 */
export type AIProtocolId =
  | 'openai-compatible'
  | 'custom-openai-compatible'
  | 'ollama'
  | 'deepseek'
  | 'qwen'
  | 'doubao'
  | 'minimax'
  | 'hunyuan'
  | 'siliconflow'
  | 'zhipu'
  | 'moonshot'

/** API Key 认证方式 */
export type AIAuthScheme = 'bearer' | 'x-api-key' | 'query' | 'none'

/** 思维链/推理的协议形态 */
export type AIReasoningMode = 'effort' | 'tags' | 'budget'

/** 推理强度（effort 模式用于 OpenAI o 系列；budget 模式用于预算映射） */
export type AIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface AIModelCapabilities {
  /** 是否支持思维链/推理 */
  reasoning?: boolean
  vision?: boolean
  json?: boolean
  streaming?: boolean
  /** 是否支持原生 function calling / tool use */
  toolUse?: boolean
  /** 是否支持服务端联网搜索（如 DashScope enable_search：搜索在服务商侧完成） */
  serverSearch?: boolean
}

export interface AITuningDefaults {
  temperature: number
  maxTokens: number
  topP: number
  topK: number
  frequencyPenalty: number
  presencePenalty: number
}

export interface AIReasoningDefaults {
  enabled: boolean
  effort: AIReasoningEffort
  budgetTokens: number
}

/** 该协议实际支持的调优参数，避免给不支持的接口发无效字段 */
export interface AISupportedParams {
  temperature: boolean
  maxTokens: boolean
  topP: boolean
  topK: boolean
  frequencyPenalty: boolean
  presencePenalty: boolean
  reasoning: boolean
}

export interface AIProtocolPreset {
  id: AIProtocolId
  /** 关闭思维链时附加的协议私有字段（如 qwen 的 thinking: {type:"disabled"}） */
  thinkingOffBody?: Record<string, unknown>
  name: string
  /** 底层调用协议，决定分发到哪个适配器 */
  callProtocol: 'openai-compatible' | 'ollama'
  baseUrl: string
  defaultModel: string
  /** 模型下拉候选 */
  suggestedModels: string[]
  requiresApiKey: boolean
  authScheme: AIAuthScheme
  capabilities: AIModelCapabilities
  /** 思维链协议形态；缺省表示不声明推理 */
  reasoningMode?: AIReasoningMode
  reasoningDefault?: AIReasoningDefaults
  tuningDefault: AITuningDefaults
  supportedParams: AISupportedParams
}

/** 思维链策略：auto=按调用场景自动决定；on/off=强制开关 */
export type AIReasoningPolicy = 'auto' | 'on' | 'off'

export interface AIReasoningConfig {
  enabled: boolean
  effort: AIReasoningEffort
  budgetTokens: number
  mode?: AIReasoningPolicy
}

/** 单个用途的连接与调优配置 */
export interface AIProfile {
  protocol: AIProtocolId
  baseUrl: string
  apiKey: string
  model: string
  // 调优参数
  temperature: number
  maxTokens: number
  topP: number
  topK: number
  frequencyPenalty: number
  presencePenalty: number
  // 思维链/推理
  reasoning: AIReasoningConfig
  timeoutSeconds: number
  /** 模型上下文窗口（token，供会话用量与历史预算用） */
  contextWindow?: number
}

/** 解析后的运行时连接（连接 + 用途参数 + 全局 enabled），供协议层消费 */
export interface AIConnection extends AIProfile {
  enabled: boolean
  /** 端点地址的填法：'full' 时 baseUrl 就是提交地址本身，不再拼接路径 */
  endpointMode?: 'base' | 'full'
}

// ─── 请求 / 响应 ───

/** 多模态内容片段（OpenAI vision 格式） */
export type AIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface AIChatMessage {
  /**
   * tool 角色（function calling 回填）：模型发起工具调用后，调用方把执行结果
   * 以 tool 消息回填再发下一轮。role: 'tool' 时必须带 tool_call_id。
   */
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | AIContentPart[]
  /** assistant 消息携带的工具调用请求（回填轮的原样重放；序列化时转 OpenAI 线格式） */
  tool_calls?: AIToolCall[]
  /** tool 角色消息对应的调用 id */
  tool_call_id?: string
}

/** 从消息 content 中提取纯文本（数组时拼接所有 text 片段） */
export function messageText(content: string | AIContentPart[]): string {
  if (typeof content === 'string') return content
  return content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('\n')
}

export interface AIChatRequest {
  systemPrompt?: string
  /** 请求服务端联网搜索（仅协议声明 serverSearch 的服务商生效，如 DashScope） */
  webSearch?: boolean
  userPrompt?: string
  messages?: AIChatMessage[]
  model?: string
  /** 原生 function calling 工具定义（OpenAI tools 格式） */
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>
  /** 工具选择策略 */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
  // 调优参数（不传则回退到 settings）
  temperature?: number
  maxTokens?: number
  topP?: number
  topK?: number
  frequencyPenalty?: number
  presencePenalty?: number
  reasoning?: AIReasoningConfig
  timeoutSeconds?: number
}

/** 原生 function calling 返回的工具调用 */
export interface AIToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface AIChatResponse {
  text: string
  provider: AIProtocolId
  model: string
  /** 原生 function calling 的工具调用列表（无则为空） */
  toolCalls?: AIToolCall[]
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  raw?: unknown
}

// ─── 错误 ───

export class AIClientError extends Error {
  constructor(
    message: string,
    public code: 'disabled' | 'missing-api-key' | 'invalid-request' | 'prompt-rejected' | 'network' | 'provider-error' | 'aborted',
    public detail?: unknown,
  ) {
    super(message)
    this.name = 'AIClientError'
  }
}

// ─── OpenAI 兼容协议集合 ───

export type OpenAICompatibleProtocol = Extract<
  AIProtocolId,
  | 'openai-compatible'
  | 'custom-openai-compatible'
  | 'deepseek'
  | 'hunyuan'
  | 'siliconflow'
  | 'zhipu'
  | 'moonshot'
  | 'qwen'
  | 'doubao'
  | 'minimax'
>

export const OPENAI_COMPATIBLE_PROTOCOLS = new Set<AIProtocolId>([
  'openai-compatible',
  'custom-openai-compatible',
  'deepseek',
  'hunyuan',
  'siliconflow',
  'zhipu',
  'moonshot',
  'qwen',
  'doubao',
  'minimax',
])

// ─── 输出预算与服务端搜索 ───

/** 请求未显式给 maxTokens 时的默认输出上限（生产口径：放给 200k+ 窗口模型） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 300000

/**
 * 精简预设表 —— 生产版每家服务商一个完整预设（能力/容量/调优缺省），
 * 本开源版只保留「服务端搜索判定」需要的最小信息；加新服务商在这里加一条。
 */
export const AI_PROTOCOL_PRESETS: AIProtocolPreset[] = [
  {
    id: 'qwen',
    name: '通义千问（DashScope）',
    callProtocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    suggestedModels: [],
    requiresApiKey: true,
    authScheme: 'bearer',
    capabilities: { streaming: true, toolUse: true, serverSearch: true },
    tuningDefault: { temperature: 0.7, maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, topP: 1, topK: 0, frequencyPenalty: 0, presencePenalty: 0 },
    supportedParams: { temperature: true, maxTokens: true, topP: true, topK: true, frequencyPenalty: false, presencePenalty: false, reasoning: true },
  },
]

/**
 * 该连接是否支持服务端联网搜索（配置感知）：
 * ① 预设声明 serverSearch → 达标；
 * ② 兼容口但端点是 DashScope 且模型是 qwen 家族 → 也达标（enable_search 是 DashScope 私有参数，
 *    端点必须核对，避免给其它服务商发未知字段）。达标后请求体自动带 enable_search。
 */
export function supportsServerSearch(
  profile: Pick<AIProfile, 'protocol'> & { model?: string; baseUrl?: string },
): boolean {
  const preset = AI_PROTOCOL_PRESETS.find(p => p.id === profile.protocol)
  if (preset?.capabilities.serverSearch === true) return true
  if (
    preset?.callProtocol === 'openai-compatible'
    && /dashscope.aliyuncs.com/i.test(profile.baseUrl || '')
    && /qwen|qwq/i.test(profile.model || '')
  ) {
    return true
  }
  return false
}
