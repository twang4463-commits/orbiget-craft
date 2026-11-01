/** ChatGPT 独立桥入口（ISOLATED world）—— 只带 ChatGPT 的 profile */
import { installWebChatBridge } from '../capture/bridge-core'
import { CHATGPT_SITE } from '../sites/chatgpt'

installWebChatBridge(CHATGPT_SITE.bridge)
