/**
 * 直通帧解析器（2026-10-31，Gemini DOM 兜底配套）。
 *
 * DOM 兜底捕获出的 chunk **已经是纯文本增量**（桥从 `model-response` 的
 * textContent 切出来的），不需要任何协议解析 —— 原样发 content 帧。
 * `reset` 帧在驱动层直接覆盖累计文本（见 BridgeFrame 的 reset 分支），
 * 解析器自身无状态。
 */
import type { WebChatFrame } from './types'

export class PlainTextFrameParser {
  push(chunk: string): WebChatFrame[] {
    return chunk ? [{ type: 'content', delta: chunk }] : []
  }

  end(): WebChatFrame[] {
    return []
  }

  get unknownFrameCount(): number {
    return 0
  }
}
