> 本文来自 **OrbiGet Craft** 内部设计文档，原文公开、未做改写。写作于 2026-08；随产品演进，个别细节可能已与现状有出入；文中部分内部文档链接在公开仓不可用。

# OrbiGet Craft 核心领域模型职责边界

> 版本：2026-08-10
> 定位：本文档按**职责分组**讲清 `src/core/domain/` 下全部 24 个文件的领域模型，回答"每个模型管什么、彼此怎么分工、linkedAssetIds 与 Relation 的区别"。不重复《统一数据模型与多视图说明》的宏观视角，也不重复《内容创作通用域模型规范》的三层架构。
> 事实来源：`src/core/domain/` 全部文件。

---

## 一、全景总览

`src/core/domain/` 共 24 个文件，可归为 **8 组职责**：

| 组 | 文件 | 核心问题 |
|---|---|---|
| 内容载体 | `asset.ts` | 这一条内容是什么 |
| 创作组织 | `structure-node.ts` | 这个创作单元怎么组织、聚合谁 |
| 内容关系 | `relation.ts` + `anchor.ts` | 资产之间是什么关系、精确到哪 |
| 项目语境 | `project.ts` + `project-config.ts` + `project-log.ts` + `presence-event.ts` + `chain.ts` | 项目边界、配置、事实流、事件、哈希链 |
| 版本与交付 | `revision.ts` + `asset-version.ts` + `delivery-manifest.ts` + `delivery-feedback.ts` | 版本、快照、交付、反馈 |
| 配套领域 | `template.ts` + `todo.ts` + `creative-task.ts` + `copyright-attention.ts` + `world.ts` | 模板、待办、创作任务、版权体检、世界引擎 |
| 辅助记录 | `ai-request-log.ts` | AI 请求与用量审计 |
| AI 过程与场景结构 | `agent-trace-log.ts` + `project-memory.ts` + `snapshot.ts` + `image-text-note.ts` | AI 跑了什么、记住了什么、文稿打过哪些版本点、场景专属结构长什么样 |

> `index.ts` 是聚合导出，不是领域模型。

---

## 二、内容载体组

### Asset —— 内容载体

`Asset` 是最小内容单元，管"这一条内容是什么"。

```ts:1:1:src/core/domain/asset.ts
export type AssetType = 'note' | 'image' | 'video' | 'audio' | 'bookmark'
```

关键字段语义：

- `id`：身份（不是路径，路径只是查找入口）
- `type`：基元类型（note/image/video/audio/bookmark）
- `contentFormat`：内容子类型（markdown / article / code 等）
- `originKind`：来源维度（"它怎么来的"：采集/导入/创作/生成/衍生）
- `role`：身份维度（"用户现在把它当什么"：参考/素材/过程物/产物/模板/归档）
- `referencedAssetIds`：创作时引用的资产（编辑器 @ 引用；场景导入也会写入源文章 id）
- `workspaceMeta.sourcePath`：指向物理文件的相对路径（**位置**，不是身份）
- `sceneId`（手稿）：**主归属工位**——`write-article` / `short-video` / `write-novel` / `audio` / `image-text`。特化场景默认列表只认本 `sceneId`；跨场景取用走「从文章导入」（复制 + derivative 血缘），**不**改源稿 `sceneId`。素材（image/video/audio/bookmark）无此身份，全项目共用。见[宪法 §四](./OrbiGet-Craft-核心宪法.md)与[场景手稿身份](./implementation/scene-manuscript-identity-2026-09-13.md)。

**职责边界**：Asset 只描述"这一条内容"，不描述"它属于哪个创作单元"，也不描述"它和别的资产是什么关系"。手稿的场景归属是 Asset 上的切片字段，不是 StructureNode 的职责。

---

## 三、创作组织组

### StructureNode —— 内容组织单元

`StructureNode` 管"这个创作单元是什么、聚合了哪些资产"。

```ts:17:34:src/core/domain/structure-node.ts
export interface StructureNode {
  id: string
  projectId: string
  assetId?: string | null
  parentId?: string | null
  kind: StructureNodeKind
  title: string
  ...
  order: number
  linkedAssetIds: string[]
  ...
}
```

