/**
 * 生成图片扫描器(2026-10-26)—— 网页端点「产物收割」的流内源(规格 §6.14)。
 *
 * 豆包这类站点会在回答里生成图片(海报/插画)。产物 URL 随 SSE 流下发
 * (结构化块里的 image 卡),但帧解析器只认文本块 —— 与其给每家协议加
 * image 块形状(**必然随页面改版漂移**),不如对**原始流文本**做形状无关
 * 的 URL 扫描:URL 认 `gen_image` 路径(豆包 rc_gen_image;真机证据),
 * 去重认**未签名 objectKey**(去掉查询与 ~tplv 模板后缀),比签名 URL 稳。
 *
 * DOM 扫描(桥侧)是第二源,兜「URL 不在流里/懒加载」;两源在这里用
 * 同一套 key 规则合并。签名 URL 实测 x-expires≈十年,直接存可用;
 * 防盗链/referer 仍以真机为准,渲染失败再考虑页面内转 dataURL。
 */

/** 一张生成媒体:objectKey(去重键,未签名)+ 可访问的签名 URL + 类别 */
export type GenMediaKind = 'image' | 'video' | 'audio'

export interface GenImageRef {
  key: string
  url: string
  /** 缺省 = 图(v2.3 起视频/音频共用此形状) */
  kind?: GenMediaKind
}

/** URL 字面量:止于引号/空白/反斜杠(JSON 字符串边界) */
const URL_RE = /https?:\/\/[^\s"'<>\\]+/g

/** Chrome <img> 能直接渲染的格式(2026-10-26 真机教训:流里的「原图模板」
 *  可能是 ~tplv-…-cgen_dwm3.heic —— HEIC 在 Chromium 不渲染,落进消息就是
 *  碎图标;页面显示用的是 cthumb_*.png 模板。扫描按此择优,heic/heif 不收)。 */
const RENDERABLE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i

/** URL 的真实格式扩展名:剥查询后取最后一个「.」段(模板 URL 的格式写在
 *  ~tplv-…-cgen_dwm3.heic 尾部,普通 URL 就是 .jpeg) */
export function genImageExtOf(url: string): string {
  const path = url.split('?', 1)[0].split('#', 1)[0]
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot) : ''
}

export function isRenderableImageUrl(url: string): boolean {
  return RENDERABLE_EXT_RE.test(genImageExtOf(url))
}

/**
 * 按扩展名判媒体类别(v2.3 视频/音频):只认**能直连播放**的直链形态 ——
 * m3u8(HLS)Chrome 裸 <video> 播不了、blob: 出了页面就失效,都不算
 * (真机若发现豆包视频只以这两种形态出现,DOM/流都扫不到,如实空着)。
 */
export function genMediaKindOf(url: string): GenMediaKind | null {
  const ext = genImageExtOf(url).toLowerCase()
  if (RENDERABLE_EXT_RE.test(ext)) return 'image'
  if (/^\.(mp4|webm|mov|m4v)$/.test(ext)) return 'video'
  if (/^\.(mp3|wav|m4a|aac|ogg|flac)$/.test(ext)) return 'audio'
  return null
}

/** 是否像「AI 生成的图片」地址(2026-10-26 真机:豆包 rc_gen_image + ChatGPT
 *  生图域 —— sfile.chatgpt.com 文件服务 / oaidalle(DALL·E Azure blob)/
 *  openaiusercontent;路径含 gen_image 或命中已知生图域即认) */
export function looksLikeGeneratedImageUrl(url: string): boolean {
  return /gen_image/i.test(url)
    || /sfile\.chatgpt\.com|chatgpt\.com\/(images|files)\//i.test(url)
    || /oaidalle/i.test(url)
    || /openaiusercontent\.com/i.test(url)
}

/**
 * 从 URL 提取去重键 = 未签名 objectKey:**剥掉 scheme://host**,只留路径
 * (去查询、#锚、~tplv 模板后缀)。主机名必须剥:豆包同一张图从 p11/p3/p26
 * 多个 CDN 前缀下发(2026-10-26 真机 DOM 实证),带主机的 key 会把同一张图
 * 当成两张;剥掉后恰好与 data-track-key 尾段(tos-cn-…/rc_gen_image/<uuid>,
 * 无主机)同形 —— 流内源与 DOM 源天然对上。
 */
export function genImageKeyOf(url: string): string {
  // 剥 scheme:// + 主机名,只留路径起(豆包同一张图从 p11/p3/p26 前缀下发)
  let key = url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*\//i, '')
  key = key.split('?', 1)[0].split('#', 1)[0]
  const tplv = key.indexOf('~tplv-')
  if (tplv > 0) key = key.slice(0, tplv)
  return key.replace(/\/+$/, '')
}

