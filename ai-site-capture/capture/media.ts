/**
 * 产物扫描的**通用工具**（站点无关）。
 *
 * 站点专属的容器选择器（豆包的 testid 网格、ChatGPT 的助手气泡）不放这里，
 * 放各自的 `sites/<site>.ts`；这里只提供两边共用的 key 规则与
 * 「全页直链 <video>/<audio>」扫描。
 */
import type { SweptMedia } from './types'

/** 剥查询/哈希/豆包模板后缀 —— 与 `gen-image-scan.ts` 的 key 规则同源 */
export function genKeyOf(url: string): string {
  let key = url.split('?', 1)[0].split('#', 1)[0]
  const tplv = key.indexOf('~tplv-')
  if (tplv > 0) key = key.slice(0, tplv)
  return key.replace(/\/+$/, '')
}

/** 豆包 `data-track-key` 前面带一串 `数字_` 前缀，剥掉再走 genKeyOf */
export function genKeyFromTrackKey(trackKey: string): string {
  const trimmed = trackKey.trim()
  const matched = /^(\d+_)+(.+)$/.exec(trimmed)
  return genKeyOf(matched ? matched[2] : trimmed)
}

/** 全页扫直链视频/音频（blob: 出了页面就失效、m3u8 裸标签播不了，都跳过） */
export function sweepDirectMedia(doc: Document): SweptMedia[] {
  const out: SweptMedia[] = []
  try {
    const pick = (el: HTMLVideoElement | HTMLAudioElement): string =>
      el.getAttribute('src') || el.querySelector('source')?.getAttribute('src') || ''
    for (const el of doc.querySelectorAll<HTMLVideoElement>('video')) {
      const src = pick(el)
      if (!src || !/^https?:/i.test(src) || !/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(src)) continue
      const key = genKeyOf(src)
      if (key) out.push({ key, url: src, kind: 'video' })
    }
    for (const el of doc.querySelectorAll<HTMLAudioElement>('audio')) {
      const src = pick(el)
      if (!src || !/^https?:/i.test(src) || !/\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i.test(src)) continue
      const key = genKeyOf(src)
      if (key) out.push({ key, url: src, kind: 'audio' })
    }
  } catch {
    /* DOM 读挂了：交回流内扫描那一源 */
  }
  return out
}

/** 把一组候选并入 Map（后写胜：DOM 里后出现的签名 URL 更新鲜） */
export function mergeMedia(out: Map<string, SweptMedia>, items: SweptMedia[]): void {
  for (const item of items) {
    if (item.key) out.set(item.key, item)
  }
}
