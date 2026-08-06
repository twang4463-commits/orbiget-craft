# capture — 网页采集层（透明开源）

这是 **OrbiGet Craft** 扩展中「网页采集」的通用部分抽离，与生产代码
`src/content-script/capture/` 同源，仅做两处调整：

1. 去掉对扩展内部模块的依赖（JSON-LD 解析、文件名安全检查等改为文件内自带）
2. 不包含站点特化适配与内部流程策略（见下文「不在本目录」）

## 为什么要开源这一部分

OrbiGet Craft 的承诺是「采集只在你主动操作时读取当前页面，全部保存到本地」。
这一层就是验证承诺的地方：

- **只读当前页面**：`metadata.ts` / `page-extractor.ts` 全部操作来自
  `document` 查询与 `document.cloneNode()`，不监听、不后台采集
- **无网络请求**：整个目录没有一个 `fetch` / `XMLHttpRequest`
- **只保留创作相关字段**：`buildMetadataSnapshot` 明确丢弃 SEO、社交分享、
  CMS 内部字段——「采集原则」文档（`docs/03-collection-principles.md`）的代码落地

## 目录结构

| 文件 | 内容 |
|------|------|
| `metadata.ts` | DOM 元数据采集：JSON-LD / OpenGraph / meta / citation 标签提取 |
| `page-extractor.ts` | Readability.js 正文提取封装（依赖 `@mozilla/readability`） |
| `text-sanitize.ts` | 文本清理：实体解码、换行统一、零宽字符移除 |
| `capture-title.ts` | 标题兜底规则（按采集类型生成短名，可当文件名） |

## 审计要点

1. **数据流向**：搜索 `fetch(` / `XMLHttpRequest`，整个目录零命中。
   采集结果只返回给调用方（扩展本地存储），无任何上传路径。
2. **触发时机**：本目录的模块全部由用户主动操作触发（点击采集按钮、
   选中文本、粘贴内容），没有定时器、没有自动巡检页面。
3. **最小收集**：元数据只取创作相关字段（作者、时间、版权、来源），
   不收集社交分享统计、SEO 关键词、CMS 内部字段。

## 不在本目录

- 站点特化适配（特定平台的 DOM 适配、AI 绘画平台粘贴识别）
- 图片哈希 / 去重（SHA-256、phash）与图片 enrich 管线
- 采集流程编排、队列与重试策略
- 扩展内部存储落账逻辑

本目录聚焦「采集时读取什么、如何清理」；上述内容属于扩展内部实现，本目录不包含。

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
