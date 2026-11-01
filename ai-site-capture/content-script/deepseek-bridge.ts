/** DeepSeek 独立桥入口（ISOLATED world）—— 只带 DeepSeek 的 profile */
import { installWebChatBridge } from '../capture/bridge-core'
import { DEEPSEEK_SITE } from '../sites/deepseek'

installWebChatBridge(DEEPSEEK_SITE.bridge)
