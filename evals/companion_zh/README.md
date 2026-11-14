# 中文陪聊评测（P0）

这是独立 TypeScript 评测模块。参考用户提供的评估说明中的分维度、因果回放和隔离原则；没有下载第三方题库，也不声称复现任何官方基准。

运行 `npm run test:companion`：构建评测器，运行无网络单测，然后执行 18 道原创中文开发种子题的 mock 回放。输出在 `evals/companion_zh/reports/smoke/`，包含 manifest、逐题响应、错误列表和报告。该目录默认忽略，结果不进入生产数据库。

`index.ts` 包含 AgentAdapter、mock、三种模式校验、因果截止、裁判校验和按对话/场景族聚合。模式不支持时返回 unsupported；N/A 不算零分。当前 mock 不提供固定 assistant 历史注入，所以 controlled replay 为 unsupported；互动与跨 session 的模拟回放可运行。重复执行只恢复同一数据 hash 的 mock 结果。

真实能力审计：

| 能力 | Famila 当前状态 | 评测适配状态 |
|---|---|---|
| 多轮聊天 | `FamilaRuntime.sendMessage` + done.fullContent | 真实核心已由本地模型 fixture 集成测试验证 |
| 持久化 | SQLite，单进程单人格；重启读取同一目录 | 应按用例启动独立进程/临时目录，跨 session 重启并保留该目录 |
| 固定历史注入 | 无公开接口 | unsupported，不能把历史改成用户台词冒充 controlled replay |
| 人格/情绪 | 已提交快照 + 后台更新 | 需要等后台收敛，记录 observation cursor |
| 主动发消息/模拟时钟 | 无公开可控接口 | not_applicable |
| 重置多用户 | 无多租户接口 | 每题全新隔离目录与进程，不操作生产 reset |
| 主观质量裁判 | 尚未配置 | unscored / not_calibrated |

当前真实付费回放入口有意阻止执行：尚未指定模型与预算，也未接入能覆盖前台、后台和工具请求的强制额度适配器。仅给 CLI 一个美元数字并不能真正限制费用。`--live` 会明确 blocked，不会偷偷读取生产配置运行。待指定模型和额度后接入独立进程 adapter 及计费代理，再进行 Agent → 独立 Judge 的小规模回放。

数据为 18 个原创、未人工审校的 dev 种子场景，含 3 个跨 session 轨迹。不作为 holdout，不估计统计代表性。rubric 和 expected_fact 只留在评分侧，未来事件不会发送给 Agent。自然度、情绪质量、社交、人格/记忆及安全分别报告；目前没有真实质量分数、置信区间或真人相似度。

后续仍需：真实隔离进程 adapter、全请求费用上限、原始逐轮事件/用量、独立 LLM judge、聚类 bootstrap 与 A/B 随机化、人工盲评。此版本只交付离线骨架和核心功能验证，不把这些未完成项写成已实现。
