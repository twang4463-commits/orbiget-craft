/**
 * Metadata DOM 采集（开源抽离版）
 *
 * 与生产代码 src/content-script/capture/metadata.ts 一致，仅将
 * JSON-LD 解析（原在 src/core/metadata.ts）内联为本文件自带。
 *
 * 审计要点：本模块只读取当前页面 DOM（document 查询），
 * 不发起任何网络请求，不监听、不后台采集。
 */

// ── 类型定义 ──

export interface DetectedMetadata {
  // ── 创作相关核心字段 ──
  author?: string
  publishedAt?: string
  license?: string

  // ─ 来源标识 ──
  title?: string
  description?: string
  siteName?: string
  domain?: string
  url?: string
  language?: string

  // ── 预览 ─
  visibleText?: string
}

interface ParsedJsonLD {
  author?: string
  publishedAt?: string
  license?: string
  headline?: string
}

// ── JSON-LD 结构化数据解析 ──

function parseJsonLD(raw: string): ParsedJsonLD {
  const result: ParsedJsonLD = {}
  try {
    const data = JSON.parse(raw)
    const items = Array.isArray(data) ? data : [data, ...(data['@graph'] || [])]
    for (const item of items) {
      if (!result.author && item.author) {
        result.author = typeof item.author === 'string' ? item.author : item.author?.name
      }
      if (!result.publishedAt && item.datePublished) {
        result.publishedAt = item.datePublished
      }
      if (!result.license && item.license) {
        result.license = typeof item.license === 'string' ? item.license : item.license?.url
      }
      if (!result.headline && item.headline) result.headline = item.headline
    }
  } catch { /* ignore parse errors */ }
  return result
}

// ── DOM 采集 ──

/** 安全地取 meta 值 */
function meta(name: string): string | undefined {
  return (
    document.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ||
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ||
    undefined
  )
}

/**
 * 获取页面可见文本片段（最多 200 字）。
 * 用于采集预览，帮助用户回忆采了什么。
 */
function getVisibleTextPreview(): string {
  try {
    const body = document.body
    if (!body) return ''
    const text = body.innerText || body.textContent || ''
    return text.trim().slice(0, 200)
  } catch { return '' }
}

export function detectPageMetadata(): DetectedMetadata {
  const result: DetectedMetadata = {}

  // ─ 基础来源 ──
  result.title = document.title || undefined
  result.url = location.href
  result.domain = location.hostname
  result.language = document.documentElement.lang || undefined

  // ── 1. Schema.org JSON-LD（优先级最高） ─
  const jsonScripts = document.querySelectorAll('script[type="application/ld+json"]')
  for (const script of jsonScripts) {
    const parsed = parseJsonLD(script.textContent || '')
    if (!result.author && parsed.author) result.author = parsed.author
    if (!result.publishedAt && parsed.publishedAt) result.publishedAt = parsed.publishedAt
    if (!result.license && parsed.license) result.license = parsed.license
    if (!result.title && parsed.headline) result.title = parsed.headline
  }

  // ── 2. OpenGraph（只取核心字段） ──
  const ogTitle = meta('og:title')
  const ogDesc = meta('og:description')
  const ogSite = meta('og:site_name')
  if (!result.title && ogTitle) result.title = ogTitle
  if (!result.siteName) result.siteName = ogSite
  if (!result.description) result.description = ogDesc

  // ── 3. 通用 meta ──
  if (!result.author) result.author = meta('article:author') || meta('author')
  if (!result.publishedAt) result.publishedAt = meta('article:published_time') || meta('date')
  if (!result.description) result.description = meta('description')

  // ─ 4. License ──
  if (!result.license) {
    const licenseLink = document.querySelector('link[rel="license"]')
    if (licenseLink) {
      result.license = licenseLink.getAttribute('href') || licenseLink.getAttribute('title') || undefined
    }
  }
  if (!result.license) {
    result.license = meta('cc:license') || meta('dct:rights')
  }

  // ── 5. Citation tags（学术/新闻场景） ──
  const citationAuthor = meta('citation_author')
  const citationDate = meta('citation_publication_date') || meta('citation_date')
  if (!result.author) result.author = citationAuthor
  if (!result.publishedAt) result.publishedAt = citationDate

  // ── 6. 可见文本预览 ──
  const visibleText = getVisibleTextPreview()
  if (visibleText) result.visibleText = visibleText

  return result
}

/**
 * 构建精简快照（用于采集记录）。
 *
 * 只保留创作相关字段，不收集 SEO/社交分享/CMS 内部字段。
 * 输出扁平结构，不重复存储。
 */
export function buildMetadataSnapshot(): Record<string, unknown> {
  const meta = detectPageMetadata()
  const snapshot: Record<string, unknown> = {
    domain: meta.domain,
    language: meta.language,
  }

  if (meta.title) snapshot.title = meta.title
  if (meta.author) snapshot.author = meta.author
  if (meta.publishedAt) snapshot.publishedAt = meta.publishedAt
  if (meta.license) snapshot.license = meta.license
  if (meta.description) snapshot.description = meta.description
  if (meta.siteName) snapshot.siteName = meta.siteName
  if (meta.visibleText) snapshot.visibleTextPreview = meta.visibleText

  return snapshot
}

// ── captureRecord 构建 ──

/** 从采集的原始数据构建 captureRecord（纯函数，无 DOM） */
export function buildCaptureRecordFromCollector(
  raw: {
    sourceUrl: string
    sourceTitle: string
    captureMethod: string
    originalTitle?: string
    metadataSnapshot?: Record<string, unknown>
    collectedAt?: string
  },
) {
  return {
    capturedAt: raw.collectedAt || new Date().toISOString(),
    captureMethod: raw.captureMethod,
    sourceUrl: raw.sourceUrl,
    sourceTitle: raw.sourceTitle,
    originalTitle: raw.originalTitle || raw.sourceTitle || '',
    metadataSnapshot: raw.metadataSnapshot,
  }
}
