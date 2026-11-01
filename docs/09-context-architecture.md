> 本文来自 **OrbiGet Craft** 内部设计文档，原文公开、未做改写。写作于 2026-06；随产品演进，个别细节可能已与现状有出入；文中部分内部文档链接在公开仓不可用。

# OrbiGet Craft AI 工作台上下文架构规范

日期：2026-06-29

## 1. 背景

OrbiGet Craft 当前已经具备 AI 接入底座，包括多协议模型配置、提示词模板、AI 站点识别与采集字段记忆。但现阶段 AI 主要表现为“模型调用器 + Prompt 模板执行器”，尚未真正理解 OrbiGet Craft 的工作台对象、项目状态与用户操作流程。

后续 AI 能力的目标不是增加一个泛用聊天框，而是让 AI 成为“懂当前工作台的助手”：能够解释产品、理解项目、整理资产、辅助编辑、复盘过程，并且在涉及本地文件和日志时遵守明确的操作边界。

## 2. 第一版 AI 介入点

第一版只定义 4 个 AI 介入点，避免能力过散。

### 2.1 工作台说明助手

定位：懂系统。

职责：

- 解释当前工作台如何使用。
- 解释项目、资产、结构节点、追踪节点、快照、日志等概念。
- 根据当前项目状态建议下一步操作。
- 替代大部分传统引导模块，但不替代关键空状态和危险操作确认。

边界：

- 不直接修改本地文件。
- 不声称已执行操作。
- 不编造当前系统不存在的功能。

### 2.2 资产整理助手

定位：懂素材。

职责：

- 总结选中资产。
- 建议资产标签、分组、结构节点归属。
- 提醒用户对正在编辑或即将大改的关键资产创建快照。
- 从一批素材中提炼主题、引用注意点和下一步整理建议。

边界：

- 不把参考资料改写成确定事实。
- 不擅自移动、删除、覆盖资产。
- 不直接创建快照，只提出待确认操作。

### 2.3 创作编辑助手

定位：懂文本。

职责：

- 段落分析。
- 清晰重写。
- 风格润色。
- 扩写、压缩、标题建议、提炼大纲。

现状：

- 当前 `DEFAULT_AI_PROMPT_TEMPLATES` 已经覆盖大部分编辑类模板。

边界：

- 不改变作者立场。
- 不添加未经上下文提供的事实。
- 不替用户完成不可追溯的大规模改写。

### 2.4 项目复盘助手

定位：懂过程。

职责：

- 基于项目日志、追踪节点、资产状态、快照记录总结项目状态。
- 输出最近推进、卡点、风险和下一步建议。
- 发布或交付前生成阶段复盘。

边界：

- 只基于可见项目数据分析。
- 不伪造日志、快照或历史操作。
- 不做复杂归因，不夸大趋势判断。

## 3. 总体架构

AI 架构分为 5 层：

```text
AI Settings
  模型配置、协议、Prompt 模板。当前已有。

AI Context Builder
  组装产品说明、场景说明、项目状态、用户选择上下文。

AI Skill / Intent
  定义 AI 介入点：说明、资产整理、编辑、复盘。

AI Runner
  调用现有 runAIChat，将上下文、用户问题、技能提示词发送给模型。

AI Result / Proposed Action
  返回建议、草稿或待确认动作。涉及文件修改、快照、删除时不得直接执行。
```

标准调用链：

```text
用户问题
  -> 判断 AIIntent
  -> 构建 AIContextBundle
  -> 选择 Skill Prompt
  -> 调用 runAIChat
  -> 输出建议 / 草稿 / 待确认操作
  -> 用户确认后再执行真实动作
```

## 4. 建议目录结构

```text
src/shared/ai/
  manuals/
    product-manual.ts
    scene-manuals.ts

  context/
    build-ai-context.ts
    build-project-manifest.ts
    summarize-assets.ts
    summarize-logs.ts
    summarize-structure.ts
    summarize-snapshots.ts

  skills/
    workspace-guide.ts
    asset-organizer.ts
    editor-assistant.ts
    project-review.ts

  actions/
    ai-action-schema.ts
    ai-action-runner.ts

  runner.ts
```

## 5. 核心类型草案

### 5.1 AIIntent

```ts
export type AIIntent =
  | 'workspace-guide'
  | 'asset-organizer'
  | 'editor-assistant'
  | 'project-review'
```

