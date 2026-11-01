import { describe, expect, it } from 'vitest'
import {
  GenImageScanner,
  genImageExtOf,
  genImageKeyFromTrackKey,
  genImageKeyOf,
  genMediaKindOf,
  isRenderableImageUrl,
  looksLikeGeneratedImageUrl,
} from '../gen-image-scan'

describe('gen-image-scan', () => {
  it('URL 认 gen_image 路径;普通地址不认', () => {
    expect(looksLikeGeneratedImageUrl('https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/8077a9b0.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?x-signature=abc')).toBe(true)
    expect(looksLikeGeneratedImageUrl('https://example.com/images/photo.jpeg')).toBe(false)
    expect(looksLikeGeneratedImageUrl('https://example.com/api/completion')).toBe(false)
  })

  it('ChatGPT 生图域也认(2026-10-26 图片轮真机)', () => {
    expect(looksLikeGeneratedImageUrl('https://sfile.chatgpt.com/images/abc.png?se=2027')).toBe(true)
    expect(looksLikeGeneratedImageUrl('https://sfile.chatgpt.com/t/file/download?uuid=x')).toBe(true)
    expect(looksLikeGeneratedImageUrl('https://oaidalleapiprodscus.blob.core.windows.net/private/org-x/img.png')).toBe(true)
    expect(looksLikeGeneratedImageUrl('https://example.com/images/photo.jpeg')).toBe(false)
    const scanner = new GenImageScanner()
    scanner.push('{"v":"https:\\/\\/sfile.chatgpt.com\\/images\\/horse.png?se=1"}')
    const refs = scanner.refs()
    expect(refs).toHaveLength(1)
    expect(refs[0].key).toBe('images/horse.png')
  })

  it('去重键剥 scheme://host、查询、#锚与 ~tplv 模板后缀 = 未签名 objectKey', () => {
    // 同一 objectKey 从不同 CDN 前缀下发 ⇒ 同一个 key(真机 p11/p3/p26)
    const a = genImageKeyOf('https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/8077a9b0.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?lk3s=x&x-signature=y')
    const b = genImageKeyOf('https://p6-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/8077a9b0.jpeg?sig=z')
    expect(a).toBe('tos-cn-i-a9rns2rl98/rc_gen_image/8077a9b0.jpeg')
    expect(b).toBe(a)
    expect(genImageKeyOf('https://a.com/img.png#frag')).toBe('img.png')
  })

  it('data-track-key 取尾段 objectKey(前两段是站点内部 id)', () => {
    const key = genImageKeyFromTrackKey('59696897698332674_40487958953621762_tos-cn-i-a9rns2rl98/rc_gen_image/8077a9b0.jpeg')
    expect(key).toBe('tos-cn-i-a9rns2rl98/rc_gen_image/8077a9b0.jpeg')
    // 不是 <数字>_ 形状就按 URL 处理(同样剥主机)
    expect(genImageKeyFromTrackKey('https://a.com/rc_gen_image/x.jpeg?sig=1')).toBe('rc_gen_image/x.jpeg')
  })

  it('流内扫描:JSON 转义的 \\/ 归一后命中,同 key 去重(CDN 前缀不同也算同一张)', () => {
    const scanner = new GenImageScanner()
    scanner.push('data: {"event_data":"{\\"image_url\\":\\"https:\\/\\/p11.byteimg.com\\/tos-cn-i\\/rc_gen_image\\/a.jpeg~tplv-x.png?sig=1\\"}"}')
    scanner.push('data: {"text":"https://p3.byteimg.com/tos-cn-i/rc_gen_image/a.jpeg?sig=2"}')
    const refs = scanner.refs()
    expect(refs).toHaveLength(1)
    // 后写胜:流里后出现的签名 URL 更新鲜
    expect(refs[0].url).toContain('?sig=2')
    expect(refs[0].key).toBe('tos-cn-i/rc_gen_image/a.jpeg')
  })

  it('跨块边界:URL 被拦腰截断也能拼回来', () => {
    const scanner = new GenImageScanner()
    scanner.push('前半 https://p11.byteimg.com/tos-cn-i/rc_gen_im')
    scanner.push('age/a.jpeg?sig=3 后半')
    const refs = scanner.refs()
    expect(refs).toHaveLength(1)
    expect(refs[0].url).toBe('https://p11.byteimg.com/tos-cn-i/rc_gen_image/a.jpeg?sig=3')
  })

  it('用户上传图(非 gen_image)不进产物;超过 limit 截断', () => {
    const scanner = new GenImageScanner(2)
    scanner.push('https://a.com/upload/user.png https://b.com/rc_gen_image/1.jpeg https://c.com/rc_gen_image/2.jpeg https://d.com/rc_gen_image/3.jpeg')
    const refs = scanner.refs()
    expect(refs.map(r => r.url)).toEqual([
      'https://b.com/rc_gen_image/1.jpeg',
      'https://c.com/rc_gen_image/2.jpeg',
    ])
  })

  it('HEIC 等渲染不了的格式不收(2026-10-26 真机:流里只发 cgen_dwm3.heic)', () => {
    expect(genImageExtOf('https://p11.x.com/rc_gen_image/a.jpeg~tplv-t-cgen_dwm3.heic?sig=1')).toBe('.heic')
    expect(isRenderableImageUrl('https://p11.x.com/rc_gen_image/a.jpeg~tplv-t-cgen_dwm3.heic?sig=1')).toBe(false)
    expect(isRenderableImageUrl('https://p11.x.com/rc_gen_image/a.jpeg~tplv-t-cthumb_dwm3.png?sig=1')).toBe(true)
    const scanner = new GenImageScanner()
    scanner.push('https://p11.x.com/rc_gen_image/a.jpeg~tplv-t-cgen_dwm3.heic?sig=1')
    // refs 不收(碎图标),但 sawAny 是 true —— 「图在路上」,收割据此延长等待
    expect(scanner.refs()).toEqual([])
    expect(scanner.sawAny).toBe(true)
  })

  it('同 key 多模板:可渲染格式胜出(heic 先到、png 后到也收 png)', () => {
    const scanner = new GenImageScanner()
    // 只收可渲染 ⇒ 场景实际是「先 png 后 png」与「heic 单独出现」;
    // heic 先到被滤掉,后到的 png 正常收
    scanner.push('https://p11.x.com/rc_gen_image/a.jpeg~tplv-t-cgen_dwm3.heic?sig=1 https://p3.x.com/rc_gen_image/a.jpeg~tplv-t-cthumb_dwm3.png?sig=2')
    const refs = scanner.refs()
    expect(refs).toHaveLength(1)
    expect(refs[0].url).toContain('cthumb_dwm3.png?sig=2')
  })

  it('视频/音频按直链扩展名即认;m3u8/blob 不认(v2.3)', () => {
    expect(genMediaKindOf('https://vod.byteimg.com/rc_gen_video/ab.mp4?sig=1')).toBe('video')
    expect(genMediaKindOf('https://vod.byteimg.com/a.m3u8?sig=1')).toBeNull()
    expect(genMediaKindOf('https://x.com/tts/out.mp3')).toBe('audio')
    // blob: 不是 https,URL_RE 根本不匹配;扩展名兜底也拦一道
    expect(genMediaKindOf('blob:https://x.com/uuid')).toBeNull()
    const scanner = new GenImageScanner()
    scanner.push('data: {"v":"https://vod.x.com/gen/ab.mp4?sig=1"} https://x.com/tts/c.mp3')
    const refs = scanner.refs()
    expect(refs.map(r => r.kind)).toEqual(['video', 'audio'])
    expect(scanner.sawAny).toBe(true)
    expect(scanner.sawVideo).toBe(true)
  })

  it('纯图片轮 sawVideo 为 false(等待上限维持 28s,不误放宽)', () => {
    const scanner = new GenImageScanner()
    scanner.push('https://p11.x.com/rc_gen_image/a.jpeg?sig=1')
    expect(scanner.sawAny).toBe(true)
    expect(scanner.sawVideo).toBe(false)
  })
})
