/**
 * 锚点 — 关联的端点。
 *
 * 关联不写入正文标记（不使用 [[...]] 之类的内联语法），而是外置为
 * Anchor：指向整篇资产或其内部片段，靠「引文 + 位置 + 内容哈希」定位。
 *
 * - quote 是身份：选区原文本身，内容漂移后按引文全文搜索重定位
 * - 位置是缓存：命中时 O(1) 跳转；重定位成功后写回修正，下次又走快速路径
 * - contentHash 是指纹：快速路径的相等性检查（不可逆，不能用来搜索）
 */

/**
 * 文本片段锚点。
 *
 * 坐标系 = 编辑器文档位置（ProseMirror `state.selection.from/to`），
 * **不是**纯字符偏移：它计入节点边界，跨段落时与字符数不等。
 * 因此 start/end 只对同一编辑器可解析，跨实现复用需先换算。
 */
export interface TextRange {
  /** 起始文档位置（含） */
  start: number
  /** 结束文档位置（不含） */
  end: number
  /** 该片段内容指纹（SHA-256 hex），用于快速路径命中与悬空判定 */
  contentHash: string
  /**
   * 选区原文（引文，W3C TextQuoteSelector 思路）：位置漂移后按引文
   * 在全文搜索重定位。存量锚点可能缺省 —— 缺省时退回「位置 + contentHash」
   * 的旧悬空判定，不做搜索。
   */
  quote?: string
  /** 选区前文上下文（≤ ANCHOR_CONTEXT_CHARS 字符）：重复引文的多命中消歧 */
  prefix?: string
  /** 选区后文上下文（≤ ANCHOR_CONTEXT_CHARS 字符） */
  suffix?: string
}

/** 图片框选锚点（二期）：原图坐标系像素矩形 + 图片身份哈希 */
export interface ImageBox {
  x: number
  y: number
  w: number
  h: number
  contentHash: string
}

/** 视频片段锚点（二期）：毫秒区间 + 身份哈希 */
export interface VideoRange {
  startMs: number
  endMs: number
  contentHash: string
}

/**
 * 漫画画格锚点（image-story 场景私有对象）。
 *
 * 为什么需要它：画格不是 Asset（它是 `scene:image-story` 里的一条记录），
 * 但「本格引用了哪张设定」「这张图是哪一格的产物」必须能被关系表达。
 * 硬塞成 asset 锚点就得拿画格序号或宿主文档冒充端点，两种都在说谎。
 *
 * 端点的身份是 **storyId + panelId**（都是稳定 id）；assetId 只是「该格当前
 * 采用的图」，空槽画格没有图，关系照样成立。序号（order）永远不参与身份。
 */
export interface PanelAnchor {
  kind: 'panel'
  /** 画格所属故事线 id */
  storyId: string
  /** 画格 id（稳定；不是 order） */
  panelId: string
  /**
   * 该格当前采用的图资产 id；**空串 = 还没出图**（不用 undefined，是为了让
   * `anchor.assetId` 在四种端点上是同一个类型，取资产的代码不必到处判空）。
   */
  assetId: string
}

/**
 * 锚点端点：一个关联 from→to，from/to 均为 Anchor。
 *
 * 一期只落 asset / text；image / video 结构预留，不在一期 UI 暴露。
 */
export type Anchor =
  | { kind: 'asset'; assetId: string }
  | { kind: 'text'; assetId: string; range: TextRange }
  | { kind: 'image'; assetId: string; box: ImageBox }
  | { kind: 'video'; assetId: string; range: VideoRange }
  | PanelAnchor

/**
 * 取出锚点指向的资产 id（无论何种粒度）。
 * 画格锚点在空槽 / 未出图时返回**空串** —— 调用方按「这条关系不挂在某个图上」理解，
 * 不要拿空串去查资产（画格关系一律按 `kind === 'panel'` 过滤）。
 */
export function anchorAssetId(anchor: Anchor): string {
  return anchor.assetId
}

/** 从旧的资产 id 构造一篇级锚点 */
export function assetAnchor(assetId: string): Anchor {
  return { kind: 'asset', assetId }
}

/**
 * 构造画格锚点；`assetId` 传该格当前采用的图，没有就传空（空槽画格照样能建边）。
 *
 * ⚠️ 画格是**漫画台专属**对象，但这个构造函数留在公共域 ——
 * 因为 `PanelAnchor` 类型进了 `Anchor` 联合（关系/画布那边也要用），
 * 构造函数跟着类型放一起，比「类型在宿主、函数在场景」好维护。
 * 漫画台子项目通过**能力注入**（`host.common.panelAnchor`）拿它，不直接 import。
 */
export function panelAnchor(storyId: string, panelId: string, assetId = ''): PanelAnchor {
  return { kind: 'panel', storyId, panelId, assetId }
}