- `kind`：创作单元类型（book/part/chapter/section/scene/shot/panel/track/phrase/character/event/collection/custom）
- `parentId` + `order`：树形父子 + 同级排序
- `assetId`：主资产（可选）
- `linkedAssetIds`：本节点聚合的资产 id 集合

`StructureNodeKind` 是跨创作类型的关键——同样的树形结构，靠 kind 区分"章 / 分镜 / 分格 / 轨道"。

目录认领 / 通用文件夹统一 **`collection`**（2026-09-13）：不得用 `section`/`chapter` 伪装业务节点，否则小说章树会倒进资源管理器目录（daily/imgs 等）。

**职责边界**：StructureNode 是"内容视角"，只负责组织资产，**不负责关系语义**。它下面的 `linkedAssetIds` 只是"挂了哪些资产"的**无类型归属列表**——没有方向、没有关系类型、没有粒度。

---

## 四、内容关系组

### Relation —— 资产间的语义关系

`Relation` 管"资产之间是什么关系"。

```ts:29:44:src/core/domain/relation.ts
export interface Relation {
  id: string
  projectId: string
  from: Anchor
  to: Anchor
  type: RelationType
  note: string
  source: 'user_manual' | 'editor_insert' | 'version_chain' | 'ai_suggest'
  createdAt: number
}
```

`RelationType`：

```ts:14:20:src/core/domain/relation.ts
export type RelationType =
  | 'references'    // 引用（A 引用了 B）
  | 'derivative'    // 衍生（A 是从 B 衍生的）
  | 'iteration'     // 迭代（A 是 B 的新版本，由版本系统自动创建）
  | 'synthesis'     // 拼接（A 由 B+C 合成）
  | 'related'       // 相关（A 和 B 有关联）
```

**职责边界**：Relation 是"资产到资产"的显式语义边，**带类型、带方向（from→to）**，可带备注。它不参与结构树的父子组织。

### Anchor —— 关系的端点

`Relation.from` / `Relation.to` 都是 `Anchor`。Anchor 决定一次关系"指向哪"。

```ts:48:52:src/core/domain/anchor.ts
export type Anchor =
  | { kind: 'asset'; assetId: string }
  | { kind: 'text'; assetId: string; range: TextRange }
  | { kind: 'image'; assetId: string; box: ImageBox }
  | { kind: 'video'; assetId: string; range: VideoRange }
```

- `asset`：指向整篇资产
- `text`：指向某资产的文本片段（记 `start/end` + 内容哈希）
- `image`：指向图片的某个框选区域（**结构预留，一期未暴露**）
- `video`：指向视频的某毫秒区间（**结构预留，一期未暴露**）

**职责边界**：Anchor 让关系可以精确到"片段"，而不只是"整篇"。这是 Relation 比"归属列表"更精细的根本原因。

---

## 五、项目语境组

### Project —— 项目边界

`Project` 定义创作任务的语境边界，并绑定本地工作区与组装态。

```ts:83:134:src/core/domain/project.ts
export interface Project {
  id: string
  name: string
  status: ProjectStatus
  ...
  milestones?: ProjectMilestone[]
  sceneId?: ProjectSceneId
  workspaceMode?: ProjectWorkspaceMode
  ...
}
```

- `status`：active / archived / restored（生命周期）
- `milestones`：**内嵌属性，非独立实体**（推进时间轴上的计划锚点）
- `sceneId`：项目**默认场景**（身份字段）——封面 / 列表标签 / 兜底都用它，不受切场景影响
- `activeSceneId`：项目**当前使用中的场景**——工作台装载哪个场景 + AI 上下文看它，缺省才回落到 `sceneId`（`getProjectActiveSceneId`，`project.ts:170-174`）
- `workspaceMode` / `workspaceFolderName`：本地工作区绑定

`ProjectSceneId` 有活跃集（write-article/write-novel/short-video/image-text/audio）和历史别名，经 `resolveProjectSceneId` 归一。

