> 本文来自 **OrbiGet Craft** 内部设计文档，原文公开、未做改写。随产品演进，个别细节可能已与现状有出入；文中部分内部文档链接在公开仓不可用。

# OrbiGet Craft 目录架构与 AI Agent 演进规范

## 一、目的

这份文档回答三个长期问题：

1. 当前 `orbiget-craft` 的目录各自承担什么职责；
2. 后续新增能力时，代码应该按什么原则进入哪个目录；
3. 当项目引入 AI 能力时，如何从“模型调用”演进到“任务型 agent 系统”。

它不是实现细节说明，而是目录与演进约束文档。

---

## 二、当前目录职责

### 1. 根目录

```text
orbiget-craft/
├─ public/
├─ scripts/
├─ src/
├─ dist/
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
└─ vitest.config.ts
```

- `public/`
  静态资源目录。包括扩展 `manifest.json`、图标、以及后续可直接复制到构建产物中的静态文件。

- `scripts/`
  自定义构建脚本目录。当前生产构建由这里控制，而不是单纯依赖 `vite.config.ts`。

- `src/`
  全部源码目录。

- `dist/`
  构建输出目录，用于浏览器扩展加载和发布。

- `package.json`
  依赖、脚本、构建入口定义。

- `vite.config.ts`
  Vite 配置，主要服务多页面入口和开发阶段。

- `vitest.config.ts`
  Vitest 配置。

### 2. `src/` 目录

> **注意（2026-07-01）：以下 `editor/`、`project-editor/`、`standalone/`、`views/` 四个目录当前在 `src/` 中不存在，属于早期演进设想。当前实际目录见 `OrbiGet-Craft-src目录结构与职责-2026-06-23.md`。

```text
src/
├─ adapters/
├─ commercial/        （license/ + tier/）
├─ content-script/
├─ core/
├─ editor/
├─ features/          （archive/ + export/ + delivery/ + gen-studio/ + review/）
├─ options/
├─ popup/
├─ project-editor/
├─ service-worker/
├─ shared/
├─ standalone/
├─ views/
└─ workbench/
```

- `adapters/`
  基础设施适配层。负责把业务逻辑与具体存储实现、浏览器能力接入隔开。当前主要承载存储端口与 IndexedDB 实现。

- `features/archive/`
  项目归档、恢复、备份一类的生命周期管理能力。

- `content-script/`
  注入到网页中的前端层。负责网页采集、页面侧边栏、网页内悬浮或面板交互、站点适配器。

- `core/`
  核心领域与底层能力。这里应放领域模型、纯逻辑、策略、加密、日志链式哈希、元数据、许可证验证 WASM bridge 等跨页面共享的核心逻辑。

- `editor/`
  独立编辑器页面入口与其专属 UI。

- `features/export/`
  偏底层的导出能力，如 markdown、pdf、backup 等格式处理。

- `options/`
  扩展设置页面入口。

- `popup/`
  扩展弹窗页面本身。原则上只放 popup 专属 UI 与装配逻辑，不继续承接跨页面公共状态。

- `project-editor/`
  项目编辑页面入口。

- `service-worker/`
  扩展后台层。负责消息编排、后台任务、上下文菜单、数据写入、导出触发、周期任务。

- `shared/`
  跨页面公共层。包括公共组件、公共 composables、公共 store、i18n、tokens、messaging、session、storage。

- `standalone/`
  独立页面壳。用于把某个业务视图单独作为一个页面运行。

- `commercial/tier/`
  版本层级、能力门控、限制策略。

- `views/`
  页面级业务视图。它们本质上是多个页面入口复用的视图层，不等同于具体入口。

- `workbench/`
  工作台页面入口。

---

## 三、目录分层原则

OrbiGet Craft 不应只按“技术类型”分目录，也不应只按“功能名字”分目录。

正确做法是两层同时成立：

```text
运行时入口边界 + 功能模块边界
```

### 1. 运行时入口边界

以下目录天然属于不同运行时：

- `popup/`
- `content-script/`
- `service-worker/`
- `options/`
- `editor/`
- `project-editor/`
- `workbench/`
- `standalone/`

这些目录必须保留，因为它们决定代码运行在什么上下文中、能访问哪些浏览器 API。

### 2. 功能模块边界

以下能力应逐步按业务能力收敛：

- `projects`
- `assets`
- `capture`
- `archive`
- `tier`
- `output`
- `ai`

也就是说：

- 入口目录负责装配；
- 功能模块负责业务；
- 公共层负责复用；
- 核心层负责领域和纯逻辑。

一句话：

**入口目录负责“在哪跑”，功能目录负责“干什么”。**

---

## 四、当前已确认的整理方向

### 1. `popup` 只保留页面专属逻辑

过去 `popup/` 中曾承载公共 `composables` 和 `stores`，这会让 popup 目录逐步变成事实上的全局公共层。

现在的推荐方向是：

- 跨页面复用的 `composables` 迁入 `shared/composables/`
- 跨页面复用的 `stores` 迁入 `shared/stores/`
- `popup/` 目录只保留 popup 页面专属的组件和入口装配

### 2. `service-worker/index.ts` 只保留后台入口职责

`service-worker/index.ts` 不应继续累积为一个巨型业务文件。

它的职责应收敛为：

- 扩展生命周期监听；
- 上下文菜单注册；
- 后台初始化；
- handler map 装配。

