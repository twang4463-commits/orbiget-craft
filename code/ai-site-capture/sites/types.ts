/**
 * 一个网页端点站点的**完整答案**：驱动侧 spec + 抓取层两个 profile。
 *
 * 每个 `sites/<site>.ts` 只导出这一个对象；内容脚本入口只 import 自己那
 * 一个站点模块 ⇒ 改豆包不会把 DeepSeek 的代码带进构建，更不会带进页面。
 */
import type { HookSiteProfile, BridgeSiteProfile } from '../capture/types'
import type { WebEndpointSpec } from '../types'

export interface WebSite {
  /** 站点 id（目录/产物名一致） */
  id: string
  spec: WebEndpointSpec
  hook: HookSiteProfile
  bridge: BridgeSiteProfile
}
