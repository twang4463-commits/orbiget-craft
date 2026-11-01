/** DeepSeek 独立抓取入口（MAIN world）—— 只带 DeepSeek 的 profile */
import { installWebChatHook } from '../capture/hook-core'
import { DEEPSEEK_SITE } from '../sites/deepseek'

installWebChatHook(DEEPSEEK_SITE.hook)
