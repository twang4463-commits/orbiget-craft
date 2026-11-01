/**
 * graph-layout — 力导向布局与视口变换（**纯函数**，无 Vue / 无 DOM / 无 Math.random）
 *
 * Obsidian 那种网图的观感来自三件事，这里逐条对上：
 *   1. **斥力均匀铺开**：所有点互斥，谁也不挤谁（Coulomb，O(n²)，点数 ≤ 140 够用）；
 *   2. **连线像弹簧**：有边的两点互相拉近，边长趋于一致 → 成簇；
 *   3. **整体收拢**：一个弱向心力，否则孤立点被斥力推到天边。
 * 中心节点**钉在原点上**：本稿居中是这个视图的叙事，"中心随机飘"会让每次打开都不一样，
 * 也破坏了可复现性（布局是纯函数，同输入必须同输出 —— 否则没法测）。
 *
 * 参数按节点数自标定（k = √(画布面积 / 点数)，同 d3 的默认口径），
 * 所以 5 个点和 100 个点都长出"同一个密度"，不用为每个规模调参。
 *
 * 视口（平移/缩放）的数学在 `@/shared/utils/viewport`：`zoomAt` 保证**光标下的那个世界点不动** ——
 * 这是滚轮缩放不"跑偏"的唯一判据，可以精确断言。
 */

export interface LayoutNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** 钉住（中心节点 / 正在被拖的节点）：只改坐标，不参与受力积分 */
  fixed: boolean
}

export interface LayoutLink {
  source: string
  target: string
  /** 平行关系聚合后的条数：越粗的线拉得越紧一点 */
  weight?: number
}

export interface LayoutOptions {
  /** 画布参考尺寸（只影响自标定的尺度，不影响观感比例） */
  width?: number
  height?: number
  /** 迭代次数（默认 320；纯同步跑，不靠 rAF） */
  iterations?: number
  /** 初值随机种子：同种子 + 同输入 = 同布局 */
  seed?: number
  /**
   * 本次积分的"温度"（alpha）：力先乘 alpha 再进速度，随迭代衰减。
   * 不衰减会一直抖（力是 O(k) 量级，而位移是逐帧累加的）；这是 d3 的同一套做法。
   */
  alpha?: number
}

export const DEFAULT_LAYOUT_WIDTH = 900
export const DEFAULT_LAYOUT_HEIGHT = 560

/** mulberry32：小、快、可复现（布局不许用 Math.random，否则测不了也稳不了） */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 初值：撒在一个圆环上（半径按点数自标定）+ 一点种子化抖动。
 * 不用"随机撒方格"是因为环上的点两两距离接近、不会一开始就叠在一起。
 */
export function initialLayout(ids: string[], options: LayoutOptions = {}): LayoutNode[] {
  const rand = seededRandom(options.seed ?? 1)
  const width = options.width ?? DEFAULT_LAYOUT_WIDTH
  const height = options.height ?? DEFAULT_LAYOUT_HEIGHT
  const n = Math.max(1, ids.length)
  const k = Math.sqrt((width * height) / n)
  const radius = k * 0.6
  return ids.map((id, i) => {
    const angle = (i / n) * Math.PI * 2
    const jitter = (rand() - 0.5) * k * 0.25
    return {
      id,
      x: Math.cos(angle) * (radius + jitter),
      y: Math.sin(angle) * (radius + jitter),
      vx: 0,
      vy: 0,
      fixed: false,
    }
  })
}

/**
 * 一次积分：弹簧（位置式）+ 斥力 + 向心 → 速度 → 位移。原地修改 nodes。
 *
 * 三处是实测调出来的，不是拍脑袋（第一版三条都错，40 个点挤成一坨、最小屏幕点距 5px，
 * 而且**加了边的两点反而比不加边离得更远**）：
 *
 * 1. **弹簧走位置式修正**（d3 同款）：每轮把两端按 `误差 × 强度 × alpha` 直接挪一点。
 *    走速度式会欠阻尼、来回过冲；而且力是 O(k) 量级，一步跳 80 单位，撞在一起就叠住了。
 * 2. **斥力/向心走速度式**，且 **gravity ∝ 1/k**：不这样标定，自然铺展距离不随 k 线性变化
 *    （点少时 k 大、自然距离反而小于弹簧自然长度 ⇒ 弹簧变成"推开的力"）。
 * 3. **限速**：单步位移不超过 `k * 0.12`，防止偶发大力把点甩穿。
 *
 * 弹簧自然长度取 `0.38k`，明显小于自然铺展距离（≈0.6k）——"有边就更近"才有意义。
 */
