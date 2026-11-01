/** 豆包独立桥入口（ISOLATED world）—— 只带豆包的 profile */
import { installWebChatBridge } from '../capture/bridge-core'
import { DOUBAO_SITE } from '../sites/doubao'

installWebChatBridge(DOUBAO_SITE.bridge)
