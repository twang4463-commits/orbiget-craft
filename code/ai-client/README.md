# ai-client — AI 连接层（透明开源）

这是 **OrbiGet Craft** 中「AI 连接」的通用协议层抽离，与生产代码
`packages/ai/src/client/` 同源，仅去掉对扩展内部模块（设置持久化、消息总线、
厂商预设表）的依赖。

## 为什么要开源这一部分

OrbiGet Craft 的核心定位是**本地优先、数据主权在你**。用户最需要验证的，恰恰是
「我的内容到底发给了谁」——而这条链路全在 AI 连接层里：

- **请求只发往用户自己配置的 `baseUrl`**（`http.ts` 的 `joinUrl` + `postJson`）
- **没有服务端**：扩展不持有任何自己的后端，代码里没有「上传到 OrbiGet 服务器」的路径
- **协议适配器**（`protocol-openai.ts` / `protocol-ollama.ts`）展示了对各家服务商的
  调用方式，你可以逐行核对请求体里有什么

我们把这一层开源，是为了让「数据只发给用户选择的 AI 服务商」这件事**可审计**，
而不是一句口号。

## 目录结构

| 文件 | 内容 |
|------|------|
| `types.ts` | 公共类型：连接配置、请求/响应、错误类、服务端搜索判定 |
| `http.ts` | HTTP 层：URL 拼接与归一化、请求头、超时/中断合并、SSE/NDJSON 流式骨架 |
| `protocol-openai.ts` | OpenAI 兼容协议适配器（OpenAI / DeepSeek / 混元 / vLLM 等） |
| `protocol-ollama.ts` | Ollama 协议适配器（本地模型） |
| `model-list.ts` | 查询服务商 `/models` 列表 |
| `message-utils.ts` | `<think>` 推理标签剥离（含流式跨块过滤） |
| `tool-format.ts` | function calling 工具调用解析 |
| `dsml.ts` | DSML 内嵌工具调用解析（不支持原生 tools 的模型在正文里写调用标记） |
| `demo.ts` | 最小使用示例 |

## 与生产代码的同步说明

本目录与生产代码保持同一份实现，仅两类差异：

1. **import 来源**：生产的 `ai-settings` / `client-types` / `ai-adapters` / `protocol/dsml`
   在此合并为 `types.ts` 与 `dsml.ts`；
2. **厂商预设表**：生产版内置 16 家服务商的完整预设（能力/容量/调优缺省），属于产品侧
   配置，本目录只保留「服务端搜索判定」需要的最小信息（`AI_PROTOCOL_PRESETS` 一条
   qwen 示例 + DashScope 端点兜底检测）。

除此之外逻辑逐字一致，含生产上踩坑后的修复：

- **tool 回填轮**：`AIChatMessage` 支持 `role: 'tool'` 与 `tool_calls` 重放，序列化时转
  OpenAI 线格式（function calling 第二轮的必要转换）；
- **DSML 工具调用**：部分 DeepSeek 系模型/网关不支持原生 tools 参数，模型把调用以
  `<|DSML||…>` 标记写在正文里，`dsml.ts` 负责解析并剥块；
- **端点归一化**：用户常把文档里的完整生成端点粘进 `baseUrl`，`normalizeAIBaseUrl`
  剥已知 API 尾巴防止双重路径，`defaultEndpointUrl` 支持「整条地址」模式；
- **think 标签跨块过滤**：流式响应里 `<think>` 标签可能被 chunk 切开，逐行
  `stripThinkTags` 会漏掉闭合对把思维链推进正文，`createThinkTagStreamFilter` 处理跨块；
- **空响应诊断**：思考模型把输出预算耗在 thinking 上时，错误信息带出原始响应，
  避免误判为「空响应」。

## 审计要点

1. **数据流向**：搜索 `fetch(` 共 5 处——`http.ts` 的 `postJson` / `getJson` /
   `streamFetchLines`、`protocol-openai.ts` 的流式请求、`model-list.ts` 的模型列表。
   每一处都只请求调用方传入的 `url`，而 url 由 `joinUrl(settings.baseUrl, …)` 拼出，
   `baseUrl` 是用户在设置里填的。
2. **无遥测**：整个协议层没有上报、埋点、统计回传。`usage` 字段仅返回给调用方展示。
3. **超时语义**：非流式是总时长闸门，流式是空闲闸门（持续有数据不超时），
   外部 `AbortSignal`（用户点「停止」）与内部超时合并为同一 controller。

## 运行示例

```bash
npm i -g tsx
tsx demo.ts   # 先把 demo.ts 里的 baseUrl / apiKey / model 换成你自己的
```

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
