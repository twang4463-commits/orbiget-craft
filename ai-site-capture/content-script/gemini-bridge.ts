/** Gemini 独立桥入口（ISOLATED world）—— 只带 Gemini 的 profile */
import { installWebChatBridge } from '../capture/bridge-core'
import { GEMINI_SITE } from '../sites/gemini'

installWebChatBridge(GEMINI_SITE.bridge)
