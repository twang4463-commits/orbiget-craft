# paragraph-split — 超长段落的句读切分（可复用组件）

来自 **OrbiGet Craft** 编辑器层：把几万字的巨型段落按句读切成正常段落。
纯函数、零依赖，ProseMirror / 纯文本 / Markdown 场景都能用。

## 解决什么问题

用户从别处粘贴一段扩写到几万字的文本时，编辑器往往不会崩（实测 20 万字单
段击键仅 1.74ms），但**结构被打坏了**：落盘 markdown 只有一行；任何按空行
分块的功能（版本对比、diff、段落导航）退化成 1 个块，改一个字整块标红。

一个段落不该是几万字。本组件在句读边界**只插入 `\n\n`**，不增删不改任何
字符。

## 三条硬纪律

1. **不增删不改任何字符** —— 只在句读边界插入 `\n\n`。切分前后去掉分隔符，
   与原文逐字相同（测试锁死这条不变量）。
2. **只在句末标点后断** —— 不切开一个句子。找不到句末才硬切（无标点长串
   如 URL 的兜底）。
3. **命中不了就不动** —— 没有超长段落的文本零改动。

中文排版禁则也处理了：句末标点后的收尾引号/括号（`”』）】` 等）被吃进上一
段，下一段不以闭合符开头。

## 目录结构

| 文件 | 内容 |
|------|------|
| `paragraph-split.ts` | 纯函数内核：算切点 / 切单段 / 按 markdown 空行分段逐段处理 |

## 用法

```ts
import { splitParagraphText, splitOversizedParagraphs } from './paragraph-split'

// 单段：48654 字 → 按句读切成若干 ≤2000 字的段
const parts = splitParagraphText(hugeText)          // 默认上限 2000 字
parts.join('') === hugeText                          // 恒成立：字符守恒

// markdown：只处理超长段，空行结构原样保持
const fixed = splitOversizedParagraphs(markdownText)
```

`DEFAULT_MAX_PARAGRAPH_CHARS = 2000`：远高于人写的段落（常见 100~400 字），
远低于任何会破坏结构的体量。上限可以传参覆盖。

## 运行示例

```bash
npx tsx demo.ts
```

## 来源

OrbiGet Craft 在 2026-10 的一次用户实证中发现：48,654 字的单段粘贴没有拖垮
编辑器，却让落盘文件变成一行、版本对比整个报废。这个内核是那之后的修结构
方案，服务小说/长文写作场景。

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
