/**
 * graph-model / graph-layout 纯函数测试 —— 关系图的模型与布局契约
 *
 * 这些断言就是"网图看起来对不对"的可判定部分：邻域切得对、邻居之间真有边、
 * 平行关系聚合、方向语义正确、布局确定且边真的更短、缩放锚点不跑偏。
 * （"好不好看"不在这里，也不打算用机器判。）
 */
import { describe, it, expect } from 'vitest'
import { assetAnchor } from '../anchor'
import type { Anchor } from '../anchor'
import type { Relation, RelationType } from '../relation'
import { buildRelationGraph } from '../relation-graph'
import {
  boundsOf,
  fitViewport,
  IDENTITY_VIEWPORT,
  screenToWorld,
  zoomAt,
  MAX_SCALE,
  MIN_SCALE,
} from '../viewport'
import { initialLayout, layoutGraph, seededRandom } from '../relation-graph-layout'

let seq = 0
function rel(type: RelationType, from: string, to: string, id?: string): Relation {
  seq += 1
  return {
    id: id ?? `r${seq}`,
    projectId: 'p1',
    from: assetAnchor(from) as Anchor,
    to: assetAnchor(to) as Anchor,
    type,
    note: '',
    source: 'user_manual',
    createdAt: 1000 + seq,
  }
}

const CENTER = 'doc-center'

describe('buildRelationGraph — 邻域与连线', () => {
  it('一跳：只有直接邻居', () => {
    const g = buildRelationGraph({
      relations: [rel('references', CENTER, 'a'), rel('references', 'b', CENTER)],
      centerId: CENTER,
      depth: 1,
    })
    expect(g.nodes.map(n => n.id).sort()).toEqual([CENTER, 'a', 'b'].sort())
    expect(g.links).toHaveLength(2)
    expect(g.nodes.find(n => n.id === 'a')!.dir).toBe('out')
    expect(g.nodes.find(n => n.id === 'b')!.dir).toBe('in')
    expect(g.nodes.find(n => n.id === CENTER)!.dir).toBe('center')
    expect(g.outCount).toBe(1)
    expect(g.inCount).toBe(1)
  })

  it('一跳也画**邻居之间**的边（Obsidian 口径：进了图的点，边就画）', () => {
    const g = buildRelationGraph({
      relations: [
        rel('references', CENTER, 'a'),
        rel('references', CENTER, 'b'),
        rel('related', 'a', 'b'),
      ],
      centerId: CENTER,
      depth: 1,
    })
    const peer = g.links.find(l => l.source === 'a' && l.target === 'b')
    expect(peer).toBeDefined()
    expect(peer!.dir).toBe('far') // 与本文无直接关系 → 上灰
  })

  it('二跳：邻居的邻居也进图，且**邻居之间本来就有边**会被画出来', () => {
    const g = buildRelationGraph({
      relations: [
        rel('references', CENTER, 'a'),
        rel('related', 'a', 'a2'),        // 二跳：a 的另一个邻居
        rel('related', 'a', 'b'),         // 一跳节点之间的边（星形图里看不到）
        rel('references', 'b', CENTER),
      ],
      centerId: CENTER,
      depth: 2,
    })
    const ids = g.nodes.map(n => n.id).sort()
    expect(ids).toEqual(['a', 'a2', 'b', CENTER].sort())
    const peerLink = g.links.find(l => (l.source === 'a' && l.target === 'b'))
    expect(peerLink).toBeDefined()
    // 与本文无直接关系的线用 dir='far' 上灰，不改线本身的方向
    expect(peerLink!.dir).toBe('far')
    expect(peerLink!.source).toBe('a')
    expect(g.nodes.find(n => n.id === 'a2')!.hop).toBe(2)
    expect(g.nodes.find(n => n.id === 'a2')!.dir).toBe('far')
  })

  it('一跳节点同时被本文引用又引用本文 → dir=both', () => {
    const g = buildRelationGraph({
      relations: [rel('references', CENTER, 'x'), rel('related', 'x', CENTER)],
      centerId: CENTER,
      depth: 1,
    })
    expect(g.nodes.find(n => n.id === 'x')!.dir).toBe('both')
  })

  it('平行关系聚合成一条线（count 计条数），不铺成多条重合的线', () => {
    const g = buildRelationGraph({
      relations: [
        rel('references', CENTER, 'a'),
        rel('references', CENTER, 'a'),
        rel('references', CENTER, 'a'),
      ],
      centerId: CENTER,
      depth: 1,
    })
    expect(g.links).toHaveLength(1)
    expect(g.links[0]!.count).toBe(3)
    expect(g.nodes.find(n => n.id === 'a')!.relationCount).toBe(3)
    expect(g.nodes.find(n => n.id === 'a')!.degree).toBe(1)
  })

  it('类型不同就是两条线（引用 ≠ 衍生）', () => {
    const g = buildRelationGraph({
      relations: [rel('references', CENTER, 'a'), rel('derivative', CENTER, 'a')],
      centerId: CENTER,
      depth: 1,
    })
    expect(g.links).toHaveLength(2)
    expect(g.nodes.find(n => n.id === 'a')!.degree).toBe(2)
  })

  it('audio_binding 不进图（音频工位的关系，与右侧面板同口径）', () => {
    const audio: Relation = { ...rel('audio_binding', CENTER, 'audio-1'), source: 'audio_recording' }
    const g = buildRelationGraph({
      relations: [rel('references', CENTER, 'a'), audio],
      centerId: CENTER,
      depth: 1,
    })
    expect(g.nodes.map(n => n.id)).not.toContain('audio-1')
    expect(g.links).toHaveLength(1)
  })

  it('自环不参与跳数/度数（但仍在图里）', () => {
    const g = buildRelationGraph({
      relations: [rel('related', CENTER, CENTER), rel('references', CENTER, 'a')],
      centerId: CENTER,
      depth: 1,
    })
    expect(g.nodes.map(n => n.id).sort()).toEqual([CENTER, 'a'].sort())
    expect(g.nodes.find(n => n.id === CENTER)!.degree).toBe(1)
  })

  it('节点超上限：按"跳数小、度数大"保留，并标记 truncated', () => {
    const relations = Array.from({ length: 20 }, (_, i) => rel('references', CENTER, `n${i}`))
    // deg-1 的再连一圈，制造度数差异
    relations.push(rel('related', 'n0', 'n1'), rel('related', 'n0', 'n2'), rel('related', 'n0', 'n3'))
    const g = buildRelationGraph({ relations, centerId: CENTER, depth: 2, maxNodes: 5 })
    expect(g.truncated).toBe(true)
    expect(g.nodes).toHaveLength(5)
    expect(g.nodes[0]!.id).toBe(CENTER)
    expect(g.nodes.map(n => n.id)).toContain('n0') // 度数最高的邻居留下
  })

  it('输出顺序确定（同输入两次调用完全一致）', () => {
    const relations = [rel('references', CENTER, 'a'), rel('related', 'a', 'b'), rel('references', CENTER, 'b')]
    const a = buildRelationGraph({ relations, centerId: CENTER, depth: 2 })
    const b = buildRelationGraph({ relations, centerId: CENTER, depth: 2 })
    expect(a).toEqual(b)
  })

  it('空关系：只有中心自己，没有线', () => {
    const g = buildRelationGraph({ relations: [], centerId: CENTER, depth: 2 })
    expect(g.nodes.map(n => n.id)).toEqual([CENTER])
    expect(g.links).toEqual([])
    expect(g.truncated).toBe(false)
  })
})

