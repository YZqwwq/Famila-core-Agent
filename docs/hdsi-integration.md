# HDSI 引擎接入与低延迟调度

**2026-11-12 验证更新：下文的分离叙事流程描述的是 `fast` 试验模式。该模式未通过原版行为保真验证，默认已改为 `native`，本地配置同步切回。原生模式保留每轮完整叙事和情绪更新，需要等待较长模型请求。结果见 `hdsi-behavior-validation.md`。**

2026-11-11，已接入完整 HDSI 源码服务，不是抽取提示词。上游固定提交 `13a623fdc23c0558173fbfa11ad9cdf51c8330e0`，原始来源及文件哈希见 `vendor/hdsi/provenance.json`，原 AGPL-3.0 许可保留在 `vendor/hdsi/LICENSE`。本地补丁仅处理流式回复的完成通知、前后台调度、过期结果隔离及恢复所需入口。

## 启动和所有权

设置 `.env` 的 `FAMILA_CHAT_ENGINE=hdsi`，构建后 `npm start` 或 `npm run chat`。`FAMILA_CHAT_ENGINE=langgraph` 可使用原执行引擎。程序化入口是 `famila-core-agent/hdsi` 的 `startHdsiRuntime` 或 `famila-core-agent/engines` 的 `startAgentRuntime`。

HDSI 使用独立 Node worker，内部运行 Koishi、原生 InterludeService、原生 DesktopBridge 和 SQLite。Famila 的 Fastify/CLI 只负责接入，不再同时启动原 LangGraph 消费者。适配器仍以 TypeScript 开发；上游源码保留，构建生成独立 bundle。HDSI 目前接入 OpenAI-compatible 主模型，不复用 Famila 原工具注册表、专业任务执行或原有记忆数据库。

数据位于 `FAMILA_DATA_DIR/hdsi/`：

- `transport.sqlite`：Famila 持久化入站、出站记录和单宿主所有权。
- `conversation.sqlite`：HDSI 自己的会话、事实、意图、投递账本，另有尾任务审计表 `famila_hdsi_tail`。

原 LangGraph 历史没有自动导入 HDSI。当前是一份数据目录对应一个用户/一个角色，不能用于多租户部署；同一身份的第二个运行实例会被拒绝。

## 实际处理顺序

1. Fastify 入站先保存 requestId 与正文。并发相同 ID 共享结果，已完成 ID 回放回复；同 ID 不同正文拒绝。最多 64 个未完成入站提供背压。
2. worker 使用 HDSI 原生队列合并短时消息（100 ms），原生 interaction-first 流式生成。模拟打字关闭；单次消息不分气泡，`<sep/>` 仅在传输层渲染为换行，不改写词句。
3. 完整聊天内容进入本地 outbox 并落盘后回执给 HDSI；HTTP 必须等 HDSI 自己也记录首条回复、设置 firstMessageCommitted 边界后才结束。用户随后接话不会使已提交回复被当作过时草稿重新排队。
4. 首回复提交后，允许 HDSI 释放本轮前台所有权，继续接下一条消息。原生完整模型流仍在 worker 内生成叙事。
5. 最多两个已经释放前台的叙事尾任务。达到上限时，新一轮仍可提前回复，但不会继续释放前台，由原生队列提供背压；不会无限并行模型请求。
6. 叙事返回时在原生 story 串行域内检查：首回复记录之后如果出现新用户消息，叙事只存审计表为 `archived`，不写回规范剧本、事实、意图、游标等。没有新消息才走原生提交并标记 `applied`。真实用户原话和已经发出的回复始终保留。

TurnEngine 的请求编号改为同一参与者单调增加，避免旧任务完成时误释放新的队列所有权。原生写入短锁、旧回复失效、消息去重、投递账本继续保留。

## 恢复与关闭

worker 崩溃不会把未完成入站变成成功；调用者收到失败，原文仍在 transport.sqlite。重启重新提交未完成请求：若 HDSI 已登记用户原话，就使用原生缓冲入口恢复处理，不再重复登记。

outbox 已接受但 HDSI 可见消息检查点缺失时，启动会从持久 outbox 修复原生对话证据，不重新向用户发送。该修复目前扫描历史 outbox，启动成本随历史增长，后续可改为检查点水位。

进程退出时通过明确的 worker drain 回执等待前台及已分离叙事结束，不根据可能过时的 `/health` 快照直接关闭。异常中断的尾任务启动时标为 `interrupted`，不伪装已完成，也不自动重放已发送消息。中断尾任务尚未实现重新生成；其用户消息与实际回复仍是可恢复的事实来源。

本地 outbox 接受不代表远程社交平台或用户已经读到；HTTP 断开后可从历史/同 requestId 回放。尚未接入 QQ/微信，也不提供跨宿主分布式队列或端到端 exactly-once 承诺。

## 验证结果

本地集成回归 9 项全部通过，包含新增两项 HDSI 集成场景：

- Fastify 鉴权、SSE、分隔符渲染；并发去重、已完成重放及冲突正文拒绝。
- 旧叙事被模型桩卡住时，下一条仍能回复。
- 新叙事先完成、旧叙事后完成，旧内容只归档，不覆盖新规范状态。
- 两个已分离尾任务上限；旧任务结束不清掉新任务的所有权。
- 连发输入和并发相同 requestId 只产生一次额外主请求。
- worker 被强制结束后，未完成入站恢复；原生检查点丢失后由 outbox 修复；第二实例拒绝启动。

原内核回归 133/133 通过；TypeScript 构建、依赖边界检查通过。

真实模型运行：`evals/companion_zh/reports/hdsi-integrated-1794412369861`。通过当前 worker 的三轮连续接话，首回复 1818、2351、1829 ms，没有上一轮约 14 秒的队列等待；三个完整模型请求仍分别花费约 13.95、12.88、14.06 秒。前两个尾任务最终 `archived`，第三轮在前台背压域完成规范提交。调用共 3 次，输入 19,003 token、输出 1,435 token。报告不是 P95 或多人压力测试，也不代表原有口语化内容问题全部解决。

复现：`npm run build`，再运行 `node --test tests/hdsi.test.cjs`（本地桩、不付模型费）；`node scripts/hdsi-live-pilot.cjs --live` 为最多 8 请求、每次最多 2048 输出 token 的真实模型试跑，使用独立身份目录。
