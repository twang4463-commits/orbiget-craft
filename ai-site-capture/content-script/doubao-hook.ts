/** 豆包独立抓取入口（MAIN world）—— 只带豆包的 profile */
import { installWebChatHook } from '../capture/hook-core'
import { DOUBAO_SITE } from '../sites/doubao'

installWebChatHook(DOUBAO_SITE.hook)
