/**
 * DSML 内嵌工具调用解析（2026-09-16 脑洞实测；2026-10-24 归一进 protocol 入口）
 *
 * ## 为什么住在 protocol
 *
 * 部分 DeepSeek 系模型 / 网关不支持 OpenAI 原生 tools 参数 —— 工具定义被转成
 * prompt 注入后，模型把调用以 DSML 标记写在**正文**里：
 *
 * ```
 * <|DSML||calls>
 * <|DSML||invoke name="generate_image">
 * <|DSML||parameter name="prompt" string="true">画面描述…<|DSML||parameter>
 * <|DSML||invoke>
 * <|DSML||calls>
 * ```
 *
 * 闭合标记可能带或不带斜杠，正则两种都兼容。参数值优先 JSON 解析（数值 / 布尔），
 * 失败保字符串。无 DSML 时零开销短路。
 *
 * ## 归一前
 *
 * 宿主 `client/tool-format.ts` 与脑洞子项目 `src/dsml.ts` 各有一份，
 * **正则 / id 生成 / 剥块逻辑逐字相同**（33 行对 33 行）—— 两份各改各的 ⇒
 * 同一个模型在不同页面认出的工具调用可能不一样。
 * 现在**只有这一份**。
 *
 * ⚠️ 本文件**零 import** ⇒ 加进 protocol 入口不会把宿主拖进来（独立运行时可用）。
 */

export interface DsmlToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** 解析正文里内嵌的 DSML 工具调用。 */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  if (!text.includes('DSML')) return []
  const calls: DsmlToolCall[] = []
  const invokeRe = /<\|DSML\|\|invoke name="([^"]*)"\s*>([\s\S]*?)<\|DSML\|\|\/?invoke>/g
  const paramRe = /<\|DSML\|\|parameter name="([^"]*)"[^>]*>([\s\S]*?)<\|DSML\|\|\/?parameter>/g
  for (const m of text.matchAll(invokeRe)) {
    const name = m[1]?.trim()
    if (!name) continue
    const args: Record<string, unknown> = {}
    for (const p of (m[2] ?? '').matchAll(paramRe)) {
      const key = p[1]?.trim()
      if (!key) continue
      const raw = p[2] ?? ''
      try { args[key] = JSON.parse(raw) } catch { args[key] = raw }
    }
    calls.push({ id: `dsml-${Date.now().toString(36)}-${calls.length + 1}`, name, arguments: args })
  }
  return calls
}

/** 剥离正文中的 DSML 块：调用已解析执行，原始标记不该出现在用户眼前 */
export function stripDsmlBlocks(text: string): string {
  if (!text.includes('DSML')) return text
  return text
    .replace(/<\|DSML\|\|calls>[\s\S]*?<\|DSML\|\|\/?calls>/g, '')
    .replace(/<\|DSML\|\|invoke[\s\S]*?<\|DSML\|\|\/?invoke>/g, '')
    .replace(/<\|DSML\|\|parameter[^>]*>[\s\S]*?<\|DSML\|\|\/?parameter>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
