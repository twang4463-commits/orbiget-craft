# ai-client — AI 连接层（透明开源）

这是 **OrbiGet Craft** 扩展中「AI 连接」的通用协议层抽离，与生产代码
`src/ai/client/` 同源，仅去掉对扩展内部模块（设置持久化、消息总线等）的依赖。

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
| `types.ts` | 公共类型：连接配置、请求/响应、错误类 |
| `http.ts` | HTTP 层：URL 拼接、请求头、超时/中断合并、SSE/NDJSON 流式骨架 |
| `protocol-openai.ts` | OpenAI 兼容协议适配器（OpenAI / DeepSeek / 混元 / vLLM 等） |
| `protocol-ollama.ts` | Ollama 协议适配器（本地模型） |
| `model-list.ts` | 查询服务商 `/models` 列表 |
| `message-utils.ts` | `<think>` 推理标签剥离 |
| `tool-format.ts` | function calling 工具调用解析 |
| `demo.ts` | 最小使用示例 |

## 审计要点

1. **数据流向**：搜索 `fetch(` 只有两处来源——`http.ts` 的 `postJson` / `streamFetchLines`，
   两者都只请求调用方传入的 `url`。调用方（协议适配器）的 url 由 `joinUrl(settings.baseUrl, …)`
   拼出，而 `baseUrl` 是用户在设置里填的。
2. **无遥测**：整个协议层没有上报、埋点、统计回传。`usage` 字段仅返回给调用方展示。
3. **超时语义**：非流式是总时长闸门，流式是空闲闸门（持续有数据不超时），
   外部 `AbortSignal`（用户点「停止」）与内部超时合并为同一 controller。

## 许可

本目录代码源自 OrbiGet Craft 主项目（[AFL v3.0](./LICENSE)）。