具体消息处理应逐步迁入：

```text
service-worker/
├─ index.ts
├─ router.ts
├─ runtime.ts
└─ handlers/
   ├─ system.ts
   ├─ projects.ts
   ├─ assets.ts
   ├─ capture.ts
   ├─ navigation.ts
   └─ ...
```

当前已完成的方向就是这条路。

---

## 五、AI 能力层的定位

未来引入 AI 时，不应把它理解为“聊天框调用模型”。

对 OrbiGet Craft 来说，AI 更适合被定义为：

```text
任务型能力层 / Agent Runtime
```

原因是它天然会涉及：

- 单文档任务；
- 批量文件夹任务；
- 模板套用；
- 项目上下文读取；
- 队列调度；
- 用量统计；
- 多模型切换；
- 后台执行与结果写回。

这些都已经超出了“单次聊天请求”的范围。

---

## 六、AI 目录建议

建议未来新增：

```text
src/ai/
├─ domain/
├─ providers/
├─ registry/
├─ tasks/
├─ queue/
├─ usage/
├─ templates/
├─ prompts/
├─ tools/
└─ index.ts
```

各目录职责如下：

- `domain/`
  AI 任务定义、模型配置、密钥结构、用量结构、模板结构。

- `providers/`
  模型接入层。对接 OpenAI、Claude、Qwen、DeepSeek 或本地模型。

- `registry/`
  多密钥保存、模型列表、当前激活模型、当前激活 provider。

- `tasks/`
  单文档任务、批量任务、模板任务等任务定义与执行编排。

- `queue/`
  AI 任务队列、状态机、重试、取消、并发控制。

- `usage/`
  模型用量记录、聚合统计、简易费用基础。

- `templates/`
  面向中文创作与办公场景的模板库。

- `prompts/`
  prompt 模板，不与 UI 混写。

- `tools/`
  agent 工具层。未来可读取项目、素材、日志、导出、上下文。

---

## 七、AI 三阶段演进路线

### 1. 基础版

目标：

- 多密钥保存
- 一键切换模型
- 单文档 AI 任务

要求：

- 密钥不能只保存 `apiKey`，还要保存 `provider`、`label`、`baseUrl`、`enabled`
- 模型切换操作应切换“激活配置”，而不是页面里临时写死
- 单文档任务必须走统一 task 协议，不直接散落在页面调用

### 2. 进阶版

目标：

- 批量文件夹 AI 任务
- 简易用量统计
- AI 任务队列

要求：

- 批量任务必须通过队列层执行，不能直接在页面循环请求模型
- 用量统计优先读取 provider 返回的 usage，不自行拍脑袋估算
- 队列应放在 `service-worker` 统一编排

### 3. 长期版

目标：

- AI 模板库
- 一键套用写作范式
- 强化中文创作/办公效率优势

适合的模板方向：

- 公文
- 周报/月报
- 会议纪要
- 方案对比
- 项目复盘
- 立项说明
- 汇报材料

这里的模板不是 prompt 文本收藏夹，而应是：

```text
模板定义 = 范式 + 输入槽位 + 输出结构 + 约束规则
```

---

## 八、为什么这已经接近 Agent 系统

未来的 AI 子系统并不是单纯聊天，而是具备以下 agent 特征：

- 有任务目标，而不是只做自由问答；
- 有状态，如任务状态、模型状态、用量状态；
- 有工具调用，如读项目、读素材、读日志、导出结果；
- 有调度与编排，如后台队列、并发控制、失败重试；
- 有策略层，如模型选择、预算限制、模板套用规则。

因此，推荐的理解方式是：

```text
对外命名可以叫 AI；
内部设计按 task + tools + queue + policy 的 agent runtime 去做。
```

---

## 九、推荐的实现边界

未来 AI 引入时，建议按以下边界接入：

### 页面层

- `popup/`
- `workbench/`
- `editor/`
- `standalone/`

这些页面只发起 AI 任务，不直接调用模型。

### 后台编排层

- `service-worker/handlers/ai.ts`

它负责：

- 接收前端 AI 请求；
- 选择 provider；
- 管理队列；
- 记录用量；
- 读写项目数据；
- 返回任务结果。

### AI 子系统

- `src/ai/`

它负责：

- provider 抽象；
- task 抽象；
- queue 抽象；
- usage 抽象；
- template 抽象。

---

## 十、后续实施顺序建议

推荐顺序如下：

1. 固化目录职责，不再让新公共逻辑回流到 `popup/`
2. 继续拆薄 `service-worker/index.ts`
3. 新建 `src/ai/` 骨架
4. 新增 `service-worker/handlers/ai.ts`
5. 先落地一个最小 AI 能力：单文档总结
6. 再补多密钥、多模型切换
7. 再补 usage
8. 再补 queue
9. 最后做模板库

这样可以确保未来的 AI 层从一开始就是可扩展体系，而不是聊天功能的堆叠。

---

## 十一、核心结论

OrbiGet Craft 的目录组织原则应固定为：

```text
运行时入口边界 + 功能模块边界 + 公共层复用 + 核心层纯逻辑
```

而未来 AI 的正确定位应固定为：

```text
任务型 AI 能力层 / Agent Runtime
```

不是“给某个页面加一个聊天框”，而是“给整个创作系统增加一个可编排、可复用、可统计、可扩展的智能执行层”。
