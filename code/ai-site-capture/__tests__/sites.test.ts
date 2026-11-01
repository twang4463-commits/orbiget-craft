import { describe, expect, it } from 'vitest'
import { CHATGPT_SITE } from '../sites/chatgpt'
import { DEEPSEEK_SITE } from '../sites/deepseek'
import { DOUBAO_SITE } from '../sites/doubao'
import { GEMINI_SITE } from '../sites/gemini'

/** 站点判定只吃 (pathname, rawUrl) —— 与钩子 fetch/XHR 两处的调用同形 */
function isCompletion(site: { hook: { isCompletionUrl: (p: string, u: string) => boolean } }, url: string): boolean {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    /* 相对路径:原样当 pathname */
  }
  return site.hook.isCompletionUrl(pathname, url)
}

describe('sites · 补全端点判定', () => {
  // ⚠️ 2026-10-31：Gemini 补全迁 WebChannel 二进制 protobuf,网络层判定一律
  // 不认(抓取走 bridge.watchTurns 的 DOM 兜底)——旧 StreamGenerate 判定的
  // 命中用例已随迁移移除,协议回跳时连注释一起从 sites/gemini.ts 恢复。

  it('Gemini 通用网关上的其它 RPC 不当补全(取设置/取历史一类)', () => {
    const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=GetUserSettings&hl=zh'
    expect(isCompletion(GEMINI_SITE, url)).toBe(false)
  })

  it('Gemini 无关请求不命中(遥测/静态资源)', () => {
    expect(isCompletion(GEMINI_SITE, 'https://gemini.google.com/_/BardChatUi/data/batchexecute')).toBe(false)
    expect(isCompletion(GEMINI_SITE, 'https://www.gstatic.com/og/_/js/k=og.qtm.en_US.js')).toBe(false)
    expect(isCompletion(GEMINI_SITE, 'https://gemini.google.com/app')).toBe(false)
  })

  it('Gemini 提交判定只认请求帧(2026-10-31:DOM 清空是假阳性),别家不动', () => {
    expect(GEMINI_SITE.bridge.requireRequestEvidence).toBe(true)
    expect(DOUBAO_SITE.bridge.requireRequestEvidence).toBeFalsy()
    expect(DEEPSEEK_SITE.bridge.requireRequestEvidence).toBeFalsy()
    expect(CHATGPT_SITE.bridge.requireRequestEvidence).toBeFalsy()
  })

  it('Gemini 注入落账要等到发送键解锁(2026-10-31 深夜:paste 只进 DOM 不进模型),别家不动', () => {
    expect(GEMINI_SITE.bridge.verifySendButtonUnlock).toBe(true)
    expect(DOUBAO_SITE.bridge.verifySendButtonUnlock).toBeFalsy()
    expect(DEEPSEEK_SITE.bridge.verifySendButtonUnlock).toBeFalsy()
    expect(CHATGPT_SITE.bridge.verifySendButtonUnlock).toBeFalsy()
  })

  it('Gemini 主 composer 是 rich-textarea,textarea 只能当最后兜底(2026-10-31:未 hydrate 时文本灌进暗桩)', () => {
    const selectors = GEMINI_SITE.bridge.composerSelectors
    expect(selectors[0]).toContain('rich-textarea')
    expect(selectors.indexOf('textarea')).toBe(selectors.length - 1)
  })

  it('Gemini 抓取走 DOM 兜底(2026-10-31:WebChannel 二进制 protobuf,钩子在网络层抓不到)', () => {
    // 网络层判定一律不认 —— 认了就会和 DOM 兜底对同一轮双记
    expect(GEMINI_SITE.hook.isCompletionUrl('/BardChatUi/data/.../StreamGenerate', '')).toBe(false)
    // 桥必须带 DOM 轮次捕获
    expect(typeof GEMINI_SITE.bridge.watchTurns).toBe('function')
    // chunk 是纯文本增量 ⇒ 直通解析器
    const parser = GEMINI_SITE.spec.createParser()
    expect(parser.push('增量文本')).toEqual([{ type: 'content', delta: '增量文本' }])
    expect(parser.unknownFrameCount).toBe(0)
  })

  it('Gemini 走增量发送(2026-10-31 用户点名:同一线程只有第一次发压缩回放)', () => {
    expect(GEMINI_SITE.spec.sendMode).toBe('delta')
  })

  it('可见性谎报:hook 与 bridge 必须成对开启(桥发 ctl,钩子执行)', () => {
    for (const site of [GEMINI_SITE, DOUBAO_SITE, CHATGPT_SITE, DEEPSEEK_SITE]) {
      const bridgeOn = site.bridge.needsVisibilityLie === true
      const hookOn = site.hook.needsVisibilityLie === true
      // 漏 hook 侧 = ctl 发出去没人接(豆包在 hook/bridge 拆分后就是这么断的)
      expect(bridgeOn === hookOn).toBe(true)
    }
  })

  it('另外三家端点判定不回退(改动 Gemini 不该动到它们)', () => {
    expect(isCompletion(CHATGPT_SITE, 'https://chatgpt.com/backend-api/conversation')).toBe(true)
    expect(isCompletion(CHATGPT_SITE, 'https://chatgpt.com/backend-api/f/conversation')).toBe(true)
    expect(isCompletion(CHATGPT_SITE, 'https://chatgpt.com/backend-api/conversations')).toBe(false)
    expect(isCompletion(DEEPSEEK_SITE, 'https://chat.deepseek.com/api/v0/chat/completion')).toBe(true)
    expect(isCompletion(DEEPSEEK_SITE, 'https://chat.deepseek.com/api/v0/chat/history')).toBe(false)
    expect(isCompletion(DOUBAO_SITE, 'https://www.doubao.com/samantha/chat/completion')).toBe(true)
    expect(isCompletion(DOUBAO_SITE, 'https://www.doubao.com/samantha/chat/list')).toBe(false)
  })
})
