# scan-kit — 前端仓库治理扫描（可复用工具）

来自 **OrbiGet Craft** 开发期的四个治理扫描，全部从真实事故抽象而来：
逐字节复制到三个包里的组件、看着权威其实全被压死的 CSS、自 8 月起就没人
import 的 126 行死模块、两份都在用但慢慢分叉的近重复文件。

四个脚本互不依赖，单文件即可拷走；判据与事故教训都在注释里。

## 脚本

| 脚本 | 抓什么 | 用法 |
|------|--------|------|
| `scan-dead-modules.mjs` | 零入边的 TS 模块（谁都不 import 的"看起来是实现"的死代码） | `node scan-dead-modules.mjs --src=src [--config=vite.config.ts]` |
| `scan-duplicate-files.mjs` | 近重复文件（归一化后 Jaccard 相似度 ≥ 阈值，抓"两份都在用、慢慢分叉"） | `node scan-duplicate-files.mjs [目录...] [阈值] [--show]` |
| `scan-duplicate-blocks.mjs` | 跨文件的重复 CSS 声明块（后代选择器 + 成组选择器都认） | `node scan-duplicate-blocks.mjs --root=src [--values] [--min N]` |
| `scan-duplicate-selectors.mjs` | 同文件内同一选择器被定义多次且**值被压死**（后块整体压前块） | `node scan-duplicate-selectors.mjs [file.css...] [--strict] [--gate]` |

## 为什么这些判据值得抄

**死模块扫描的三条防误报**（`scan-dead-modules.mjs`）：

- 入口清单**从配置读**（HTML `<script src>`、vite `input`），不写死——加了
  新入口就凭空多一个"死模块"的假报告；
- 遍历**不跳过** `__tests__`，排除测试放在目标集——跳了的话「只被测试
  import」那一档永远是空的；
- 路径**一律归一成相对 cwd 的正斜杠**——目标集（相对）与 import 侧
  （绝对）匹配不上时，第一版把整棵树 672/672 全报死。

**选择器扫描的核心区分**：「定义了两次」≠「有东西被压死」。真正要修的是
**同一属性被写了两次**（前一次的值从此是死的）；只补新属性的分散声明无害。
不做这个区分，报告会被组选择器噪声淹掉。`--selftest` 内置五档负向对照
（第一版三条全踩过），`--gate` 可挂构建前置（退出码即结论）。

**近重复文件的归一化**：去注释、去空白、连续标识符压成 token——度量的是
结构不是字面。阈值默认 0.55，<25 行的文件噪声大不比。

## 预期行为

扫描产出是**待人眼过的线索**，不是待办清单：父子组件各自声明同一条规则
常常是有意的；「零入边」不等于「可以删」（可能是留给将来的分支、被字符串
拼出来的路径、或公开 API）。

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
