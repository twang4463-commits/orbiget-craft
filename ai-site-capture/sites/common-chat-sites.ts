/**
 * 系统认识的**常见网页 chat 站点** —— 权限清单用，驱动另说（2026-10-30 用户定案）。
 *
 * ## 定位：这张表只管「认哪些域名」，不管「能不能聊」
 *
 * · **已实现驱动的 4 家**（DeepSeek / 豆包 / ChatGPT / Gemini）在 `sites/catalog.ts`
 *   —— 那里有 spec + 内容脚本 + 抓取器，能真的对话；
 * · **本表是其余常见网页 chat 的域名登记** —— 进清单 ⇒ 用户能授权，
 *   将来补上驱动就能直接用；**现在没有驱动，授权了也聊不了**。
 *
 * ⚠️ 别把本表当「支持列表」用 —— 那会把「有权限」误读成「能对话」。
 *
 * ## 域从哪儿来
 *
 * 主程序 `apps/craft/src/shared/host-access/default-hosts.json` 的 `ai` 段里
 * **能聊天**的那批（生图 / 生视频 / 音乐站不在本表 —— 那些不是 chat）。
 * 两边口径不同、域有重叠是正常的：主程序那份管「内容脚本注入」，
 * 本表管「chat 端点的域名」。
 *
 * ## 新增一条的判据
 *
 * ① 这个站**确实有网页版聊天**（不是只有 API，也不是纯生图站）；
 * ② 域是**现行页面域**（旧域也留着 —— 用户书签里可能是旧的）。
 */
export interface CommonChatSite {
  /** 站点 id（与产物名一致） */
  id: string
  /** 展示名 */
  name: string
  /** host 权限模式（`https://host/*`）—— 与 manifest 的声明口径一致 */
  urlPatterns: readonly string[]
}

export const COMMON_CHAT_SITES: readonly CommonChatSite[] = [
  {
    id: 'qwen',
    name: '通义千问',
    // chat.qwen.ai = 现行页面域；tongyi.aliyun.com = 旧域（书签里还在）
    urlPatterns: ['https://chat.qwen.ai/*', 'https://tongyi.aliyun.com/*'],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    // www.kimi.com = 现行页面域；kimi.moonshot.cn = 系统站点清单里的旧域
    urlPatterns: ['https://www.kimi.com/*', 'https://kimi.moonshot.cn/*'],
  },
  {
    id: 'yuanbao',
    name: '腾讯元宝',
    urlPatterns: ['https://yuanbao.tencent.com/*'],
  },
  {
    id: 'yiyan',
    name: '百度文心一言',
    urlPatterns: ['https://yiyan.baidu.com/*'],
  },
  {
    id: 'xinghuo',
    name: '讯飞星火',
    urlPatterns: ['https://xinghuo.xfyun.cn/*'],
  },
  {
    id: 'chatglm',
    name: '智谱清言',
    urlPatterns: ['https://chatglm.cn/*'],
  },
  {
    id: 'claude',
    name: 'Claude',
    urlPatterns: ['https://claude.ai/*'],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    urlPatterns: ['https://perplexity.ai/*'],
  },
  {
    id: 'poe',
    name: 'Poe',
    urlPatterns: ['https://poe.com/*'],
  },
  {
    id: 'copilot',
    name: 'Microsoft Copilot',
    urlPatterns: ['https://copilot.microsoft.com/*'],
  },
  {
    id: 'grok',
    name: 'Grok',
    urlPatterns: ['https://grok.x.ai/*'],
  },
  {
    id: 'meta-ai',
    name: 'Meta AI',
    urlPatterns: ['https://meta.ai/*'],
  },
  {
    id: 'character',
    name: 'Character.AI',
    urlPatterns: ['https://character.ai/*'],
  },
]

/** 全部域名模式（去重）—— manifest 的 `optional_host_permissions` 必须与它对齐 */
export const COMMON_CHAT_ORIGIN_PATTERNS: readonly string[] = Array.from(
  new Set(COMMON_CHAT_SITES.flatMap((site) => site.urlPatterns)),
)
