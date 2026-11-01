# ai-site-capture — AI 网页对话的流式捕获与还原（透明开源）

这是 **OrbiGet Craft** 中「网页 AI 端点」层的通用部分：当用户在 ChatGPT /
DeepSeek / 豆包 / Gemini 的网页上对话时，扩展如何把这些站点的**流式响应**
完整还原成结构化对话。与生产代码 `packages/web-chat/src/` 同源。

## 这是什么 / 不是什么

**是**：一个解析器与捕获层。站点页面自己发出的网络响应、页面里已经渲染出来
的对话，被解析成统一的帧序列（增量 / 全量替换 / 身份三元组 / 用量），供本地
会话记录使用。它是「你正在使用的对话页面上发生了什么」的**透明化**——
数据只流向扩展本地，README 与代码里没有任何上传路径。

**不是**：自动操控工具。本目录不含向站点伪装、自动发送、绕过登录的部分
（那些留在私有仓）。解析器只消费「本来就会到达这个页面」的响应流。

## 目录结构

| 文件/目录 | 内容 |
|------|------|
| `types.ts` | 统一帧契约（`WebChatFrame`）、站点规格（`WebEndpointSpec`）、桥帧形状 |
| `chatgpt-frames.ts` 等 4 个 | 各站点流式协议解析：SSE / JSON-Patch / 自有流格式 → 统一帧 |
| `plain-frames.ts` | 朴素整段流的解析器 |
| `capture/` | 桥核（ISOLATED↔MAIN world 通信）、增量去重、DOM 兜底、媒体状态、页面台账 |
| `sites/` | 各站点声明：选择器、帧解析器接线、附件投递能力 |
| `content-script/` | 每站点的桥/钩入口（注入捕获层，只读） |
| `page-capture.ts` | 旁路聚合：把流归属到会话轮次（按请求体指纹） |
| `history-pull.ts` | 拉站点历史做对账（`(conversationId, messageId, role)` 三元组比对） |
| `gen-image-scan.ts` | 生成图 CDN 地址的扫描（只记「疑似地址」做含图证据） |
| `__tests__/` | 16 个测试文件、179 个用例 |

## 核心抽象

**统一帧**（`WebChatFrame`）：四个站点的流格式各不相同（ChatGPT 的
JSON-Patch、DeepSeek 的自有 SSE、豆包/Gemini 的各自私有形态），解析器把
它们全部归一为一种帧序列：

```
content(增量) / thinking(增量) / reset(全量替换) / ident(轮次身份) / done(用量) / error
```

两个关键设计：

- **reset 帧**：站点会把已发过的文本整段重写（markdown 归一化、换段），
  增量切分对不上前缀——消费方必须覆盖而不是追加，否则正文句中碎片重复。
- **身份三元组**：`(conversationId, messageId, role)` 定「哪一轮的哪一条」，
  历史对账从「内容指纹判重」退化为**一行比对**。

## 运行测试

```bash
npm install && npm test   # vitest，179 个用例
```

## 与生产代码的差异

仅三类：① 绑定驱动器的部分不在本目录（`web-tab-driver` 及各站点薄壳，
它们负责把解析结果接进会话管线）；② `capture/delta.ts` 内联了两个生产
符号（附件轮次占位文本）；③ `types.ts` 内联了 `BridgeFrame` 与
`extractBodyIdent`（原在生产 driver 里）。判据与实现逐字一致。

## 审计要点

1. **无上传**：搜索 `fetch(` / `XMLHttpRequest`，本目录零命中。捕获结果
   只经由扩展消息通道回传扩展自身。
2. **只读注入**：`content-script/` 的钩子只**监听**页面自己的响应
   （`Response.prototype` 与 fetch 事件的旁路），不改写请求、不触发发送、
   不碰页面状态。
3. **触发时机**：只在用户主动在该站点对话时被动收到流；没有后台轮询。

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