/**
 * 从 data-track-key 提取 objectKey(豆包 DOM 证据,2026-10-26 真机):
 * `<数字>_<数字>_<objectKey>` —— 前两段是站点内部 id(消息/元素),尾段
 * 与 URL 里的 objectKey 同源。不是这个形状就按 URL 处理(剥模板后缀)。
 */
export function genImageKeyFromTrackKey(trackKey: string): string {
  const trimmed = trackKey.trim()
  const matched = /^(\d+_)+(.+)$/.exec(trimmed)
  return genImageKeyOf(matched ? matched[2] : trimmed)
}

/**
 * 流里出现「图片工具调用」痕迹(2026-10-26 ChatGPT 生图轮沉淀):新协议的
 * 资产指针不走 SSE 明文,URL 扫描看不到「图在路上」—— 流里唯一稳定的
 * 证据是工具调用名(image_gen / image_tool / text2im / dall-e 系)。
 * 只用于**延长 DOM 等待**(误报无害:白等几秒;漏报丢产物)。
 */
export const GEN_IMAGE_TOOL_HINT_RE = /image_gen|image_tool|text2im|dall-?e/i

/** 单轮扫描器:维护跨块边界的小尾巴(URL 会被 fetch 分块拦腰截断),按 key 去重 */
export class GenImageScanner {
  private tail = ''
  private found = new Map<string, GenImageRef>()
  /** 流里出现过生成媒体痕迹(含不可渲染的 heic)—— 图/视频「在路上」的证据,
   *  驱动器据此决定要不要延长 DOM 等待(2026-10-26 真机:换棍子猴轮,图比
   *  文字晚到 20s+,只看可渲染 refs 会以为没图而提前收口) */
  private sawAnyFlag = false
  /** 流里出现过视频/音频直链 —— 视频生成比图慢得多,等待上限单独放宽 */
  private sawVideoFlag = false
  /** 最多收多少件(防异常流灌爆;正常一轮 ≤4 件) */
  readonly limit: number

  constructor(limit = 12) {
    this.limit = limit
  }

  /** 喂一段原始流文本(SSE 块原文,JSON 转义原样) */
  push(text: string): void {
    if (!text) return
    // JSON 把 / 转义成 \/ —— 先归一再扫(只扫不改原文本,无副作用)
    const buf = (this.tail + text).replace(/\\\//g, '/')
    this.tail = buf.length > 2048 ? buf.slice(-2048) : buf
    for (const url of buf.match(URL_RE) ?? []) {
      const extKind = genMediaKindOf(url)
      const isGenPath = looksLikeGeneratedImageUrl(url)
      // 无任何产物迹象:普通图片/链接,不认
      if (extKind == null && !isGenPath) continue
      if (extKind == null) {
        // gen_image 路径但扩展名不可渲染(真机 heic):收不渲染,但它是
        // 「图在路上」的证据 —— 只记 sawAny 延长等待,不进产物
        this.sawAnyFlag = true
        continue
      }
      if (extKind === 'image') {
        // 图要有 gen_image 路径证据(聊天流里的普通图片链接不是产物);
        // extKind=image 已隐含可渲染(heic 落不到这)
        if (!isGenPath) continue
        this.sawAnyFlag = true
      } else {
        // 视频/音频按直链扩展名即认(补全流里出现 mp4 几乎必然是产物)
        this.sawAnyFlag = true
        this.sawVideoFlag = true
      }
      const key = genImageKeyOf(url)
      if (!key) continue
      // 后写胜:同一件的签名刷新后,流里后出现的 URL 更新(跨块截断由
      // 尾巴缓冲拼回,块内匹配必是完整 URL,不存在「半截先到」)
      this.found.set(key, { key, url, kind: extKind })
      if (this.found.size >= this.limit) break
    }
  }

  /** 流里是否出现过生成媒体痕迹(含不可渲染格式 —— 那是「在路上」的证据) */
  get sawAny(): boolean {
    return this.sawAnyFlag
  }

  /** 流里是否出现过视频/音频直链(等待上限单独放宽,视频生成慢得多) */
  get sawVideo(): boolean {
    return this.sawVideoFlag
  }

  /** 本轮扫到的生成媒体(key 去重,流内顺序) */
  refs(): GenImageRef[] {
    return [...this.found.values()].slice(0, this.limit)
  }
}
