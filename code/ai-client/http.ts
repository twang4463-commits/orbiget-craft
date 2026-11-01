/**
 * HTTP 层 — 请求发送、头部构建、URL 拼接、JSON 解析、参数解析
 */
import type { AIConnection, AIProfile } from './types'
import { AIClientError, type AIChatRequest } from './types'

// ─── URL 工具 ───

/**
 * 已知 API 尾巴：用户常把文档里的完整生成端点粘进 baseUrl
 * （如 https://tokenhub.tencentmaas.com/v1/wand/si-image/generation），
 * 再拼 wand/…/generation 会叠成双重路径（截图里「测试连接失败」的根因之一）。
 * 拼接前剥掉这些尾巴，回到版本根（/v1）。
 *
 * ⚠️ wand 那一段**写成通配**（`wand/{路由}/{动作}[/{任务id}]`），不再逐个枚举动作：
 * 2026-10-05 用户贴可灵的完整端点 `…/v1/wand/kling/text-to-video`，而这张表当时
 * 只认 `wand/{路由}/generation` 与 `/tasks/{id}` —— 没认出来 → 又拼一次 →
 * `…/text-to-video/wand/kling/text-to-video`，平台回「接口不存在」。
 * 枚举式的表在「一家一套动作名」的聚合平台上必然追不上，通配才对。
 */
const API_TAIL_RE = /\/(?:wand\/[^/]+\/[^/]+(?:\/[^/]+)?|images\/generations|video\/generations|video\/submit|video\/status|audio\/speech|chat\/completions|contents\/generations\/tasks(?:\/[^/]+)?|responses)$/i

/** 剥掉 baseUrl 上误粘的 API 路径尾巴，回到版本根 */
export function normalizeAIBaseUrl(baseUrl: string): string {
  const base = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return ''
  return base.replace(API_TAIL_RE, '')
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = normalizeAIBaseUrl(baseUrl)
  const suffix = path.replace(/^\/+/, '')
  // 兜底去重：归一化没认出的尾巴（新家的路径形态）**也不许叠成双路径** ——
  // base 已经以这段路径结尾，就说明用户填的就是完整端点，直接用。
  if (base.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)) return base
  return `${base}/${suffix}`
}

/**
 * 「没有模板时该打哪个地址」—— 唯一入口（对话 / 生图 / 生视频 / 语音都走它）。
 *
 * 用户把端点填法选成 **「整条地址」**（`endpointMode: 'full'`）时，那条 URL 就是
 * **提交地址本身**，一个字符都不能加；其余情况才拼各家约定俗成的默认路径。
 *
 * ⚠️ 2026-10-05 用户实测：这个开关一开始只接进了模板引擎，media-generation 那几条
 * 老路仍走 `joinUrl(baseUrl, 'video/generations')` —— 于是选了「整条地址」的卡
 * 被归一化剥掉尾巴、又拼上 `video/generations`，打出 `…/v1/video/generations`
 * → 网关回 `404 page not found`（卡片上写的却是用户填的那条完整地址）。
 */
