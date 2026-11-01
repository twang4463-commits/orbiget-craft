/** Gemini 独立抓取入口（MAIN world）—— 只带 Gemini 的 profile */
import { installWebChatHook } from '../capture/hook-core'
import { GEMINI_SITE } from '../sites/gemini'

installWebChatHook(GEMINI_SITE.hook)
