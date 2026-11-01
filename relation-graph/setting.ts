/**
 * 项目级 Setting（设定）— 跨场景共享的文本资产模型。
 *
 * 纪律：
 * - Setting 容器是逻辑索引，不是 .obit 下的第二份数据库；
 * - SettingDocument 的正文是用户可读文本，结构只是解析投影；
 * - 场景差异由 SettingProfile 解释，不在这里复制一份场景模型；
 * - 关系由 Relation 单独保存，设定文本不内嵌资产 id。
 */

export type SettingBlockKind =
  | 'title'
  | 'heading'
  | 'field'
  | 'list'
  | 'paragraph'

export type SettingBlockConfidence =
  | 'explicit'
  | 'rule'
  | 'suggested'
  | 'unknown'

export interface SettingBlock {
  /** 由块内容指纹生成的稳定 id；重复内容追加序号 */
  id: string
  kind: SettingBlockKind
  /** 块在原始文本中的内容（不含换行） */
  text: string
  /** field 块的标签 / heading 块的标题 */
  label?: string
  /** field 块的值；其它块缺省 */
  value?: string
  /** 原文本中的字符区间 [start, end) */
  start: number
  end: number
  /** 引文与上下文：给锚点重定位用，不把行号当身份 */
  quote: string
  prefix: string
  suffix: string
  /** 规则判断的把握程度；用户显式操作为 explicit */
  confidence: SettingBlockConfidence
}

export interface SettingField {
  key: string
  value: string
  /** 对应的解析块 id，便于界面回指文本 */
  blockId?: string
}

export interface SettingProjection {
  /** 设定标题；通常来自资产标题或显式一级标题 */
  title: string
  aliases: string[]
  fields: SettingField[]
  notes: string
  blocks: SettingBlock[]
}

export interface SettingDocument {
  /** 对应工作区 Asset 的稳定 id */
  assetId: string
  projectId: string
  /** 资产标题；不是正文的隐式来源 */
  title: string
  /** 一级分类（空 = 未分类） */
  category?: string
  /** 二级分类（空 = 只挂一级）；与 category 分开存，显示时拼路径 */
  subcategory?: string
  /** 原始终稿，设定的唯一内容真相 */
  text: string
  /**
   * 最后修改时间（ISO）。
   *
   * ⚠️ **与索引里的 `addedAt` 不是一回事**：那个是「什么时候进来的」，
   * 这个是「什么时候最后被改的」。长篇作者要判断「这张卡是不是该更新了」
   * 靠的是后者。
   *
   * 来源 = 资产的工作区元数据（`asset.workspaceMeta.lastModified`），
   * **不是**从正文算出来的 —— 正文没变但标题改了，也是「改过」。
   */
  updatedAt?: string
}

/** 设定文档 + 解析投影；场景 Profile 只依赖这个核心形状。 */
export interface SettingDocumentProjection {
  document: SettingDocument
  projection: SettingProjection
}

/** 场景分析用的实体投影：名字 / 别名 / 字段 / 备注，不是新的存储模型。 */
export interface SettingEntity {
  id: string
  sourceAssetId: string
  name: string
  aliases: string[]
  categoryId: string
  categoryName: string
  fields: SettingField[]
  notes: string
  updatedAt?: string
}

export interface SettingPreset {
  id: string
  label: string
  /** 新建设定时复制到文档里的文本骨架 */
  text: string
  category?: string
}

/** 设定引用的语义角色；具体模型适配由 Profile / adapter 决定。 */
export type SettingBindingRole =
  | 'identity'
  | 'face-front'
  | 'face-side'
  | 'appearance'
  | 'outfit'
  | 'scene'
  | 'style'
  | 'composition'
  | 'motion'
  | 'voice'
  | 'constraint'
  | 'reference'
  | 'custom'

export interface SettingBinding {
  /** 文本块 id，不是行号 */
  blockId: string
  role: SettingBindingRole | `custom:${string}`
  label?: string
  /** 目标资产 id；关系本身仍由 Relation 保存 */
  targetAssetId: string
}

/**
 * 设定登记视图 —— **协议层的最小形状**。
 *
 * 宿主那份 `SettingDocumentView` 满足它（多带 `asset` / `text` 两个字段）。
 * 场景的投影器只吃这个形状 ⇒ 场景不需要知道宿主的存储怎么组织。
 */
export interface SettingRecordView {
  /** 设定文档（身份 / 标题 / 分类 / 正文 / 最后修改时间） */
  document: SettingDocument
  /** 解析投影（字段 / 块 / 别名） */
  projection: SettingProjection
}