### 5.2 AIContextBundle

```ts
export interface AIContextBundle {
  productManual: ProductManual
  sceneManual: SceneManual
  projectManifest?: ProjectManifest
  selection?: AISelectionContext
}
```

### 5.3 ProjectManifest

```ts
export interface ProjectManifest {
  project: {
    id: string
    name: string
    description: string
    creativeTaskId?: string
    sceneId: string
  }
  structureSummary: string
  assetSummary: string
  trackingSummary: string
  recentLogsSummary: string
  snapshotSummary: string
}
```

### 5.4 AISelectionContext

```ts
export interface AISelectionContext {
  selectedText?: string
  selectedAssetIds?: string[]
  activeStructureNodeId?: string
  activeAssetId?: string
  userInstruction?: string
}
```

## 6. Product Manual

产品级说明书是稳定的、随版本发布的 AI 操作协议。

示例：

```ts
export const PRODUCT_MANUAL = {
  product: 'OrbiGet Craft',
  purpose:
    '本地优先的创作工作台，用于组织项目、资产、结构、日志和关键文件快照。',
  coreObjects: [
    'Project',
    'Asset',
    'StructureNode',
    'TrackingNode',
    'Snapshot',
    'ProjectLog',
  ],
  safetyRules: [
    'AI 不能未经用户确认删除、覆盖或移动本地文件。',
    'AI 不能伪造日志或快照。',
    'AI 不能承诺云备份或自动灾难恢复。',
    'AI 只能基于当前上下文回答，不确定时必须说明。',
    '涉及本地文件写入、快照创建、删除、移动时，必须生成待确认动作。',
  ],
}
```

## 7. Scene Manual

场景说明书与 `sceneId` 绑定，用于告诉 AI 当前工作台的能力边界。

示例：

```ts
export const SCENE_MANUALS = {
  'text-editor': {
    title: '文档管理工作台',
    purpose: '管理文档、资料、归档结构和创作过程。',
    primaryWorkflows: [
      '创建项目结构',
      '导入和整理资产',
      '记录推进日志',
      '创建关键资产快照',
    ],
    recommendedAIHelp: [
      '解释当前项目状态',
      '建议资产归类方式',
      '提醒关键资产创建快照',
      '根据日志给下一步建议',
    ],
  },
}
```

## 8. Project Manifest

项目级上下文清单是 AI 真正“懂当前项目”的关键。

原则：

- 不给 AI 全量项目数据，优先给摘要。
- 资产只传文件名、类型、来源、标签、最近修改、关联结构、是否已有快照等元信息。
- 日志只传最近关键日志和摘要。
- 快照只传快照时间、资产数量、备注、快照位置摘要。

示例：

```ts
export async function buildProjectManifest(projectId: string): Promise<ProjectManifest> {
  const project = await getProject(projectId)
  const assets = await getProjectAssets(projectId)
  const structure = await getStructureNodes(projectId)
  const logs = await getRecentLogs(projectId)
  const snapshots = await getSnapshots(projectId)

  return {
    project: pickProjectInfo(project),
    structureSummary: summarizeStructure(structure),
    assetSummary: summarizeAssets(assets),
    trackingSummary: summarizeTracking(project.milestones),
    recentLogsSummary: summarizeLogs(logs),
    snapshotSummary: summarizeSnapshots(snapshots),
  }
}
```

## 9. Skill Prompt

每个 AI 介入点都应有独立 skill prompt，避免一个全能助手承担所有职责。

### 9.1 工作台说明助手

```ts
export const WORKSPACE_GUIDE_SKILL = {
  intent: 'workspace-guide',
  system: `
你是 OrbiGet Craft 的工作台说明助手。
你的任务是帮助用户理解当前项目和工作台操作。
不要编造不存在的功能。
涉及删除、覆盖、移动、快照创建时，只能提出操作建议，不能声称已完成。
`,
}
```

### 9.2 资产整理助手

```ts
export const ASSET_ORGANIZER_SKILL = {
  intent: 'asset-organizer',
  system: `
你是 OrbiGet Craft 的资产整理助手。
你要基于资产摘要，建议如何归类、标记、关联到结构节点。
不要改写资产原文，不要把参考资料当作确定事实。
涉及快照、移动、删除、覆盖时，只能返回待确认建议。
`,
}
```