export function simulate(
  nodes: LayoutNode[],
  links: LayoutLink[],
  options: LayoutOptions = {},
): void {
  const width = options.width ?? DEFAULT_LAYOUT_WIDTH
  const height = options.height ?? DEFAULT_LAYOUT_HEIGHT
  const n = Math.max(1, nodes.length)
  // 自标定：k = 平均每个点能分到的边长
  const k = Math.sqrt((width * height) / n)
  const charge = k * k
  const linkDistance = k * 0.38
  const springStrength = 0.35
  const gravity = 9.3 / k
  const damping = 0.6
  const alpha = options.alpha ?? 1
  const maxStep = k * 0.12

  const index = new Map<string, LayoutNode>()
  for (const node of nodes) index.set(node.id, node)

  // 1) 弹簧：位置式修正（钉住的点不动）
  for (const link of links) {
    const a = index.get(link.source)
    const b = index.get(link.target)
    if (!a || !b || a === b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1e-6
    const error = (d - linkDistance) / d
    const pull = error * springStrength * alpha * 0.5
    if (!a.fixed) {
      a.x += dx * pull
      a.y += dy * pull
    }
    if (!b.fixed) {
      b.x -= dx * pull
      b.y -= dy * pull
    }
  }

  // 2) 斥力：所有点互斥（速度式）
  const fx = new Float64Array(nodes.length)
  const fy = new Float64Array(nodes.length)
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1e-6) {
        // 完全重合：给一个确定性的分离方向（同一个点对每次都一样）
        dx = ((i % 7) + 1) * 0.01
        dy = ((j % 5) + 1) * 0.01
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      const f = charge / d2
      const ux = dx / d
      const uy = dy / d
      fx[i]! += ux * f
      fy[i]! += uy * f
      fx[j]! -= ux * f
      fy[j]! -= uy * f
    }
  }

  // 3) 向心 + 4) 阻尼积分（钉住的点不参与位移）
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!
    if (node.fixed) {
      node.vx = 0
      node.vy = 0
      continue
    }
    fx[i]! -= node.x * gravity
    fy[i]! -= node.y * gravity
    node.vx = (node.vx + fx[i]! * alpha) * damping
    node.vy = (node.vy + fy[i]! * alpha) * damping
    const speed = Math.hypot(node.vx, node.vy)
    if (speed > maxStep) {
      const scale = maxStep / speed
      node.vx *= scale
      node.vy *= scale
    }
    node.x += node.vx
    node.y += node.vy
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      // 数值兜底：绝不让 NaN 进渲染（图上的 NaN 会让整层静默消失）
      node.x = 0
      node.y = 0
      node.vx = 0
      node.vy = 0
    }
  }
}

/** 一次性把布局跑到收敛（打开弹窗、重新布局时用）：alpha 从 1 衰减到 ~0.01 */
export function layoutGraph(
  nodes: LayoutNode[],
  links: LayoutLink[],
  options: LayoutOptions = {},
): LayoutNode[] {
  const iterations = options.iterations ?? 320
  let alpha = options.alpha ?? 1
  for (let i = 0; i < iterations; i += 1) {
    simulate(nodes, links, { ...options, alpha })
    alpha = Math.max(0.01, alpha * 0.985)
  }
  return nodes
}

// ── 视口（平移/缩放）──
// 已提到 `@/shared/utils/viewport`：脑洞画布要用同一套数学，而画布不该反向依赖
// write-article 场景模块。这里不再重复实现，也不再转发（消费方直接从 shared 取）。

