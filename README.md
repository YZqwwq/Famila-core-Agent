# Famila Agent

## 核心目标

我们要做一个能与用户长期相处的个人助手。HDSI 为她提供一个连续、自洽的世界。她在其中感知用户和环境，形成自己的记忆与情绪，决定何时接话、怎样回应、要做什么。

Famila 要让外界发生的事成为她在这个世界里能经历的事。用户发来一句话，是手机上收到了一条消息。她想知道明天会不会下雨，可以打开天气 App 看预报。她在 PC 上改清单时收到新消息，可以先回一句，再回到仍未保存的草稿。外部服务和工具支撑这些交互，行动的结果会改变她随后能看到什么、能做什么。

## 当前实现

独立运行的 TypeScript Agent Harness，以 Node.js 运行，Fastify 提供服务入口。现在可以选择 HDSI 原生会话引擎，或从 `worldEdit-agent` 提取的 LangGraph 执行引擎。新 `.env.example` 选择 HDSI；没有指定引擎的程序化调用保留 LangGraph 兼容行为。

HDSI 路径运行完整上游会话服务。当前默认 `FAMILA_HDSI_MODE=native`，保留逐轮叙事与状态更新；此前快版会跳过过期叙事附带的情绪更新，未通过行为保真验证，只保留为显式 `fast` 试验模式。角色档案使用最小设定，没有加入之前迁移的人格文案。原 LangGraph 路径保留工具、任务和记忆能力。两套引擎不会同时消费同一消息，数据也各自隔离。见 [行为对照验证](docs/hdsi-behavior-validation.md)与[HDSI 接入说明](docs/hdsi-integration.md)。

当前支持一个宿主实例、一个持久 Agent 身份；HDSI 会话运行在子进程中。CLI 和 HTTP 服务是两种启动方式，不要同时使用同一个数据目录。WorldEdit 原项目保持原样，本轮不设计或接入应用接口契约。

外围情景行动 Harness 已提供：设置 `FAMILA_HDSI_ACTIONS=1`，在 native 模式下启用查询时间、保存/读取/列出个人笔记、天气和公开信息搜索；程序化调用还可注册宿主工具。模型以情景文本动作发起执行，最终完整剧本才回到原生 HDSI，不修改内核。见[情景行动接入](docs/scene-actions.md)与[生活工具测试](docs/living-tools.md)。

## HDSI 对话数据库

HTTP、CLI 和 HDSI 程序入口默认使用远程测试库。开发环境使用 `FAMILA_DB_ENV=test`，正式服务显式设置 `FAMILA_DB_ENV=prod`。两个环境分别读取 `FAMILA_TEST_PG_*` 和 `FAMILA_PROD_PG_*`，共享 `FAMILA_PG_CA_FILE`。启动时客户端验证证书和主机身份，在对应库的 `famila` schema 创建表。每个库同一时间支持一个活动会话服务。

消息队列、回复、HDSI 故事与记忆、笔记和编辑器状态均按库保存。首次接入从该库现有状态开始，旧 SQLite 文件保留在原目录。离线回归与需要全新身份的对照实验显式使用 `isolatedSqlite`。运行 `npm run build` 后，`node scripts/postgres-chat-smoke.cjs` 会用本地模型替身在测试库留下带随机标识的验收对话。

## 启动