### 9.3 创作编辑助手

```ts
export const EDITOR_ASSISTANT_SKILL = {
  intent: 'editor-assistant',
  system: `
你是 OrbiGet Craft 的创作编辑助手。
你可以分析、润色、重写、扩写、压缩用户选中的文本。
必须保留作者原意，不添加未经上下文提供的事实。
`,
}
```

### 9.4 项目复盘助手

```ts
export const PROJECT_REVIEW_SKILL = {
  intent: 'project-review',
  system: `
你是 OrbiGet Craft 的项目复盘助手。
你只能基于项目清单、日志、追踪节点、资产摘要和快照摘要分析。
输出应具体、克制、可执行，不夸大趋势，不编造历史。
`,
}
```

## 10. Runner 草案

```ts
export async function runWorkbenchAI(input: {
  intent: AIIntent
  projectId?: string
  userMessage: string
  selection?: AISelectionContext
}) {
  const settings = await loadAISettings()
  const context = await buildAIContext(input)
  const skill = getAISkill(input.intent)

  return runAIChat(settings, {
    messages: [
      { role: 'system', content: skill.system },
      { role: 'system', content: renderContextBundle(context) },
      { role: 'user', content: input.userMessage },
    ],
  })
}
```

## 11. Proposed Action

AI 不应直接执行高风险操作，而应返回待确认动作。

第一版动作草案：

```ts
export type AIProposedAction =
  | {
      type: 'create_snapshot'
      assetIds: string[]
      reason: string
    }
  | {
      type: 'assign_asset_to_node'
      assetId: string
      nodeId: string
      reason: string
    }
  | {
      type: 'create_log'
      message: string
      reason: string
    }
```

第一版可以只展示 proposed action，不实际执行。第二版再做“确认执行”。

## 12. 与现有 AI 模块的关系

当前已有：

- `src/shared/ai-settings.ts`
  - AI 协议配置。
  - AI 连接参数。
  - AI Prompt 模板。
  - AI 站点识别。
  - 自定义字段记忆。

- `src/shared/ai-client.ts`
  - `runAIChat()`。
  - 多协议 provider 调用。
  - Prompt 模板渲染。
  - 错误类型与超时控制。

本规范新增的是：

- AI 对 OrbiGet Craft 产品和项目状态的理解层。
- AI 介入点的职责边界。
- AI 上下文构建机制。
- AI 待确认动作机制。

## 13. 第一版落地顺序

建议按以下顺序实现：

1. 新增 `PRODUCT_MANUAL`。
2. 新增 `SCENE_MANUALS`，先只覆盖 `text-editor`。
3. 实现 `buildProjectManifest(projectId)`。
4. 实现 `renderContextBundle()`。
5. 实现 `workspace-guide` 入口。
6. 接入 `asset-organizer`。
7. 接入 `project-review`。
8. 最后再将现有编辑类 prompt 归入 `editor-assistant`。

## 14. 第一版目标体验

用户在工作台询问：

```text
我现在这个项目该怎么整理？
```

AI 应能回答：

```text
你当前项目是文档管理工作台，有 12 个资产，结构为“文档 / 资料 / 归档”。
建议先把 7 个参考资料放入“资料”节点，把 3 个正在编辑的文档放入“文档”节点。
其中 xxx.md 最近修改频繁，建议在继续大改前创建资产快照。
```

这个体验证明：AI 不是外部聊天框，而是理解当前工作台的协作层。

## 15. 设计结论

OrbiGet Craft 第一版 AI 不应追求“大而全自动化”，而应成为创作闭环中的解释器和协作者。

核心价值：

- AI 懂系统。
- AI 懂项目。
- AI 懂资产。
- AI 懂过程。
- AI 不越权执行高风险操作。

**工程约束（与产品壳一致）**：Agent / tools / 动态视图也必须高内聚、低耦合、组合复用——工具与面板能力只实现一份，再被 Scene / 菜单挂载；禁止为每种对话入口或每种 Scene 复制整套 Agent UI 与业务逻辑。详见 `CLAUDE.md` 编码约定与 [拔除 Body Layout DSL](./implementation/remove-layout-dsl-2026-07-18.md)。

这套设计可以支撑第一版产品闭环：

```text
创建项目 -> 导入资产 -> 组织结构 -> 记录过程 -> 创建快照 -> AI 解释与复盘
```