describe('graph-layout — 力导向', () => {
  const model = buildRelationGraph({
    relations: [
      rel('references', CENTER, 'a'),
      rel('references', CENTER, 'b'),
      rel('references', CENTER, 'c'),
      rel('related', 'a', 'b'),
      rel('related', 'b', 'c'),
      rel('related', 'a', 'far1'),
      rel('related', 'far1', 'far2'),
    ],
    centerId: CENTER,
    depth: 3,
  })
  const links = [
    ...model.links.map(l => ({ source: l.source, target: l.target, weight: l.count })),
  ]

  it('同种子 + 同输入 → 完全相同的坐标（布局可复现，否则没法测也没法"回到原样"）', () => {
    const run = () => layoutGraph(initialLayout(model.nodes.map(n => n.id), { seed: 7 }), links, { seed: 7 })
    const a = run()
    const b = run()
    expect(a.map(n => [n.id, Math.round(n.x * 1000), Math.round(n.y * 1000)]))
      .toEqual(b.map(n => [n.id, Math.round(n.x * 1000), Math.round(n.y * 1000)]))
  })

  it('弹簧真的把有边的点拉近了（同初值：加边 vs 不加边）', () => {
    const dist = (ns: { x: number; y: number }[]) => Math.hypot(ns[0]!.x - ns[1]!.x, ns[0]!.y - ns[1]!.y)
    const opts = { seed: 4, width: 900, height: 560 }
    const apart = layoutGraph(initialLayout(['a', 'b'], opts), [], opts)
    const pulled = layoutGraph(initialLayout(['a', 'b'], opts), [{ source: 'a', target: 'b' }], opts)
    expect(dist(pulled)).toBeLessThan(dist(apart))
  })

  it('成图更紧凑：同一批点，有边比无边铺得小（包围盒面积）', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `n${i}`)
    const chain = ids.slice(1).map((id, i) => ({ source: `n${i}`, target: id }))
    const opts = { seed: 6, width: 900, height: 560 }
    const area = (ns: ReturnType<typeof initialLayout>) => {
      const b = boundsOf(ns)
      return (b.maxX - b.minX) * (b.maxY - b.minY)
    }
    const loose = area(layoutGraph(initialLayout(ids, opts), [], opts))
    const tight = area(layoutGraph(initialLayout(ids, opts), chain, opts))
    expect(tight).toBeLessThan(loose)
  })

  it('钉住的点不动（中心本稿居中）', () => {
    const nodes = initialLayout(['c', 'a', 'b'], { seed: 5 })
    nodes[0]!.fixed = true
    const before = { x: nodes[0]!.x, y: nodes[0]!.y }
    layoutGraph(nodes, [{ source: 'c', target: 'a' }, { source: 'c', target: 'b' }], { seed: 5 })
    expect(nodes[0]!.x).toBe(before.x)
    expect(nodes[0]!.y).toBe(before.y)
  })

  it('坐标永远是有限数（NaN 会让整张图静默消失）', () => {
    const nodes = initialLayout(model.nodes.map(n => n.id), { seed: 11 })
    layoutGraph(nodes, links, { seed: 11 })
    expect(nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })

  it('完全重合的两点也能被分开（重合时给确定性分离方向）', () => {
    const nodes = initialLayout(['a', 'b'], { seed: 1 })
    nodes[0]!.x = 0; nodes[0]!.y = 0
    nodes[1]!.x = 0; nodes[1]!.y = 0
    layoutGraph(nodes, [], { seed: 1 })
    expect(Math.hypot(nodes[0]!.x - nodes[1]!.x, nodes[0]!.y - nodes[1]!.y)).toBeGreaterThan(1)
  })

  it('seededRandom 确定且落在 [0,1)', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    for (let i = 0; i < 20; i += 1) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('点数多也不叠在一起：铺满画布后，最小的两点屏幕距离 > 两个最大点径之和', () => {
    // 力导向最经典的失败是点挤成一坨 —— 判据要在**屏幕空间**上，
    // 因为 fitViewport 会把世界坐标缩放进画布，世界距离大小本身说明不了问题。
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`)
    const synthetic = ids.slice(1).map((id, i) => ({ source: i % 7 === 0 ? 'n0' : `n${i}`, target: id }))
    const canvas = { w: 868, h: 520 }
    const nodes = layoutGraph(
      initialLayout(ids, { seed: 9, width: canvas.w, height: canvas.h }),
      synthetic,
      { seed: 9, width: canvas.w, height: canvas.h },
    )
    const vp = fitViewport(boundsOf(nodes), canvas.w, canvas.h, 72)
    let minScreen = Infinity
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const d = Math.hypot(nodes[i]!.x - nodes[j]!.x, nodes[i]!.y - nodes[j]!.y) * vp.k
        minScreen = Math.min(minScreen, d)
      }
    }
    // 旧图标时代的判据沿用：两点在屏上至少隔开一个小节点直径；
    // 卡片节点的间距由组件抬布局参考尺度保证（见 ArticleRelationGraph 的 CARD_PITCH）
    expect(minScreen).toBeGreaterThan(18)
  })
})

describe('graph-layout — 视口变换', () => {
  it('缩放时**光标下的世界点不动**（滚轮缩放不跑偏的唯一判据）', () => {
    const vp = { tx: 40, ty: -20, k: 1.2 }
    const px = 300
    const py = 180
    const before = screenToWorld(vp, px, py)
    const zoomed = zoomAt(vp, 1.4, px, py)
    const after = screenToWorld(zoomed, px, py)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
    expect(zoomed.k).toBeCloseTo(1.68, 6)
  })

  it('缩放到头就夹住（不会缩成 0 或放到失控）', () => {
    let vp = IDENTITY_VIEWPORT
    for (let i = 0; i < 40; i += 1) vp = zoomAt(vp, 0.8, 100, 100)
    expect(vp.k).toBeCloseTo(MIN_SCALE, 6)
    for (let i = 0; i < 80; i += 1) vp = zoomAt(vp, 1.3, 100, 100)
    expect(vp.k).toBeCloseTo(MAX_SCALE, 6)
  })

  it('fitViewport：图铺满并居中（包围盒中心落在画布中心）', () => {
    const bounds = { minX: -200, minY: -100, maxX: 200, maxY: 100 }
    const vp = fitViewport(bounds, 800, 600, 40)
    const center = screenToWorld(vp, 400, 300)
    expect(center.x).toBeCloseTo(0, 6)
    expect(center.y).toBeCloseTo(0, 6)
    // 宽度方向受限：400 宽的世界铺进 720 可用宽度
    expect(vp.k).toBeCloseTo(1.8, 6)
  })

  it('boundsOf：空数组不炸，单点退化为零尺寸', () => {
    expect(boundsOf([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
    expect(boundsOf([{ x: 3, y: 4 }])).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 })
  })
})