export function defaultEndpointUrl(
  settings: { baseUrl: string; endpointMode?: 'base' | 'full' },
  path: string,
): string {
  if (settings.endpointMode === 'full') {
    const full = (settings.baseUrl || '').trim()
    if (/^https?:\/\//i.test(full)) return full
  }
  return joinUrl(settings.baseUrl, path)
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

// ─── Anthropic 端点拼接 ───

// ─── 服务端错误解包 ───

/**
 * 把服务端的错误响应解成一个 `AIClientError`。
 *
 * 各家 provider 的错误壳并不一样：有的 `{ error: { message } }`、有的 `{ message }`、
 * 有的直接甩一段纯文本。兜底统一成「AI provider returned <status>」。
 * ⚠️ **原样带上解析出的 JSON**（`data || text`）—— 排错时要看到 provider 真正
 * 说了什么，这一步五处调用点此前都做对了，收的时候别丢。
 *
 * 2026-09-27 抽出：这段解包此前在 `postJson` / `getJson` / `streamFetchLines`
 * 与 `protocol-openai` / `protocol-responses` **各写一遍**（五处逐字相同）。
 * provider 换一次错误壳就要改五处，漏一处就变成「某些协议报不出错」。
 */
export function providerError(response: { status: number }, text: string): AIClientError {
  const data = text ? parseJson(text) : null
  return new AIClientError(
    data?.error?.message || data?.message || `AI provider returned ${response.status}`,
    'provider-error',
    data || text,
  )
}

// ─── 请求失败的归类 ───

/**
 * 把 `fetch` 抛出来的东西归类成一个 `AIClientError`。
 *
 * 这段此前在**六处**各写一遍（`postJson` / `getJson` / `streamFetchLines` /
 * `media-generation` / `protocol-openai` / `protocol-responses`），结构完全一样：
 *   ① 已经是 `AIClientError` ⇒ 原样抛（别把上层的语义又包一层）
 *   ② `AbortError` ⇒ 要**再分一次**：是用户点了「停止」（`externallyAborted`）
 *      还是我们自己掐的超时闸门。**这两者对用户是两件事** ——
 *      混起来就会出现「我明明按了停止，它说超时」。
 *   ③ 其它 ⇒ 带上真实原因，别都压成一句 "AI request failed"
 *
 * 判据：分类逻辑必须处处一致，所以收成一份；**文案**（各调用点的时限不同）
 * 由调用方给。
 *
 * ⚠️ 只覆盖**抛 AIClientError** 的那几处。另有两处（`message-handlers` 的余额
 * 查询、`request-template` 的连通性探测）是把失败**返回**成普通对象的 ——
 * 那是另一种输出形状，不该硬塞进来。
 */
export function toRequestError(
  error: unknown,
  ctx: {
    /** 用户是否主动中断（点了「停止」）。为真时报「已停止」而不是「超时」 */
    externallyAborted?: boolean
    /** 超时文案（各调用点的时限不同） */
    timeoutMessage: string
    /** 非超时失败的文案**前缀**，真实原因接在「（…）」里 */
    failurePrefix: string
  },
): AIClientError {
  if (error instanceof AIClientError) return error
  if (error instanceof DOMException && error.name === 'AbortError') {
    if (ctx.externallyAborted) return new AIClientError('已停止', 'aborted', error)
    return new AIClientError(ctx.timeoutMessage, 'network', error)
  }
  const reason = error instanceof Error ? error.message : String(error)
  return new AIClientError(`${ctx.failurePrefix}（${reason}）`, 'network', error)
}

// ─── 服务端响应里的「宽容取值」 ───

/** 各家媒体任务响应里可能放成品链接的字段名（无公开文档，按常见形状穷举） */
const MEDIA_URL_KEYS = [
  'url', 'video_url', 'videoUrl', 'output_url', 'outputUrl', 'download_url', 'mp4_url',
]

/**
 * 从服务端的异步任务响应里 BFS 找出第一个 http(s) 链接。
 *
 * 2026-09-27 抽出：`media-generation.pickMediaUrl` 与
 * `request-template.findFirstUrl` 是同一段 BFS 的两份拷贝（同样的键表、同样的
 * 深度、同样的「数组要摊平、对象要收所有值」的走法），差别只有一个键：
 * `findFirstUrl` 多认一个 `image_url`。两份各有两处调用方。
 *
 * 为什么值得留一份：这类任务的响应**没有公开文档**，字段名只能穷举；
 * 有一家换了字段名时，两份拷贝里漏改一处，那条路径就会静默拿不到链接。
 *
 * @param extraKeys 额外要认的字段名（拼在标准键表之后，不覆盖）
 */
export function findFirstProviderUrl(
  payload: unknown,
  maxDepth = 4,
  extraKeys: readonly string[] = [],
): string | undefined {
  const keys = extraKeys.length ? [...MEDIA_URL_KEYS, ...extraKeys] : MEDIA_URL_KEYS
  let queue: unknown[] = [payload]
  for (let depth = 0; depth < maxDepth && queue.length; depth++) {
    // 数组是**透明容器**：同一层里就地摊平，不占深度。
    // 否则 `data[0].outputs[0].url` 这种形状要多花两层深度，默认 maxDepth=4 正好够不着
    // （2026-10-05 用户实测的 TokenHub 查询响应就是这个形状：data 是数组、outputs 又是数组）。
    const flat: unknown[] = []
    for (const n of queue) {
      if (Array.isArray(n)) flat.push(...n)
      else flat.push(n)
    }
    const next: unknown[] = []
    for (const node of flat) {
      if (!node || typeof node !== 'object') continue
      if (Array.isArray(node)) {
        next.push(...node)
        continue
      }
      const d = node as Record<string, unknown>
      for (const k of keys) {
        const v = d[k]
        if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v
      }
      next.push(...Object.values(d))
    }
    queue = next
  }
  return undefined
}

// ─── 服务商错误对象 ───

/**
 * 从响应体里取服务商的错误（`error` / `Error`，字符串或 `{code,message}`）。
 *
 * 为什么需要：HTTP **200 + `{"error":{…}}`** 是这类平台最常见的报错方式
 * （腾讯 TokenHub 全程如此：提交与查询失败都回 200）。不看这个字段，
 * 「接口不存在」「Task is not exist.」这类原话就永远到不了界面 ——
 * 用户只能自己去 DevTools 里翻（2026-10-05 实测）。
 *
 * 只看根与已知外壳（task / data / Response / response），不下钻业务字段：
 * 媒体生成结果里带 `error` 字样的业务数据不该被当成接口错误。
 * `error: null` / `error: ""` 视为没有错误（成功响应常这么写）。
 */
export function providerErrorOf(payload: unknown): { code?: string; message?: string } | undefined {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 0 }]
  for (let i = 0; i < stack.length && i < 24; i++) {
    const { node, depth } = stack[i]
    if (!node || typeof node !== 'object') continue
    // 数组同样要摊平走（腾讯的任务查询是 `data:[…]`；错误也可能裹在列表项里）
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth })
      continue
    }
    const d = node as Record<string, unknown>
    const err = d.error ?? d.Error
    if (typeof err === 'string' && err.trim()) return { message: err.trim() }
    if (err && typeof err === 'object' && !Array.isArray(err)) {
      const e = err as Record<string, unknown>
      const message = typeof e.message === 'string' && e.message.trim()
        ? e.message.trim()
        : typeof e.msg === 'string' && e.msg.trim() ? e.msg.trim() : undefined
      const code = typeof e.code === 'string' && e.code.trim() ? e.code.trim() : undefined
      if (message || code) return { ...(code ? { code } : {}), ...(message ? { message } : {}) }
    }
    if (depth >= 1) continue
    for (const k of ['task', 'data', 'Response', 'response']) {
      const child = d[k]
      if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1 })
    }
  }
  return undefined
}
/** 服务商错误 → 一句人话（`code: message`，只有哪个就给哪个） */
export function formatProviderError(err: { code?: string; message?: string }): string {
  if (err.code && err.message) return `${err.code}: ${err.message}`
  return err.message || err.code || '未知错误'
}

