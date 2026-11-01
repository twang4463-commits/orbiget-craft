/**
 * 豆包网页版 SSE 帧解析测试(2026-10-24)。
 *
 * 帧形状来自 2026-05 逆向资料(github.com/wangchuxiaoji-oss/doubao2api):
 * 紧凑 CHUNK_DELTA / 结构化 content_block / 10040 思考分隔 / STREAM_ERROR /
 * 跨块断行。锁的是「逆向资料的形状 → 增量帧」这层翻译;页面真改版时
 * unknown 计数与真机足迹日志负责报信。
 */
import { describe, expect, it } from 'vitest'
import { DoubaoFrameParser } from '../doubao-frames'
import type { WebChatFrame } from '../deepseek-frames'

/** 把 SSE 文本按任意位置切开喂进去 —— 锁「跨块断行不丢帧」 */
function feed(parser: DoubaoFrameParser, text: string, cut: number): WebChatFrame[] {
  const frames: WebChatFrame[] = []
  for (let i = 0; i < text.length; i += cut) {
    frames.push(...parser.push(text.slice(i, i + cut)))
  }
  return frames
}

describe('DoubaoFrameParser · 紧凑增量(CHUNK_DELTA)', () => {
  it('text 字段按当前思考状态分流;STREAM_DONE 收口', () => {
    const parser = new DoubaoFrameParser()
    const frames = [
      ...parser.push('event: CHUNK_DELTA\ndata: {"text":"你好"}\n\n'),
      ...parser.push('event: CHUNK_DELTA\ndata: {"text":"，世界"}\n\n'),
      ...parser.push('event: STREAM_DONE\ndata: {}\n\n'),
    ]
    expect(frames).toEqual([
      { type: 'content', delta: '你好' },
      { type: 'content', delta: '，世界' },
      { type: 'done' },
    ])
  })

  it('跨块断行(逐字符喂)不丢帧', () => {
    const parser = new DoubaoFrameParser()
    const frames = feed(parser, 'event: CHUNK_DELTA\ndata: {"text":"一行"}\n\nevent: STREAM_DONE\ndata: {}\n\n', 3)
    expect(frames).toEqual([{ type: 'content', delta: '一行' }, { type: 'done' }])
  })
})

describe('DoubaoFrameParser · 结构化块(content_block)', () => {
  it('STREAM_MSG_NOTIFY 的 2001 块 → 正文增量', () => {
    const parser = new DoubaoFrameParser()
    const frames = parser.push(
      'event: STREAM_MSG_NOTIFY\ndata: '
      + '{"content":{"content_block":[{"block_type":2001,"content":{"text_block":{"text":"正文增量"}}}]}}\n\n',
    )
    expect(frames).toEqual([{ type: 'content', delta: '正文增量' }])
  })

  it('patch_op 内嵌块同构解析;patch_object 102 的字符串 content 解 JSON', () => {
    const parser = new DoubaoFrameParser()
    const frames = parser.push(
      'data: {"patch_op":[{"patch_value":{"content_block":['
      + '{"block_type":2008,"content":{"text_block":{"text":"思考链"}}}]}}]}\n\n'
      + 'data: {"patch_op":[{"patch_object":102,"patch_value":{"content":"{\\"text\\":\\"兜底正文\\"}"}}]}\n\n',
    )
    expect(frames).toEqual([
      { type: 'thinking', delta: '思考链' },
      { type: 'content', delta: '兜底正文' },
    ])
  })

  it('10040 分隔符切换思考态:进入后 CHUNK_DELTA/10000 算思考,退出后算正文', () => {
    const parser = new DoubaoFrameParser()
    const frames = [
      ...parser.push('event: STREAM_MSG_NOTIFY\ndata: '
        + '{"content":{"content_block":[{"block_type":10040,"content":{}}]}}\n\n'),
      ...parser.push('event: CHUNK_DELTA\ndata: {"text":"紧凑思考"}\n\n'),
      ...parser.push('data: {"content":{"content_block":['
        + '{"block_type":10000,"content":{"text_block":{"text":"主文本思考"}}}]}}\n\n'),
      ...parser.push('data: {"content":{"content_block":['
        + '{"block_type":10040,"content":{}}]}}\n\n'),
      ...parser.push('data: {"content":{"content_block":['
        + '{"block_type":10000,"content":{"text_block":{"text":"回答"}}}]}}\n\n'),
    ]
    expect(frames).toEqual([
      { type: 'thinking', delta: '紧凑思考' },
      { type: 'thinking', delta: '主文本思考' },
      { type: 'content', delta: '回答' },
    ])
  })
})

