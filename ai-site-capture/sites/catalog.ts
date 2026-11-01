/**
 * 站点目录 —— 只给**扩展页 / SW / 设置页**用（内容脚本入口绝不 import 这里，
 * 否则一个页面会把四家代码全带上）。
 *
 * 动态注册、权限检查、设置抽屉都从这里取「站点 → 域名 → 独立 bundle」的
 * 映射；新增站点只改这一个列表 + 新建 `sites/<site>.ts` + 两个入口文件。
 */
import { CHATGPT_SITE } from './chatgpt'
import { DEEPSEEK_SITE } from './deepseek'
import { DOUBAO_SITE } from './doubao'
import { GEMINI_SITE } from './gemini'
import type { WebSite } from './types'

export const WEB_SITES: readonly WebSite[] = [
  DEEPSEEK_SITE,
  DOUBAO_SITE,
  CHATGPT_SITE,
  GEMINI_SITE,
]

/** 全部域名模式（去重）—— manifest 的 optional_host_permissions 必须与它对齐 */
export const WEB_CHAT_ORIGIN_PATTERNS: readonly string[] = Array.from(
  new Set(WEB_SITES.flatMap(site => site.spec.urlPatterns)),
)

/** 某个 origin 模式属于哪个站点 */
export function webSiteForOrigin(pattern: string): WebSite | undefined {
  return WEB_SITES.find(site => site.spec.urlPatterns.includes(pattern))
}

/** 某个协议 id 对应哪个站点 */
export function webSiteForProtocol(protocolId: string): WebSite | undefined {
  return WEB_SITES.find(site => site.spec.protocolId === protocolId)
}

/** 站点抓取脚本名（与构建产物/驱动注入名一致） */
export function webSiteScripts(site: WebSite): { hook: string; bridge: string } {
  return {
    hook: site.spec.hookScript ?? 'web-chat-hook.js',
    bridge: site.spec.bridgeScript ?? 'web-chat-bridge.js',
  }
}