使用 HDSI 引擎启动 Fastify 服务后，可打开 [Famila 写作工作台](http://127.0.0.1:4317/workbench)。若修改过服务端口，请使用实际监听地址。工作台沿用上游 HDSI 的六页导航，读取当前实例的数据。在「当前故事」保存人设后，后续叙事使用更新后的设定；首次保存会建立故事。「配置中心」展示当前运行参数。设置了 `FAMILA_API_TOKEN` 时，在浏览器中输入同一个服务令牌。

需要 Node.js >= 20.19.5。SQLite 和中文分词依赖平台原生二进制。

```powershell
npm ci --legacy-peer-deps
Copy-Item .env.example .env
# 编辑 .env，填写自己的模型 API Key、地址和模型名称。
npm run build
npm run chat
```

`chat` 提供持续对话。输入 `/exit` 或结束标准输入会等待已接收工作保存后退出。LangGraph 兼容路径另支持 `/interrupt`；HDSI 采用新消息驱动的接话调度。

启动 Fastify 服务：

```powershell
npm start
```

默认地址为 `http://127.0.0.1:4317`。启动入口读取当前工作目录的 `.env`；进程环境变量优先。`.env` 已加入忽略列表。

| 配置 | 用途 |
| --- | --- |
| `FAMILA_DATA_DIR` | 数据目录，默认当前目录下 `.famila` |
| `FAMILA_CHAT_ENGINE` | `hdsi` 或 `langgraph`；HDSI 数据独立存于数据目录下 `hdsi/` |
| `FAMILA_HDSI_MODE` | 默认 `native` 保留原生逐轮提交；`fast` 为未通过行为等价验收的低延迟试验 |
| `FAMILA_HDSI_ACTIONS` | `1` 启用外围情景行动循环，仅支持 native；未设置时保留原行为 |
| `FAMILA_WEATHER_PROVIDER` | 默认 `wttr`（通常3天分时预报）；`open-meteo` 使用原7天日预报 |
| `FAMILA_MODEL_VENDOR` | 原模型适配器类型：`openai`、`anthropic`、`google` |
| `FAMILA_MODEL_API_KEY` / `FAMILA_MODEL_BASE_URL` / `FAMILA_MODEL` | 主模型配置 |
| `FAMILA_QUICK_API_KEY` / `FAMILA_QUICK_BASE_URL` / `FAMILA_QUICK_MODEL` / `FAMILA_QUICK_VENDOR` | 情绪评估、记忆归档等轻量调用的模型配置 |
| `FAMILA_USE_RESPONSES_API` | 是否使用 Responses API，显式填写 `true` 或 `false` |
| `FAMILA_HOST` / `FAMILA_PORT` | 服务监听地址和端口 |
| `FAMILA_API_TOKEN` | Bearer Token；监听非回环地址时必须配置 |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_WEB_SEARCH_MODEL` | 可选的独立联网搜索配置 |

HDSI 接入使用 OpenAI-compatible Chat Completions，native 模式接收完整 JSON 剧本；外围行动往返使用情景文本，最终再归一为原生剧本。读取主模型配置，不使用 LangGraph 的 quick 配置、Responses API 或原工具注册表。LangGraph 路径未设置的模型字段保留数据库现有值，显式主模型字段默认也配置 quick 模型；模型配置会保存在其本地数据库中。

## Agent 服务入口

这些入口只操作 Famila 自身，没有定义 WorldEdit 应用契约。

| 入口 | 行为 |
| --- | --- |
| `GET /health` | Runtime 接收状态与队列状态 |
| `POST /messages` | 接收 `{ "text": "你好", "requestId": "可选唯一标识" }`，返回 SSE |
| `GET /history` | 读取近期持久化对话 |
| `GET /deliveries?after=0` | HDSI 会话气泡 SSE，每次实际投递触发一个 `bubble`，包含 cursor、requestId、content 和 created。断线后传最后处理的 cursor，或用 SSE 的 Last-Event-ID 续接。 |
| `POST /interrupt` | 请求中断当前 Agent 回复 |

HDSI 聊天客户端从 `/deliveries` 渲染气泡，通过 `POST /messages` 提交输入。POST 的 `complete` 表示该请求已结束，后续气泡仍通过会话流送达。每个身份独享一个发件箱。客户端按 cursor 去重。

配置 Token 时，所有请求携带 `Authorization: Bearer <token>`。

```powershell
$body = '{"text":"你好，法弥拉。","requestId":"hello-1"}'
$body | curl.exe -N http://127.0.0.1:4317/messages -H 'Content-Type: application/json' --data-binary '@-'
```

SSE 事件：`request` 返回 requestId；`chunk` 承载原内核的阶段、文本和最终结果等消息；`complete` 表示本次调度调用完成；`error` 表示调用失败；长连接期间会发送 `heartbeat`。原内核也可能通过 chunk 的 `stream_error` 或 `interrupted` 报告结果，调用方应同时检查。

重复 requestId 不重复执行。HDSI 路径中运行中的重复请求共享结果，已完成请求回放持久回复；同一 ID 搭配不同正文会拒绝。LangGraph 路径沿用原有去重行为，已完成请求可从历史读取结果。两者均不支持 `Last-Event-ID` 恢复。

网络断开只停止向该连接输出，不取消 Agent 任务。慢消费者超过缓冲上限会被断开，任务仍继续。显式中断使用 `/interrupt`。正常 SIGINT/SIGTERM 关闭时停止接收新工作、排空已接收与恢复的任务，再关闭连接和数据库；等待时间受任务及模型调用超时影响。

## LangGraph 内核与工具

`src/runtime/familaRuntime.ts` 管理身份进程的运行生命周期，`src/server.ts` 只负责 HTTP 接入；`src/bin/` 提供服务和 CLI 启动入口。原内核目录暂时保留，方便核对来源与行为。

目前注册 14 个内建工具：工具发现/激活、时间、加法、记忆召回、表达方案、长期习惯、思考指南、搜索、产物发布/读取，以及活动任务查询、任务详情、继续子任务。工具按原有可见性、任务状态和调用预算开放，并非全部常驻模型上下文。

搜索沿用 DashScope 原生搜索。使用其他主模型服务时，需要单独设置 `DASHSCOPE_API_KEY`；不会把其他服务的密钥转发给 DashScope。思考指南目前保留人物分析与剧情讨论两种原有内容。任务框架已经迁移，但没有启用通用子 Agent 执行器，也没有新增终端或浏览器工具。

短期记忆窗口为 8 条消息，溢出进入归档缓冲，再生成阶段摘要与长期记忆；召回使用中文分词和 BM25。人格、情绪、习惯和生活状态已接入执行流程。高级自我经历演化仍保留原有代码状态，不能视作完整自动演化功能。

启动恢复会重新调度已落盘的 queued 事件；对执行中的回合，只恢复安全的待提交结果。普通检查点或工具副作用结果不明确时停止并标记失败，不自动重放未知动作。

## 验证

```powershell
npm run build
npm run check:boundaries
npm test
npm run test:smoke
# 使用原生 SQLite 运行原有回归用例：
$env:FAMILA_TEST_SQLJS = '0'
npm test
```

`npm test` 运行迁移的 133 项内核回归，默认使用测试专用 sql.js；`test:smoke` 包含服务配置/校验/关闭测试、完整模型替身回合，以及使用默认原生 SQLite 的多进程持久化与恢复验收。需要允许测试进程之间访问本机回环端口。

本机已安装并验证 better-sqlite3 原生驱动。验收使用本地模型替身，不使用真实 API Key，也不代表真实模型的回答质量或外部搜索效果已经验收。

## 开发入口

保留 `initializeFamilaCore()` 等底层导出，便于测试和扩展。推荐使用 Runtime 管理独立进程：

```ts
import { startFamilaRuntime } from 'famila-core-agent/runtime'
import { createFamilaServer } from 'famila-core-agent/server'

const runtime = await startFamilaRuntime({ dataDirectory: './.famila' })
const server = createFamilaServer(runtime)
await server.listen({ host: '127.0.0.1', port: 4317 })
// server.close() 排空任务并关闭 Runtime。
```

数据目录保存内核数据库、人格配置、提示词、习惯与 trace。默认提示词资源随包发布。新数据库自动建立内核表，已有库必须有受支持的 schema 标记；不要将 WorldEdit 数据库直接当作独立内核库使用。

来源提交及文件清单见 `extraction-manifest.json`，迁移边界见 [提取记录](docs/extraction.md)。
## 聊天优先更新

默认普通聊天直接生成正文，情绪、偏好、生活状态和记忆整理在后台更新。详见 [流程与验证边界](docs/conversation-path.md)。中文离线评测运行 `npm run test:companion`，详见 [评测说明](evals/companion_zh/README.md)。真实模型质量和端到端延迟尚未评测。

