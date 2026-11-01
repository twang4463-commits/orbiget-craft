/**
 * 关系 — 资产之间的显式链接
 *
 * 支持双链：从任意锚点查询出边（我引用了谁）和入边（谁引用了我）。
 * 知识链接允许成网，不做 DAG 环检测。
 *
 * 端点是 Anchor（见 ./anchor）：可指向整篇资产或其内部片段（文本/图片/视频）。
 * 正文保持纯净，不在内容里嵌入 [[...]] 之类的标记。
 */
import type { Anchor } from './anchor'
import { anchorAssetId, assetAnchor } from './anchor'
import type { SettingBinding } from './setting'

/** 关系类型 — 面向用户语言 */
export type RelationType =
  | 'references'    // 引用（A 引用了 B）
  | 'derivative'    // 衍生（A 是从 B 衍生的）
  | 'iteration'     // 迭代（A 是 B 的新版本，由版本系统自动创建）
  | 'synthesis'     // 拼接（A 由 B+C 合成）
  | 'related'       // 相关（A 和 B 有关联）
  /** 文本锚点 → 音频资产：录音 / AI 配音 / 已有音频绑定 */
  | 'audio_binding'

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  references: '引用',
  derivative: '衍生',
  iteration: '迭代',
  synthesis: '拼接',
  related: '相关',
  audio_binding: '音频绑定',
}

/** 试听时打的问题点（自审清单：相对该版音频起点秒数）；归属这条录音，换版即随旧版消失 */
export interface AudioBindingMark {
  /** 相对该版音频起点的秒数 */
  at: number
  /** 可选备注（如「吞字」）；缺省 = 一般问题点 */
  note?: string
}

export interface AudioBindingMeta {
  /** 同一文本锚点下的候选音频组；多次录制/生成可比较，只有一个 active */
  groupId: string
  /** 当前采用的候选。全篇连播只消费 active=true 的绑定 */
  active: boolean
  /** 生成/录音完成时记录的真实时长（秒）；缺失时播放层读 metadata 补齐 */
  duration?: number
  /** AI 配音参数；真人录音 / 已绑定文件可缺省 */
  voice?: string
  speed?: number
  /** 自审问题点（试听时打的标记）；只属于这一版录音 */
  marks?: AudioBindingMark[]
  /**
   * 画本角色（旁白 / 角色名）：有声书多角色与 AI 配音选音色的依据。
   * 缺省按旁白处理；打在绑定上（每版自带），交付可按角色筛。
   */
  role?: string
}

/**
 * 正文片段 → 项目对象的引用，在剧情里扮演什么（面向用户的有限词表）。
 *
 * 与 RelationType 的分工（别混）：
 * - type 说「这是什么关系」—— 引用 / 衍生 / 迭代…（资产血缘，**定死**，不可自定义）
 * - bindingRole 说「它在剧情里扮演什么」—— 埋在正文里 / 回收 / 只是提到
 *
 * 为什么不是新 RelationType：把「引用」分裂成 plant/payoff 两个近义类型，
 * 选择器就更难选（同一毛病）。角色是**可选标注**，缺省按「提到」理解。
 */
export type BindingRole = 'plant' | 'payoff' | 'mention'

export const BINDING_ROLE_LABELS: Record<BindingRole, string> = {
  plant: '埋',
  payoff: '收',
  mention: '提到',
}

export interface Relation {
  id: string
  /** 所属项目 */
  projectId: string
  /** 来源端点（上游） */
  from: Anchor
  /** 目标端点（下游） */
  to: Anchor
  /** 关系类型 */
  type: RelationType
  /** 用户备注 */
  note: string
  /** 关系创建来源 */
  source: 'user_manual' | 'editor_insert' | 'version_chain' | 'ai_suggest' | 'audio_recording' | 'audio_generation' | 'audio_bound'
  /** audio_binding 专有元数据；其他关系不写 */
  audioBinding?: AudioBindingMeta
  /** Setting 文本块 → 参考资产的语义角色；不塞进 note，正文保持纯净 */
  settingBinding?: SettingBinding
  /**
   * 正文片段 → 项目对象（伏笔/设定/素材）这条引用在剧情里扮演的角色；缺省不写。
   * 只对 `references` 有意义；其它 type 不写（别拿它当第二个 type 用）。
   */
  bindingRole?: BindingRole
  /** 创建时间 (ms) */
  createdAt: number

  /**
   * @deprecated 使用 from/to。保留给存量数据兼容读取；新代码不要写。
   * 读取时若缺省，由 from/to 派生。
   */
  fromAssetId?: string
  /** @deprecated 使用 from/to */
  toAssetId?: string
}

/** 取来源资产 id（兼容旧字段） */
export function relationFromAssetId(r: Relation): string {
  return r.fromAssetId || anchorAssetId(r.from)
}

/** 取目标资产 id（兼容旧字段） */
export function relationToAssetId(r: Relation): string {
  return r.toAssetId || anchorAssetId(r.to)
}

/**
 * 把可能来自存量 JSON 的 relation 规范化（**读路径**专用）：
 * - 若只有 fromAssetId/toAssetId，升格为 asset 锚点；
 * - 补齐 fromAssetId/toAssetId 派生字段，保证旧代码路径可读（仅内存态，不落盘）；
 * - 两端都缺（无 from/to 也无旧字段）→ 返回 null，由调用方降级跳过，
 *   不再让单条脏数据把整个项目的 loadRelations 拖垮。
 *
 * 写路径请用 stripDeprecatedRelation：读时补、写时剥，迁移才收敛。
 */
export function normalizeRelation(raw: Partial<Relation> & { id: string; projectId: string }): Relation | null {
  const from = raw.from ?? (raw.fromAssetId ? assetAnchor(raw.fromAssetId) : undefined)
  const to = raw.to ?? (raw.toAssetId ? assetAnchor(raw.toAssetId) : undefined)

  // 双缺：既无锚点也无旧字段，无法定位任何端点 → 降级丢弃
  if (!from || !to) return null

  const relation = {
    ...raw,
    from,
    to,
    source: raw.source || 'user_manual',
    note: raw.note || '',
    type: raw.type || 'related',
    createdAt: raw.createdAt || Date.now(),
  } as Relation
  // bindingRole 只认词表内的值；不认识（脏数据 / 旧版本遗留）就直接丢掉 ——
  // 半份语义比没有更坏：它会被伏笔账当成作者显式的标记
  if (typeof relation.bindingRole !== 'string' || !(relation.bindingRole in BINDING_ROLE_LABELS)) {
    delete relation.bindingRole
  }

  // 派生字段强制从锚点算（锚点是真相源）：新旧字段都有的脏数据里，
  // 旧字段值被覆盖为锚点值，保证两条数据源一致，迁移才收敛。
  relation.fromAssetId = anchorAssetId(from)
  relation.toAssetId = anchorAssetId(to)
  return relation
}

/**
 * 落盘前剥离 deprecated 字段（**写路径**专用）。
 *
 * normalizeRelation 读时会在内存里补齐 fromAssetId/toAssetId，若直接持久化，
 * 新数据也永久带着废弃字段，迁移永不收敛。写前剥离，磁盘上只留 from/to。
 */
export function stripDeprecatedRelation(r: Relation): Relation {
  const { fromAssetId: _fromAssetId, toAssetId: _toAssetId, ...rest } = r
  return rest as Relation
}
