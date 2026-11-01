/**
 * viewport — 画布类表面的**视口变换**（纯函数，无 Vue / 无 DOM）
 *
 * 关系图（`workbench/relations/ArticleRelationGraph`）与脑洞画布
 * （`workbench/canvas/CanvasBoard`）都需要同一套东西：一个世界坐标 → 屏幕坐标的
 * 平移+缩放，滚轮缩放要**锚在光标上**，初始要**铺满居中**。
 * 这类数学只有一份，所以放在 shared/utils（两个消费者，无领域语义）。
 *
 * 全部是纯函数：可精确断言（`zoomAt` 的判据就是"光标下的世界点不动"），
 * 也让 UI 层不必自己趟一遍三角函数。
 */

export interface Viewport {
  tx: number
  ty: number
  k: number
}

export const IDENTITY_VIEWPORT: Viewport = { tx: 0, ty: 0, k: 1 }
export const MIN_SCALE = 0.2
export const MAX_SCALE = 3

/** 屏幕坐标 → 世界坐标（拖拽落点换算用） */
export function screenToWorld(vp: Viewport, px: number, py: number): { x: number; y: number } {
  return { x: (px - vp.tx) / vp.k, y: (py - vp.ty) / vp.k }
}

/**
 * 世界坐标 → 屏幕坐标。
 * 用于"把 UI 贴在某个世界坐标物体旁边、但**不跟着缩放**"（脑洞画布的卡片操作面板：
 * 缩放画布时面板要保持在卡片下方、字号不变，缩到 50% 时还得能读）。
 */
export function worldToScreen(vp: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: x * vp.k + vp.tx, y: y * vp.k + vp.ty }
}

/**
 * 以屏幕点 (px, py) 为锚缩放：**锚点下的世界坐标保持不变**。
 * 判据（可测）：`screenToWorld(zoomAt(vp, f, px, py), px, py) ≈ screenToWorld(vp, px, py)`。
 */
export function zoomAt(
  vp: Viewport,
  factor: number,
  px: number,
  py: number,
  minScale: number = MIN_SCALE,
  maxScale: number = MAX_SCALE,
): Viewport {
  const k = Math.min(maxScale, Math.max(minScale, vp.k * factor))
  const ratio = k / vp.k
  return { k, tx: px - (px - vp.tx) * ratio, ty: py - (py - vp.ty) * ratio }
}

/** 把世界包围盒铺进画布（留 padding），图/画布初始就"铺满、居中" */
export function fitViewport(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  padding: number = 48,
  minScale: number = MIN_SCALE,
  maxScale: number = MAX_SCALE,
): Viewport {
  const bw = Math.max(1, bounds.maxX - bounds.minX)
  const bh = Math.max(1, bounds.maxY - bounds.minY)
  const usableW = Math.max(1, width - padding * 2)
  const usableH = Math.max(1, height - padding * 2)
  const k = Math.min(maxScale, Math.max(minScale, Math.min(usableW / bw, usableH / bh)))
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return { k, tx: width / 2 - cx * k, ty: height / 2 - cy * k }
}

/** 节点世界包围盒（fitViewport 的输入） */
export function boundsOf(nodes: { x: number; y: number }[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
  }
  return { minX, minY, maxX, maxY }
}
