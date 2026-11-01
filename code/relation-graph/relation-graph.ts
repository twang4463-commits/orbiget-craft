/**
 * graph-model — 关系图的**图模型**（纯函数，无 Vue / 无 DOM）
 *
 * 输入全项目关系 + 当前文稿 id，输出"以本文为中心、展开 N 跳"的节点与连线。
 *
 * ── 为什么是整份关系而不是一跳边 ──────────────────────────────────
 * 只拿本文的出一跳/入一跳，画出来必然是**星形**：所有邻居都只连中心，
 * 邻居之间本来是朋友也看不出来。Obsidian 那种网图的关键恰恰是
 * 「邻居之间也有边」——所以要整份读，再在客户端切邻域（见 GET_PROJECT_RELATIONS）。
 *
 * ── 约定 ──────────────────────────────────────────────────────────
 * - 节点 = 资产（assetId），同一个资产多条关系只画一个点，靠连线上的 count 表达条数；
 * - 连线的 source/target 是**关系的真实方向**（from → to），不做无向化 ——
 *   本项目的 Relation 有方向语义（引用/衍生/迭代），抹掉就丢了信息；
 * - 另外给一条相对**当前文稿**的 `dir`（out 本稿发起 / in 指向本稿 / far 与本文无直接关系），
 *   只用于上色，不改变线本身的方向；
 * - `audio_binding` 不进图：它是音频场景的文本↔音频绑定，属于音频工位，不是文稿之间的关系
 *   （与右侧关系面板的口径一致）。
 */
import type { Relation, RelationType } from './relation'
import { relationFromAssetId, relationToAssetId } from './relation'

/** 节点相对当前文稿的方向语义（'far' = 二跳以后的邻居，方向无意义） */
export type GraphNodeDir = 'center' | 'out' | 'in' | 'both' | 'far'

export interface GraphNode {
  id: string
  /** 距当前文稿几跳（0 = 当前文稿本身） */
  hop: number
  dir: GraphNodeDir
  /** 图上的度数：连着几个**不同**的邻居（决定点的大小） */
  degree: number
  /** 涉及的关系条数（聚合后的真实条数，悬浮时说明"3 条"） */
  relationCount: number
}

export interface GraphLink {
  /** 稳定 id：`source→target|type`（平行关系已聚合） */
  id: string
  /** 关系的真实方向 */
  source: string
  target: string
  type: RelationType
  /** 相对当前文稿的方向（上色用）：out / in / far */
  dir: 'out' | 'in' | 'far'
  /** 聚合掉的关系条数 */
  count: number
}

export interface RelationGraphModel {
  nodes: GraphNode[]
  links: GraphLink[]
  /** 本稿出边/入边的关系条数（图例计数，与右侧面板同口径） */
  outCount: number
  inCount: number
  /** 撞到节点上限被裁掉了节点 */
  truncated: boolean
}

export interface BuildGraphInput {
  relations: Relation[]
  centerId: string
  /** 展开几跳（默认 2：一跳只有星形，二跳才看得出网） */
  depth?: number
  /** 节点上限（超了按"跳数小、度数大"保留，其余裁掉） */
  maxNodes?: number
}

const DEFAULT_DEPTH = 2
const DEFAULT_MAX_NODES = 140

/** 邻接（无向，用于 BFS；方向语义在连线上单独表达） */
function neighborsOf(relations: Relation[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    const set = adj.get(a)
    if (set) set.add(b)
    else adj.set(a, new Set([b]))
  }
  for (const rel of relations) {
    const from = relationFromAssetId(rel)
    const to = relationToAssetId(rel)
    if (!from || !to || from === to) continue
    link(from, to)
    link(to, from)
  }
  return adj
}

/**
 * 建图。输出顺序**确定**（节点按 跳数 → 度数降序 → id；连线按 id），
 * 这样同一份数据每次画出来都是同一张图 —— 力导向的初值也才可复现。
 */
export function buildRelationGraph(input: BuildGraphInput): RelationGraphModel {
  const depth = Math.max(1, input.depth ?? DEFAULT_DEPTH)
  const maxNodes = Math.max(2, input.maxNodes ?? DEFAULT_MAX_NODES)
  const centerId = input.centerId

  // 音频绑定不进文章关系图（与右侧面板口径一致）
  const relations = input.relations.filter(r => r && r.type !== 'audio_binding')
  const outCount = relations.filter(r => relationFromAssetId(r) === centerId).length
  const inCount = relations.filter(r => relationToAssetId(r) === centerId).length

  // ── BFS：切出 N 跳邻域 ──
  const hop = new Map<string, number>([[centerId, 0]])
  const adj = neighborsOf(relations)
  let frontier = [centerId]
  for (let d = 1; d <= depth && frontier.length; d += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (hop.has(nb)) continue
        hop.set(nb, d)
        next.push(nb)
      }
    }
    frontier = next
  }

  // ── 连线：两端都在邻域内的关系，平行关系聚合成一条 ──
  const linkMap = new Map<string, GraphLink>()
  for (const rel of relations) {
    const source = relationFromAssetId(rel)
    const target = relationToAssetId(rel)
    if (!hop.has(source) || !hop.has(target)) continue
    const key = `${source}→${target}|${rel.type}`
    const dir: GraphLink['dir'] = source === centerId ? 'out' : target === centerId ? 'in' : 'far'
    const hit = linkMap.get(key)
    if (hit) hit.count += 1
    else linkMap.set(key, { id: key, source, target, type: rel.type, dir, count: 1 })
  }

  // ── 度数（连线数，不自环计两次）与关系条数 ──
  const degree = new Map<string, number>()
  const relationCount = new Map<string, number>()
  for (const link of linkMap.values()) {
    if (link.source !== link.target) {
      degree.set(link.source, (degree.get(link.source) ?? 0) + 1)
      degree.set(link.target, (degree.get(link.target) ?? 0) + 1)
    }
    relationCount.set(link.source, (relationCount.get(link.source) ?? 0) + link.count)
    relationCount.set(link.target, (relationCount.get(link.target) ?? 0) + link.count)
  }

  const dirOf = (id: string): GraphNodeDir => {
    const h = hop.get(id) ?? 0
    if (h === 0) return 'center'
    if (h > 1) return 'far'
    const isOut = relations.some(r => relationFromAssetId(r) === centerId && relationToAssetId(r) === id)
    const isIn = relations.some(r => relationToAssetId(r) === centerId && relationFromAssetId(r) === id)
    if (isOut && isIn) return 'both'
    return isOut ? 'out' : 'in'
  }

  let nodes: GraphNode[] = [...hop.entries()].map(([id, h]) => ({
    id,
    hop: h,
    dir: dirOf(id),
    degree: degree.get(id) ?? 0,
    relationCount: relationCount.get(id) ?? 0,
  }))

  // 裁到上限：保留跳数小、度数大的（中心永远留）
  let truncated = false
  if (nodes.length > maxNodes) {
    truncated = true
    nodes = nodes
      .sort((a, b) => a.hop - b.hop || b.degree - a.degree || (a.id < b.id ? -1 : 1))
      .slice(0, maxNodes)
    const kept = new Set(nodes.map(n => n.id))
    for (const [key, link] of linkMap) {
      if (!kept.has(link.source) || !kept.has(link.target)) linkMap.delete(key)
    }
  }

  nodes.sort((a, b) => a.hop - b.hop || b.degree - a.degree || (a.id < b.id ? -1 : 1))
  const links = [...linkMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return { nodes, links, outCount, inCount, truncated }
}