**职责边界**：Project 管"哪些对象属于同一个创作任务"，不负责内容本身。

### ProjectConfig —— 项目配置

```ts:7:14:src/core/domain/project-config.ts
export interface ProjectConfig {
  documentStorageFormat: DocumentStorageFormat  // markdown | html
  exportOutputPreset: ExportOutputPreset          // markdown-folder | pdf | html
  exportCompressZip: boolean
}
```

管存储格式与交付输出预设。

### ProjectLog —— 事实流（项目日志）

`ProjectLog` 是追加式事实记录，每条自带 `prevLogHash` + `logHash` 哈希链。

```ts:30:44:src/core/domain/project-log.ts
export interface ProjectLog {
  id: string
  projectId: string
  logType: LogType
  content: string
  linkedAssetIds: string[]
  metaJson: string
  createdAt: string
  prevLogHash: string
  logHash: string
}
```

**职责边界**：记录"发生过什么"（采集/编辑/交付/归档），是审计与追溯的事实流。它也带 `linkedAssetIds`（本日志关联了哪些资产）。

### PresenceEvent —— 规范化在场事件

`ProjectLog.logType` 的细粒度规范化来源（todo_created / editor_saved / asset_added / milestone_set 等 35 个）。新写入用 PresenceEventId，旧数据归一化映射。

### ChainState —— 哈希链状态

```ts:1:9:src/core/domain/chain.ts
export interface ChainState {
  projectId: string
  drift: number
  ntpSynced: boolean
  salt: string
  lastHash: string
  nodeCount: number
}
```

支撑 ProjectLog 哈希链的链头状态（防篡改完整性证明）。

---

## 六、版本与交付组

### Revision —— 用户版本（手动打点）

```ts:3:16:src/core/domain/revision.ts
export interface Revision {
  id: string
  projectId: string
  assetId: string
  kind: RevisionKind  // manual | auto
  title: string
  ...
  linkedAssetIds?: string[]
  linkedStructureNodeIds?: string[]
}
```

**用户能命名、能恢复、能对比的版本**，才是用户心智里的"版本"。可关联资产与结构节点。

### AssetVersion —— 自动快照

```ts:7:21:src/core/domain/asset-version.ts
export interface AssetVersion {
  id: string
  assetId: string
  fingerprint: string
  size: number
  mtime: number
  changeNote: string
  createdAt: number
}
```

只用于系统兜底恢复与追溯，**不等同于用户版本**。记录"变更前是什么样"，不做 diff、不负责回滚语义。

> Revision 与 AssetVersion 的区别：Revision = 用户主动打点、面向展示；AssetVersion = 系统自动快照、只做兜底。

### Delivery & DeliveryManifest —— 交付

`Delivery`（delivery-feedback.ts）管"围绕一个或多个 Asset 的一次使用行为记录"（留痕/移交/发布/归档/评审/授权），含多平台发布实例 `publishes[]` 与复盘方式。

`DeliveryManifest`（delivery-manifest.ts）管"这次交付的清单结果"——产物、引用资产、证据、统计。

```ts:52:77:src/core/domain/delivery-manifest.ts
export interface DeliveryManifest {
  id: string
  deliveryId: string
  projectId: string
  ...
  assetRefs: DeliveryAssetRef[]
  evidenceRefs: DeliveryEvidenceRef[]
  artifacts: DeliveryArtifact[]
  summary: { assetCount: number; documentCount: number; ... }
}
```

**职责边界**：Delivery 记录"用户怎么用这些资产"，DeliveryManifest 记录"交付包里有什么"。

### DeliveryFeedback —— 交付后反馈

`DeliveryFeedbackSnapshot` 管"发布后的数据反馈"（views/likes/comments/shares 等），按时间序列记录，供复盘看趋势。

---

## 七、配套领域组

### Template —— 项目模板

```ts:21:33:src/core/domain/template.ts
export interface ProjectTemplate {
  id: string
  name: string
  icon: string
  builtIn: boolean
  taskId?: CreativeTaskId
  sceneId?: ProjectSceneId
  milestones: TemplateMilestone[]
  structure?: TemplateStructureNode[]  // 预设逻辑骨架，建项目时一次性实例化
}
```