/**
 * 把常见的"不是代码问题"的报错翻译成**下一步动作**。
 *
 * 2026-10-05 实测：腾讯 TokenHub 未开通按量付费时回
 * `No free trial quota is available for the service and postpaid billing is not enabled…
 *  Please go to Console > Online Inference Service to enable postpaid billing`——
 * 这不是接口填错了，是**账号没开通计费**；不翻译的话用户会一直去改端点与模型名。
 * 判据用各家原话里的关键词（中英都要认），只做**追加提示**，不覆盖服务商原话。
 */
export function providerActionHint(message: string): string | undefined {
  const m = (message || '').toLowerCase()
  if (/postpaid billing is not enabled|no free trial quota|enable postpaid/.test(m)) {
    return '这不是接口填错：该账号还没开通这条服务的「按量付费」（或免费额度已用完）。去云控制台的「在线推理服务」里开通后重试。'
  }
  if (/insufficient balance|欠费|余额不足|arrears/.test(m)) {
    return '账号余额不足/已欠费，充值后重试。'
  }
  if (/model or service id .* does not exist|模型或服务 id .* 不存在/.test(m)) {
    return '网关不认这个名字：同一个模型名不一定每条通道都服务。可以先点「拉取可用模型」看这个端点实际认哪些 id，或换一个同族的模型名。'
  }
  return undefined
}

