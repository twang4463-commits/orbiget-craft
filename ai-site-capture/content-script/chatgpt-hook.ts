/** ChatGPT 独立抓取入口（MAIN world）—— 只带 ChatGPT 的 profile */
import { installWebChatHook } from '../capture/hook-core'
import { CHATGPT_SITE } from '../sites/chatgpt'

installWebChatHook(CHATGPT_SITE.hook)
