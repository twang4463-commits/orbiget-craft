/**
 * Page Content Extractor（开源抽离版）
 *
 * 与生产代码 src/content-script/capture/page-extractor.ts 一致，
 * 使用 Mozilla Readability.js 提取网页正文内容。
 *
 * 依赖：`npm i @mozilla/readability`（MIT 许可）。
 * 审计要点：只操作当前页面的 DOM 副本（document.cloneNode），
 * 不发起任何网络请求。
 */
import { Readability } from '@mozilla/readability'
import { detectPageMetadata } from './metadata'
import { sanitizeDomText } from './text-sanitize'

export interface ExtractedPageContent {
  /** 页面标题 */
  title: string
  /** 正文内容（纯文本） */
  content: string
  /** 正文内容（HTML） */
  contentHtml: string
  /** 文本摘要（前200字符） */
  excerpt: string
  /** 站点名称 */
  siteName?: string
  /** 发布时间 */
  publishedTime?: string
  /** 作者 */
  author?: string
  /** 许可证 / 版权说明 */
  license?: string
  /** 阅读时间估算（分钟） */
  readingTime?: number
  /** 字数统计 */
  wordCount?: number
  /** 提取是否成功 */
  success: boolean
  /** 错误信息 */
  error?: string
}

/**
 * 提取页面主要内容
 *
 * @returns 提取的页面内容
 */
export function extractPageContent(): ExtractedPageContent {
  try {
    // 使用 Readability.js 提取内容
    const documentClone = document.cloneNode(true) as Document
    const reader = new Readability(documentClone)
    const article = reader.parse()

    if (!article) {
      return {
        title: document.title || '',
        content: '',
        contentHtml: '',
        excerpt: '',
        success: false,
        error: 'Readability failed to parse article'
      }
    }

    // 清理文本内容
    const cleanContent = sanitizeDomText(article.textContent || '')
    const cleanExcerpt = sanitizeDomText(article.excerpt || '')

    // 计算字数和阅读时间
    const wordCount = cleanContent.length
    const readingTime = Math.ceil(wordCount / 500) // 假设每分钟阅读500字

    // 获取元数据
    const metadata = detectPageMetadata()

    return {
      title: article.title || document.title || '',
      content: cleanContent,
      contentHtml: article.content || '',
      excerpt: cleanExcerpt,
      siteName: metadata.siteName,
      publishedTime: metadata.publishedAt,
      author: metadata.author,
      license: metadata.license,
      readingTime,
      wordCount,
      success: true
    }
  } catch (error) {
    return {
      title: document.title || '',
      content: '',
      contentHtml: '',
      excerpt: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * 提取页面内容并返回精简版本（用于快速预览）
 */
export function extractPageContentPreview(): {
  title: string
  excerpt: string
  success: boolean
} {
  try {
    const documentClone = document.cloneNode(true) as Document
    const reader = new Readability(documentClone)
    const article = reader.parse()

    if (!article) {
      return {
        title: document.title || '',
        excerpt: '',
        success: false
      }
    }

    const cleanExcerpt = sanitizeDomText(article.excerpt || article.textContent?.slice(0, 200) || '')

    return {
      title: article.title || document.title || '',
      excerpt: cleanExcerpt,
      success: true
    }
  } catch {
    return {
      title: document.title || '',
      excerpt: '',
      success: false
    }
  }
}