describe('DoubaoFrameParser · 错误与心跳', () => {
  it('STREAM_ERROR / 非零 error_code → error 帧(风控码带进文案)', () => {
    const parser = new DoubaoFrameParser()
    const frames = parser.push(
      'event: STREAM_ERROR\ndata: {"error_code":710022004,"error_msg":"verify"}\n\n',
    )
    expect(frames).toEqual([{ type: 'error', message: 'verify' }])
  })

  it('心跳 data: {} 不产帧也不计 unknown', () => {
    const parser = new DoubaoFrameParser()
    expect(parser.push('data: {}\n\n')).toEqual([])
    expect(parser.unknownFrameCount).toBe(0)
  })
})

/**
 * 2026-10-27：线上 JS 核对 —— 现网事件枚举里没有 STREAM_DONE，结束事件是
 * SSE_REPLY_END（数字码 100005）。旧解析器只认 STREAM_DONE ⇒ 每轮都等不到
 * finish，豆包表现为「请求已匹配、正文已到、45s 后响应超时」。
 */
describe('DoubaoFrameParser · 现网事件名(2026-10-27)', () => {
  it('SSE_REPLY_END + data:{} → done', () => {
    const parser = new DoubaoFrameParser()
    expect(parser.push('event: SSE_REPLY_END\ndata: {}\n\n')).toEqual([{ type: 'done' }])
  })

  it('数字事件码 100005 → done（event 名是数字码时）', () => {
    const parser = new DoubaoFrameParser()
    expect(parser.push('event: 100005\ndata: {}\n\n')).toEqual([{ type: 'done' }])
  })

  it('payload.event_type=100005 → done（SSE event 名缺失时）', () => {
    const parser = new DoubaoFrameParser()
    expect(parser.push('data: {"event_type":100005}\n\n')).toEqual([{ type: 'done' }])
  })

  it('结束事件带最后一块正文 → 先 content 后 done', () => {
    const parser = new DoubaoFrameParser()
    const frames = parser.push(
      'event: SSE_REPLY_END\ndata: '
      + '{"content_blocks_v2":[{"block_type":2001,"content":{"text_block":{"text":"尾块"}}}]}\n\n',
    )
    expect(frames).toEqual([{ type: 'content', delta: '尾块' }, { type: 'done' }])
  })

  it('content_blocks_v2（顶层 / message 内）→ 正文增量', () => {
    const parser = new DoubaoFrameParser()
    const frames = parser.push(
      'event: STREAM_MSG_NOTIFY\ndata: '
      + '{"content_blocks_v2":[{"block_type":2001,"content":{"text_block":{"text":"现网正文"}}}]}\n\n'
      + 'event: STREAM_MSG_NOTIFY\ndata: '
      + '{"message":{"content_blocks_v2":[{"block_type":2001,"content":{"text_block":{"text":"消息内正文"}}}]}}\n\n',
    )
    expect(frames).toEqual([
      { type: 'content', delta: '现网正文' },
      { type: 'content', delta: '消息内正文' },
    ])
  })

  it('STREAM_MSG_END 只结束一条消息，不当作整轮结束（多消息流）', () => {
    const parser = new DoubaoFrameParser()
    expect(parser.push('event: STREAM_MSG_END\ndata: {"message":{}}\n\n')).toEqual([])
    expect(parser.unknownFrameCount).toBe(0)
  })
})
