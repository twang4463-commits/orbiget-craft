/**
 * 端口重放的选择规则（站点无关，纯函数，可测）。
 *
 * 背景（2026-10-27 豆包真机）：驱动在发送前才连端口，正常流是实时到的；
 * 但页面自己上一轮迟到的补全请求可能在**端口连上之后**才发出 request 帧
 * （钩子取请求体是异步的），此时它的 chunks 已经广播过一轮、端口不在场。
 * 驱动匹配到请求却永远收不到正文 ⇒ 45s「网页端点响应超时」。
 *
 * 早期实现把**整圈历史**重放给驱动，短文本指纹会假匹配上一轮已完结的流
 * ⇒ 更糟；后来一刀切删掉重放 ⇒ 在途流丢失。
 *
 * 正确规则：**只重放最后一个仍未完结的轮次**（request + 它的 chunks），
 * 完结（done / error / response-error）或没有请求就返回空 —— 既不假匹配
 * 旧轮，也不丢在途流。
 */
export interface ReplayFrameLike {
  kind: string
  requestId?: string
}

export interface ReplayItemLike {
  seq: number
  frame: ReplayFrameLike
}

const TERMINAL_KINDS = new Set(['done', 'error', 'response-error'])

/** 环形缓冲里最后一个请求的未完结帧（request → chunks）；没有就返回 [] */
export function activeTurnFrames<T extends ReplayItemLike>(ring: readonly T[]): T[] {
  let requestIndex = -1
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    if (ring[i].frame.kind === 'request') {
      requestIndex = i
      break
    }
  }
  if (requestIndex < 0) return []
  const requestId = ring[requestIndex].frame.requestId
  if (!requestId) return []

  const frames: T[] = [ring[requestIndex]]
  for (let i = requestIndex + 1; i < ring.length; i += 1) {
    const item = ring[i]
    if (item.frame.requestId !== requestId) continue
    if (TERMINAL_KINDS.has(item.frame.kind)) return [] // 已完结：不重放
    if (item.frame.kind === 'chunk') frames.push(item)
  }
  return frames
}
