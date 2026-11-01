/**
 * 会话历史拉取(2026-10-26,§6.16)—— 推送模型的对账半边。
 *
 * 现有四层投递(实时广播 / ACK 重放 / 桥补给 8 轮 / SW 队列)全是**推送**:
 * App 关了、SW 睡了、浏览器重启了,更早的轮次永久丢失。拉取半边:内容脚本
 * 与页面同源,`fetch` 自带登录态 —— 桥调**站点自己的会话接口**把整段对话
 * 拉回来,App 侧对账落账。
 *
 * 本模块只做**映射与去重 id**(可测);取数在桥(经典脚本,不能带 import),
 * 触发与投递在壳(apps/brainstorm/page-capture.ts)。
 *
 * v1 只接 ChatGPT(`/backend-api/conversation/<id>` 是公开逆向充分的老接口);
 * DeepSeek / 豆包的会话接口待真机样本,桥侧明确报 unsupported。
 */

/** 拉取回来的一轮(与 CapturedPageTurn 的可落账子集同构) */
export interface PulledTurn {
  userText: string
  assistantText: string
  /** 助手产物图(资产指针的 https 形态;可能过期,由调用方决定落法) */
  imageUrls: string[]
  /** 用户消息里的时间(毫秒) */
  at: number
  /** 站点给的用户消息 id(三元组身份;缺字段不猜) */
  userMessageId?: string
  /** 站点给的助手消息 id(三元组身份;缺字段不猜) */
  assistantMessageId?: string
}

/** 桥 WEB_CHAT_PULL_HISTORY 的应答形状 */
export interface HistoryPullReply {
  ok: boolean
  /** 站点会话 id(对账游标的键;首页等无会话页面 ok=false) */
  conversationId?: string
  url?: string
  /** 站点原始响应(JSON 字符串;映射在扩展侧做,可测) */
  raw?: string
  error?: 'unsupported' | 'no-conversation' | 'fetch-failed' | string
}

/** ── ChatGPT 会话 JSON(只取我们关心的字段;结构公开逆向充分)── */
interface ChatGPTNode {
  /** 父节点 id（mapping 是树：编辑/重新生成会留旧枝） */
  parent?: string
  message?: {
    /** 站点消息 id（三元组身份的一半：本消息是哪一条） */
    id?: string
    author?: { role?: string }
    create_time?: number
    metadata?: { is_visually_hidden_from_conversation?: boolean }
    content?: {
      content_type?: string
      parts?: unknown[]
      /** image_asset_pointer 的资产地址(https 或 file-service:// 形态) */
      asset_pointer?: unknown
    }
  } | null
}

/**
 * 只取**当前分支**的节点（2026-10-30）。
 *
 * ChatGPT 的 mapping 是树：编辑提问 / 重新生成都会留下旧枝，旧枝上的消息
 * **从来没有出现在用户当前这条对话里**。全量遍历等于把废弃分支也当历史
 * 拉回来 —— 真机表现就是「对账补出一堆我没见过的轮次」。
 * 从 current_node 沿 parent 回溯出的链才是当前对话；老形状没有
 * current_node 才退回全量（宁可多，不可空）。
 */
function branchNodes(
  mapping: Record<string, ChatGPTNode>,
  currentNode?: string,
): ChatGPTNode[] {
  const all = Object.values(mapping)
  if (!currentNode || !mapping[currentNode]) return all
  const chain: ChatGPTNode[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = currentNode
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const node: ChatGPTNode | undefined = mapping[cursor]
    if (!node) break
    chain.push(node)
    cursor = node.parent
  }
  return chain.length ? chain : all
}

/**
 * ChatGPT 会话 JSON → 有序轮次。
 * · 只走**当前分支**（current_node 回溯；废弃分支不是这段对话的历史）;
 * · 按 create_time 排序(mapping 是无序哈希);
 * · 隐藏消息(工具壳,is_visually_hidden_from_conversation)跳过;
 * · user 文本:content.parts 里的字符串(multimodal_text 的对象分片跳过);
 * · assistant 产物图:image_asset_pointer 的 asset_pointer(只收 https);
 * · 配对:最近的 user → 后续 assistant;assistant 无前导 user 也成轮
 *   (页面里直接续聊的形态);空 assistant 且无图不成轮。
 */
export function mapChatGPTConversation(raw: string): { title: string; turns: PulledTurn[] } {
  let data: { title?: string; current_node?: string; mapping?: Record<string, ChatGPTNode> }
  try {
    data = JSON.parse(raw)
  } catch {
    return { title: '', turns: [] }
  }
  const nodes = branchNodes(data.mapping ?? {}, data.current_node)
  const messages: Array<{ role: string; at: number; text: string; images: string[]; id?: string }> = []
  for (const node of nodes) {
    const m = node?.message
    if (!m || !m.author || m.create_time == null) continue
    const role = String(m.author.role ?? '').toLowerCase()
    if (role !== 'user' && role !== 'assistant') continue
    if (m.metadata?.is_visually_hidden_from_conversation) continue
    const content = m.content
    if (!content || typeof content !== 'object') continue
    const contentType = String(content.content_type ?? '')
    if (contentType !== 'text' && contentType !== 'multimodal_text' && contentType !== 'image_asset_pointer') continue
    const parts = Array.isArray(content.parts) ? content.parts : []
    const text = parts.filter((p): p is string => typeof p === 'string').join('\n')
    const images: string[] = []
    // asset_pointer 可能长在 content 上(image_asset_pointer)或 parts 的对象分片里(multimodal_text)
    const pointers: unknown[] = [...parts, contentType === 'image_asset_pointer' ? content : null]
    for (const p of pointers) {
      const ptr = p && typeof p === 'object' ? (p as Record<string, unknown>).asset_pointer : p
      if (typeof ptr === 'string' && /^https:\/\//i.test(ptr)) images.push(ptr)
    }
    if (role === 'assistant' && !text.trim() && images.length === 0) continue
    const id = typeof m.id === 'string' && m.id ? m.id : undefined
    messages.push({ role, at: m.create_time * 1000, text: text.trim(), images, ...(id ? { id } : {}) })
  }
  messages.sort((a, b) => a.at - b.at)

  const turns: PulledTurn[] = []
  let pendingUser: { text: string; at: number; id?: string } | null = null
  for (const m of messages) {
    if (m.role === 'user') {
      pendingUser = { text: m.text, at: m.at, ...(m.id ? { id: m.id } : {}) }
      continue
    }
    // assistant:与前导 user 配对成轮;没有前导 user 也成轮(空 userText)
    turns.push({
      userText: pendingUser?.text ?? '',
      assistantText: m.text,
      imageUrls: m.images,
      at: pendingUser?.at ?? m.at,
      ...(pendingUser?.id ? { userMessageId: pendingUser.id } : {}),
      ...(m.id ? { assistantMessageId: m.id } : {}),
    })
    pendingUser = null
  }
  return { title: String(data.title ?? ''), turns }
}

/** djb2 短哈希(hex;内容签名用) */
export function shortHash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * 拉取轮次的稳定去重 id:会话只增不改 ⇒ 「会话 id + 序号」稳定;内容哈希
 * 兜底防意外。与推送轮的 requestId(钩子生成)天然不同空间,互不冲突;
 * 同一轮被推送+拉取双路送达时,由会话层的**内容级去重**兜住。
 */
export function pulledTurnId(conversationId: string, index: number, turn: PulledTurn): string {
  return `pull:${conversationId}:${index}:${shortHash(`${turn.userText}\n${turn.assistantText}\n${turn.at}`)}`
}