管"创建项目时的预设"：骨架结构 + 里程碑。实例化后与模板脱钩。

### Todo —— 待办

```ts:4:15:src/core/domain/todo.ts
export interface Todo {
  id: string
  projectId: string
  content: string
  done: boolean
  dueDate: string | null
  tags: string[]
  status?: TodoStatus  // open | done | abandoned
}
```

物化自 ProjectLog 的待办视图。

### CreativeTask —— 创作任务列表

`CreativeTaskId`（writing/novel/short-video/image-text/audio）管创建页一级 tab 分组。

### CopyrightAttention —— 版权/来源体检

`scanProjectAssetsCopyright` 扫描素材，产出"哪些缺版权/来源记录"的提醒报告（提醒型，不判定侵权）。

### World —— 世界引擎

小说创作的设定领域模型（角色/地点/事件卡）：

```ts:16:44:src/core/domain/world.ts
export interface WorldCategory {
  id: string
  name: string
  fieldTemplate: string[]  // 字段模板
  builtIn?: boolean
}
export interface WorldCard {
  id: string
  categoryId: string
  name: string
  aliases: string[]
  fields: WorldFieldEntry[]
  notes: string
  moments?: WorldMoment[]  // 按章随手记
}
```

**职责边界**：分类（类型 + 字段模板）→ 卡（实例）→ 名字/别名全局词典。字段严格一维 KV，不做关系建模。

---

## 八、辅助记录组

### AIRequestLog —— AI 请求与用量

`AIRequestLog` 管每次 AI 调用的审计记录（来源/模型/成功失败/耗时/token/prompt/意图预判偏差），`AIUsageSummary` 管用量汇总。

```ts:5:55:src/core/domain/ai-request-log.ts
export interface AIRequestLog {
  id: string
  createdAt: string
  source: AIRequestSource  // template | chat | test | execute | image | video | audio
  ...
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  agentMeta?: { intent?: string; confidence?: string; contextTier?: string; ... }
}
```

**职责边界**：审计与用量统计，不参与创作业务。

---

## 九、AI 过程与场景结构组

### AgentTraceLog —— Agent 轨迹账本

`AgentTraceRunLog` 是一轮对话（run）的过程账本，append 到 `WorkspaceRoot/.obit/ai/traces/` 按日分片，步骤种类 `AgentTraceStepKind`（env / stale / model_request / model_response / action / intervention / plan / limit / error / cancel）。

与 `AIRequestLog` 的分工：ai-requests 存「外发内容审计」，ai-traces 存「过程排错」（每轮环境/模型/动作/干预的截断详情 + 时序）。

**职责边界**：排错用过程账本，不是产品功能数据。

### ProjectMemory —— 项目级 AI 记忆

`ProjectMemoryEntry`（type: observation / decision / suggestion_accepted / suggestion_rejected / milestone / pattern）让 Agent 知道"上次聊了什么、做了什么决定、哪些建议被采纳了"，落 `IDB 缓存层 → .obit/ai/project-memory.json`。

**职责边界**：记忆只带人可读 `summary` 与 `sourceRefs` 回溯依据，不改写项目事实。

### DocumentSnapshot —— 文稿版本（手动打点，可回滚）

用户在**单篇文稿**上主动打的版本点：保存时深拷贝正文，恢复时整份覆盖这一篇（非 diff/merge）。正文存 `.obit/snapshots/<assetId>/<snapshotId>.json`，元数据走 `Revision`（`.obit/revisions.json`），二者通过 `snapshotId === revision.id` 关联。图片/视频等其它类型的版本走 `AssetVersion`，与本类型互不干扰。

**职责边界**：文稿级而非项目级（2026-08 用户定案）——粒度对得上创作行为，恢复影响面小，版本数能落成文档树徽标。

### ImageTextNote —— 图文笔记（image-text 场景专属结构）

