# relation-graph — Obsidian 式关系图的纯函数内核（可复用组件）

来自 **OrbiGet Craft** 的文稿关系视图：把「资产 + 显式关系」渲染成 Obsidian
那种网图所需的三层纯函数——邻域建图、力导向布局、画布视口。零 Vue、零
DOM、零 `Math.random`（种子随机），同输入必出同布局。

## 目录结构

| 文件 | 内容 |
|------|------|
| `anchor.ts` | 锚点：关联的端点（整篇资产 / 文本片段 / 图片框选 / 视频区间），「引文 + 位置 + 内容哈希」定位（W3C TextQuoteSelector 思路） |
| `setting.ts` | 设定文本的块模型与预设（关系端点的一种语义来源） |
| `relation.ts` | 关系模型：带方向的显式链接（引用/衍生/迭代/拼接/相关），含旧字段兼容迁移 |
| `relation-graph.ts` | 建图：整份关系切 N 跳邻域、平行关系聚合、方向语义、节点上限裁剪 |
| `relation-graph-layout.ts` | 力导向：种子可复现（mulberry32）、弹簧+斥力+向心、NaN 数值兜底 |
| `viewport.ts` | 视口：光标锚定缩放（`zoomAt` 判据 = 光标下的世界点不动）、铺满居中 |
| `__tests__/relation-graph.test.ts` | 23 个用例：邻域切分、聚合、确定性、弹簧真的拉近、屏幕空间点距下限 |

## 为什么是「整份关系」而不是一跳边

只拿本文的一跳出入边，画出来必然是星形。Obsidian 网图的关键是**邻居之间
也有边**——所以建图函数接收整份关系，在客户端按 `depth` 切邻域（默认 2
跳），一跳节点之间的既有关系照样画出来（上灰，`dir: 'far'`）。

## 力导向的三处实测标定

第一版三条全错（40 个点挤成一坨、最小屏幕点距 5px、加了边的两点反而更远）。
现在的标定写在 `simulate()` 的注释里：

1. **弹簧走位置式修正**（d3 同款）——速度式会欠阻尼来回过冲；
2. **斥力/向心走速度式，且 gravity ∝ 1/k**——否则自然铺展距离不随节点密度变化；
3. **限速 `k * 0.12`**——防偶发大力把点甩穿。

参数按节点数自标定（`k = √(画布面积 / 点数)`），5 个点和 100 个点长出
同一个密度，不用逐规模调参。

## 用法

```ts
import { buildRelationGraph } from './relation-graph'
import { initialLayout, layoutGraph } from './relation-graph-layout'
import { fitViewport, zoomAt } from './viewport'

const model = buildRelationGraph({ relations, centerId, depth: 2 })
const nodes = initialLayout(model.nodes.map(n => n.id), { seed: 7 })
layoutGraph(nodes, model.links.map(l => ({ source: l.source, target: l.target, weight: l.count })), { seed: 7 })
const viewport = fitViewport(bounds, canvasWidth, canvasHeight)
```

## 运行测试

```bash
npm install && npm test   # vitest，23 个用例
```

## 说明

`relation.ts` / `setting.ts` / `anchor.ts` 带着产品的领域语义（音频绑定、
伏笔角色、设定绑定等字段）。如果你只需要图算法，取
`relation-graph.ts` + `relation-graph-layout.ts` + `viewport.ts` 三个文件
即可——它们只依赖最朴素的 `{source, target}` 链接形状。

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