// ─── 任务状态推断 ───
/**
 * 从「服务商的任务查询响应」里宽容地推断 done / failed / pending。
 *
 * 2026-09-27 抽出：此前 `media-generation.pickHunyuanTaskStatus` 与
 * `request-template.inferTaskStatus` 是**同一个函数的两份拷贝**（同样的 BFS、
 * 同样的词形正则、同样的判定顺序，差别只有一行注释），而两份都只有其中一份
 * 被测到。服务商的任务响应没有公开文档、字段名各不相同（`status` / `state` /
 * `task_status` / `sub_status`，壳还可能套在 `task` / `data` 里），所以这里
 * 采取「宽进」策略：把能走到的状态串都收起来再一起判。
 *
 * 判定顺序有意义：先判 done 再判 failed —— 有的服务商失败时会同时带
 * `sub_status: 'done'` 之类，先判失败会误报。
 *
 * ⚠️ 2026-10-05 补：**先看 error**。腾讯 TokenHub 的查询失败长这样
 * `{"error":{"code":"InvalidParameter","message":"Task is not exist."}}` ——
 * 里面**没有任何 status 字段**，旧实现判成 pending，于是死轮到 5 分钟超时，
 * 服务商的原话只在 DevTools 里看得到（用户实测截图）。有 error 就是失败，别轮了。
 */
export function inferTaskStatus(payload: unknown): 'done' | 'failed' | 'pending' {
  if (providerErrorOf(payload)) return 'failed'
  const seen: string[] = []
  const stack: unknown[] = [payload]
  // ⚠️ 数组要**摊平继续走**，不是跳过（2026-10-05 用户贴的 TokenHub 查询响应实测）：
  //   腾讯的任务查询回的是 `{code:0, data:[{id, status:'succeeded', outputs:[…]}]}` ——
  //   `data` 是**数组**。旧实现碰到数组就 `continue`，于是里面的 `status` 永远看不见，
  //   任务早成功了还一直判 pending：探针报「20s 内还没出结果」，正式生成白等到超时。
  for (let i = 0; i < stack.length && i < 64; i++) {
    const node = stack[i]
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    const d = node as Record<string, unknown>
    for (const k of ['status', 'state', 'task_status', 'sub_status']) {
      const v = d[k]
      if (typeof v === 'string' && v) seen.push(v.toLowerCase())
    }
    for (const k of ['task', 'data', 'Response', 'response']) {
      const child = d[k]
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  const text = seen.join(' ')
  // 放开词形词尾（succeed vs succeeded，fail vs failed 等），别用 \b 硬卡
  if (/(succeed|success|complet|done|finish)/.test(text)) return 'done'
  if (/(fail|error|cancel|reject)/.test(text)) return 'failed'
  return 'pending'
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
    if (!response.ok) throw providerError(response, text)
    return data
  } catch (error) {
    // 透传真实原因：外部中断、超时、网络错误分开说，别都压成一句 "AI request failed"
    throw toRequestError(error, {
      externallyAborted: externalSignal?.aborted,
      timeoutMessage: `请求超时（${timeoutSeconds}s）：模型未在时限内完成输出，可稍后重试或在设置中调大超时`,
      failurePrefix: 'AI 请求未到达服务商：检查网络或站点权限',
    })
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** GET JSON（独立超时闸门；轮询类接口用，如火山 Task 状态查询） */
export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutSeconds: number,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000)
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    const text = await response.text()
    const data = text ? parseJson(text) : null
    if (!response.ok) throw providerError(response, text)
    return data
  } catch (error) {
    throw toRequestError(error, {
      timeoutMessage: `请求超时（${timeoutSeconds}s）`,
      failurePrefix: 'AI 请求失败',
    })
  } finally {
    clearTimeout(timer)
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
      throw providerError(response, text)
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
    throw toRequestError(error, {
      externallyAborted: externalSignal?.aborted,
      timeoutMessage: `流式请求空闲超时（${timeoutSeconds}s 无新数据）`,
      failurePrefix: 'AI 流式请求失败',
    })
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}