`ImageTextNote` 是「标题 + 正文 + 有序图片 + 话题」四段结构，不复用 `Asset{ type:'note', content: markdown }`：图片内嵌进 markdown 后顺序与封面语义无法表达。图片只存 `assetId` 引用（二进制仍由素材层负责），落盘走 `scene:<sceneId>` 场景私有数据通道。

**职责边界**：场景专属结构，图片二进制不重复存。

---

## 十、核心分工：linkedAssetIds vs Relation

这是最容易混淆的一对。它们**不是同一件事的两种写法，而是两个不同维度**。

| 维度 | `linkedAssetIds` | `Relation` |
|---|---|---|
| 连接对象 | **节点/日志 ↔ 资产** | **资产 ↔ 资产** |
| 是否带关系类型 | 否（只表示"归属"） | 是（引用/衍生/拼接/相关） |
| 是否带方向 | 否 | 是（from → to） |
| 粒度 | 整篇资产 id | 可精确到资产片段（Anchor） |
| 语义 | "这个节点聚合了谁" | "谁和谁是什么关系" |
| 典型来源 | 编辑器存稿、新建文档挂节点、日志关联 | 用户手动、编辑器引用、版本链、AI 建议 |

**一句话**：`linkedAssetIds` 管"**归属**"，`Relation` 管"**关系**"。前者是结构树的装配基础，后者是资产网的语义边。

> 注意：`linkedAssetIds` 绝不是无用字段。它被编辑器存稿、新建文档挂节点、`novel-structure.ts` 资产填充、日志 `linkedAssetIds` 关联等多处实际使用。它只是**不承担关系语义**——那是 Relation 的活。

---

## 十一、漫画合成场景示例（为什么需要两层）

以"一个漫画分镜页 = 1 个剧本 md + 多张分格 png + 1 个分镜元数据 json"为例：

**StructureNode 负责"这一页属于哪一章" + "这一页挂哪些资产"：**

```
分镜页节点 (kind: panel)
├── linkedAssetIds: [剧本.md, 分格图1.png, 分格图2.png, 分镜.json]
```

这解决了"这页聚合了哪些资产"，但**表达不了关系**——它看不出"分格图1 对应剧本第 3 段对白"。

**Relation 负责"资产之间的精确语义"：**

```
分格图1.png  -- references(锚点=text 剧本第3段) --> 剧本.md
分镜.json    -- synthesis --> 剧本.md + 分格图1.png + 分格图2.png
```

这才能表达"这张图画的是这段对白""这几样东西合成这一页"。

**结论**：`StructureNode` 提供骨架和归属，`Relation` 提供关系网。两者缺一不可，漫画这类跨媒体合成场景正是需要两者配合的地方。

---

## 十二、现实约束（诚实标注）

`Anchor` 的 image / video 片段锚点目前是**"结构预留，一期的未在一期 UI 暴露"**：

```ts:45:47:src/core/domain/anchor.ts
 * 一期只落 asset / text；image / video 结构预留，不在一期 UI 暴露。
```

所以现在实际可用的锚点是 `asset`（整篇）和 `text`（文本片段）。漫画要做的"图 ↔ 文精确对应"（png 某区域 ↔ md 某段对白），需要把 `image` 锚点从预留落地为可用，这是**新增工作量**，不是现成能力。

---

## 十三、一句话收口

- `Asset` 管"这一条内容是什么"
- `StructureNode` + `linkedAssetIds` 管"这个创作单元聚合了谁"
- `Relation` + `Anchor` 管"资产之间是什么关系、精确到哪"
- `Project` 管"哪些对象属于同一个创作任务"
- `ProjectLog` + `PresenceEvent` + `Chain` 管"发生过什么、是否可信"
- `Revision` / `AssetVersion` 管"版本"（用户打点 vs 系统快照）
- `Delivery` / `DeliveryManifest` 管"交付"（行为 vs 清单）
- 归属是装配，关系是语义；版本交付是节点，日志是事实流——各司其职，互补不冲突。

> 关联阅读：《OrbiGet-Craft-统一数据模型与多视图说明.md》（宏观对象 + 多视图）、《内容创作通用域模型规范-2026-06-20.md》（三层架构 + 创作类型映射）。