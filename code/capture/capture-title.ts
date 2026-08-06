/**
 * 采集标题统一兜底（开源抽离版）
 *
 * 与生产代码 src/content-script/capture/capture-title.ts 一致，仅将
 * isSafeFileExtension（原在 src/export/utils.ts）内联为本文件自带。
 *
 * 规则：title = 短展示名（可当文件名）；URL / 页标题只进 source，
 * 永不作为 title 兜底。
 */

export type CaptureTitleKind =
  | 'image'
  | 'screenshot'
  | 'ai-artwork'
  | 'excerpt'
  | 'article'
  | 'bookmark'

export interface CaptureTitleHints {
  /** 媒体 URL（图片） */
  mediaUrl?: string | null
  /** img alt / aria-label */
  alt?: string | null
  /** 页面 URL（仅用于抠站点名，不进 title） */
  pageUrl?: string | null
  /** 页面标题（仅书签/文章可用，截断后可进 title） */
  pageTitle?: string | null
  /** 站点名 */
  siteName?: string | null
  /** 正文 / prompt */
  text?: string | null
  /** 文章抽取标题 */
  articleTitle?: string | null
  /** AI prompt */
  prompt?: string | null
}

const TITLE_MAX = 40
const EXCERPT_SNIPPET = 24

function isSafeFileExtension(ext: string): boolean {
  return /^\.[a-z0-9]{1,8}$/i.test(ext)
}

export function clampCaptureTitle(raw: string, max = TITLE_MAX): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

export function looksLikeUrl(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (/^https?:\/\//i.test(v)) return true
  if (/^data:/i.test(v)) return true
  if (/^blob:/i.test(v)) return true
  if (v.includes('://')) return true
  return false
}

export function extractSiteLabel(url?: string | null): string | null {
  if (!url) return null
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    const label = hostname.split('.')[0] || ''
    return label || null
  } catch {
    return null
  }
}

/** 媒体 URL 末段是否像真正文件名（带安全扩展名） */
export function isUsableMediaFilename(segment: string): boolean {
  const name = segment.trim()
  if (!name || looksLikeUrl(name)) return false
  if (name.includes('/') || name.includes('\\')) return false
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = name.slice(dot)
  if (!isSafeFileExtension(ext)) return false
  const base = name.slice(0, dot)
  return base.length > 0 && base.length <= 80
}

export function extractMediaFilename(mediaUrl?: string | null): string | null {
  if (!mediaUrl) return null
  if (/^(data|blob):/i.test(mediaUrl)) return null
  try {
    const pathname = new URL(mediaUrl).pathname
    const last = pathname.split('/').filter(Boolean).pop() || ''
    const decoded = decodeURIComponent(last)
    return isUsableMediaFilename(decoded) ? decoded : null
  } catch {
    return null
  }
}

function timeStamp(withSeconds = false): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (!withSeconds) return `${hh}${mm}`
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}${mm}${ss}`
}

function siteOr(hints: CaptureTitleHints): string | null {
  return hints.siteName?.trim() || extractSiteLabel(hints.pageUrl) || null
}

function usableAlt(alt?: string | null): string | null {
  if (!alt) return null
  const t = alt.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 60) return null
  if (looksLikeUrl(t)) return null
  if (/^(image|img|photo|picture)$/i.test(t)) return null
  return clampCaptureTitle(t)
}

/**
 * 按采集类型解析默认 title（短、可读、可当文件名）。
 */
export function resolveCaptureTitle(kind: CaptureTitleKind, hints: CaptureTitleHints = {}): string {
  const site = siteOr(hints)

  switch (kind) {
    case 'image': {
      const file = extractMediaFilename(hints.mediaUrl)
      if (file) return clampCaptureTitle(file)
      const alt = usableAlt(hints.alt)
      if (alt) return alt
      if (site) return `图片-${site}-${timeStamp()}`
      return `图片-${timeStamp()}`
    }
    case 'screenshot': {
      if (site) return `截图-${site}-${timeStamp(true)}`
      return `截图-${timeStamp(true)}`
    }
    case 'ai-artwork': {
      const prompt = hints.prompt?.replace(/\s+/g, ' ').trim()
      if (prompt && !looksLikeUrl(prompt)) return clampCaptureTitle(prompt)
      if (site) return `AI作品-${site}-${timeStamp()}`
      return `AI作品-${timeStamp()}`
    }
    case 'excerpt': {
      const text = hints.text?.replace(/\s+/g, ' ').trim() || ''
      if (text) {
        const snip = text.length <= EXCERPT_SNIPPET ? text : text.slice(0, EXCERPT_SNIPPET)
        return clampCaptureTitle(`摘录-${snip}`)
      }
      return `摘录-${timeStamp(true)}`
    }
    case 'article': {
      const article = hints.articleTitle?.replace(/\s+/g, ' ').trim()
      if (article && !looksLikeUrl(article)) return clampCaptureTitle(article)
      if (site) return `文章-${site}`
      return '未命名文章'
    }
    case 'bookmark': {
      const page = hints.pageTitle?.replace(/\s+/g, ' ').trim()
      if (page && !looksLikeUrl(page)) return clampCaptureTitle(page)
      if (site) return clampCaptureTitle(site)
      return '书签'
    }
    default:
      return '未命名'
  }
}

/** asset-builder 最终兜底：按类型短名，绝不回退到 URL */
export function defaultTitleForAssetType(type: string): string {
  switch (type) {
    case 'image':
      return '未命名图片'
    case 'video':
      return '未命名视频'
    case 'audio':
      return '未命名音频'
    case 'bookmark':
      return '书签'
    case 'note':
      return '未命名笔记'
    default:
      return '未命名'
  }
}

/** 从 assetId 取短后缀（与 generateId 同体系，稳定可复现） */
export function shortAssetIdSuffix(id: string): string {
  const alnum = id.replace(/[^a-zA-Z0-9]/g, '')
  if (alnum.length >= 6) return alnum.slice(-8)
  return (alnum || Date.now().toString(36)).slice(-8)
}

/** 实在没有可读标题时：类型前缀 + id 短后缀 */
export function titleFromAssetId(type: string, id: string): string {
  const prefix = (() => {
    switch (type) {
      case 'image': return '图片'
      case 'video': return '视频'
      case 'audio': return '音频'
      case 'bookmark': return '书签'
      case 'note': return '笔记'
      default: return '素材'
    }
  })()
  return `${prefix}-${shortAssetIdSuffix(id)}`
}

/** 是否仍是泛化占位名，需要改成 id 兜底 */
export function needsIdBackedTitle(title: string): boolean {
  const t = title.replace(/\s+/g, ' ').trim()
  if (!t || looksLikeUrl(t)) return true
  if (/^未命名/.test(t)) return true
  if (t === '书签' || t === '未命名文章') return true
  return false
}