/**
 * 场景对项目级设定的**声明** —— 只有声明，没有逻辑。
 *
 * ## 为什么只有声明
 *
 * 「场景怎么用设定」其实是**四件独立的事**（见 spec §1.7），它们各有各的家：
 * · **取什么**（kinds + scope 过滤）→ 协议层纯函数，规则一致
 * · **拿到什么形状** → 场景自己的 `project()`
 * · **在哪找到**（正文命中 / 显式引用 / 主动检索）→ 协议层给原语，场景组装
 * · **改了怎么办**（实时 / 冻结快照）→ **引用方**的事，不是场景偏好
 *
 * ⇒ Profile 只回答「**宿主该给我什么**」：给不给完整编辑器、要不要投影到
 * 当前工作面、设定是否进生成配方。
 *
 * ## 投影的形状是场景的自由
 *
 * 小说台要**实体**（拿「名字/别名」当词典键才能扫正文命中）；
 * 漫画台要**摘要**（配方只要一段能进 prompt 的稳定特征）；
 * AI 要**实体 + 原文片段**。⇒ `T` 由场景定，协议层不强加「产出实体」。
 *
 * ✅ **第一个实现**：小说台 `scenes/write-novel/src/setting/novel-setting-profile.ts`
 *    的 `novelSettingProfile`（`SettingProfile<SettingEntity>`）。
 */
export interface SettingProfile<T> {
  id: string
  label: string
  /** 本场景关心的 kind（预设 id）；缺省 = 全部 */
  kinds?: string[]
  /** 这个场景提供完整编辑器吗（宿主据此决定给通用面板还是场景自建壳） */
  editor: boolean
  /** 把设定投影到当前工作面吗 */
  projection: boolean
  /** 设定消费生成配方吗 */
  generationRecipe: boolean
  /**
   * 把登记记录投影成本场景自己的形状。
   *
   * ⚠️ **`T` 是元素类型，不是数组类型** —— 返回的是 `T[]`。
   * 一条登记记录对一条实体，是 1:1；投影器不合并、不折叠。
   */
  project(records: SettingRecordView[]): T[]
}

// ─── 内置起点预设（SETTING_PRESETS）──────────────────────────────
//
// ⚠️ **纯数据 ⇒ 属于契约层**（2026-10-21 写小说台拆分时搬进来）。
//
// 判据：它是**不可变的目录数据**（角色 / 组织 / 地点 / 世界观 / 道具 / 事件 /
// 风格 / 伏笔八类起手骨架），不碰宿主任何能力 ⇒
// · 2+ 消费者（宿主 `useProjectSettings` / `useSettingCreate` / `SettingSurface`
//   + 写小说台的 `novel-setting-profile`）⇒ 不是某一方的实现；
// · **模块顶层就要用**（`new Map(SETTING_PRESETS.map(...))`）⇒ 不能走能力注入
//   （`getHost()` 在模块求值期还没注入 ⇒ 顶层调会抛）。
//
// ⇒ 真身在协议包，宿主 `src/core/setting/setting-presets.ts` 留同名垫片
// ⇒ **全仓 import 路径一行都不用改**，而实现只有一份。

/** 项目级 Setting 的内置起点；只在创建时复制文本，不是继承或固定 Schema。 */
export const SETTING_PRESETS: SettingPreset[] = [
  {
    id: 'setting:character',
    label: '角色',
    text: '## 身份\n\n## 外貌\n\n## 性格\n\n## 面部参考\n',
  },
  {
    id: 'setting:organization',
    label: '组织',
    text: '## 性质\n\n## 据点\n\n## 规矩\n',
  },
  {
    id: 'setting:location',
    label: '地点',
    text: '## 位置\n\n## 特征\n\n## 氛围\n',
  },
  {
    id: 'setting:world',
    label: '世界观',
    text: '## 规则\n\n## 历史\n\n## 术语\n',
  },
  {
    id: 'setting:prop',
    label: '道具',
    text: '## 外观\n\n## 来历\n\n## 用途\n',
  },
  {
    id: 'setting:event',
    label: '事件',
    text: '## 时间\n\n## 地点\n\n## 起因\n\n## 结果\n',
  },
  {
    id: 'setting:style',
    label: '风格',
    text: '## 核心气质\n\n## 视觉语言\n\n## 禁止项\n',
  },
  {
    // 伏笔：单独一个分类。起手骨架给「埋/收/待收束」三格，但都只是示例 ——
    // 用户想记什么就写什么，系统只从正文划词绑定里读「埋在第几章哪一段」。
    id: 'setting:foreshadow',
    label: '伏笔',
    text: '## 这是什么\n\n## 埋在哪儿\n\n## 预定什么时候收\n\n- [ ] 待收束\n',
  },
]

/** 按 id 取内置起点预设 */
export function findSettingPreset(id: string): SettingPreset | undefined {
  return SETTING_PRESETS.find(preset => preset.id === id)
}
