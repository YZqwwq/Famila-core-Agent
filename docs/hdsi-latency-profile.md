# HDSI 时间损耗定位

2026-11-10，固定上游提交 `13a623fdc23c0558173fbfa11ad9cdf51c8330e0`。在 `../../.research/hdsi-eval/run.cjs` 添加仅观察的函数包装和代理计时，未改动上游源码。沿用 qwen3.8-max、关闭思考、HDSI 默认 0.8 采样及原生叙事提示词；每组两个连续消息。共 10 个主请求、2 个原生侧任务请求。

## 默认链路的实测分解

`reports/live-1794323423469/results.json` 第一轮：

| 阶段 | 时间 |
|---|---:|
| 接收入站、初始化/数据库登记，到 accepted | 137 ms |
| accepted 到开始 flush，主要是默认合并等待 | 2001 ms |
| flush 到模型请求抵达代理，含快照、上下文和请求编译 | 62 ms |
| 代理请求到完整模型响应 | 15689 ms |
| 完整响应到可见投递请求，含解析、提交和发送准备 | 51 ms |
| 总首回复 | 17940 ms |

第二轮接收登记 40 ms，合并等待 2012 ms，其余模型前约 31 ms，模型完整响应 16162 ms，末段约 30 ms，总首回复 18275 ms。默认瓶颈是主请求生成完整剧本和结构化输出；不能将整个 15–16 秒说成网络时间。非流式响应没有直接首 token 观测。

## 原生配置对照

| 配置 | 两轮首回复 | 观察 |
|---|---|---|
| 默认合并 2 秒、非流式 | 17.94 / 18.28 秒 | 生成完整剧本后发送 |
| 仅合并改 0 秒 | 14.31 / 13.60 秒 | 固定 2 秒等待消失，但模型完整生成仍在前台 |
| 合并 0 秒＋experimental streaming，保留分段 | 16.47 / 19.32 秒 | 回复对象在 2.13 / 1.83 秒就绪，但未获准提前发送 |
| 上述流式＋splitReplyMessages=false | 3.59 / 4.00 秒 | 提前投递生效，但有模拟打字下限 |
| 流式＋不分段＋模拟打字 0 秒，首回复后立即发下一条 | 2.33 / 16.16 秒 | 第一条快；第二条被上一轮未完成叙事占用队列 |

报告目录按顺序为：

```text
../../.research/hdsi-eval/reports/live-1794323423469
../../.research/hdsi-eval/reports/live-1794323478970
../../.research/hdsi-eval/reports/live-1794323538214
../../.research/hdsi-eval/reports/live-1794323635714
../../.research/hdsi-eval/reports/live-1794323697611
```

## 三个实际阻塞点

### 1. 实验性流式与分段不兼容

上游 `narrator.ts` 在 experimental 下输出 interaction 在前、script 在后，解析到完整 interaction 即回调 `onEarlyReply`。这两轮首 token 约 1.10–1.21 秒（相对模型请求），完整聊天对象约 1.83–2.13 秒（相对用户消息）已经存在。

但 `service.ts:deliverEarlyPrivateReply` 明确要求 `splitOutgoingMessage(content).length === 1`。模型保留 `<sep/>` 时被拒绝，反复回调仍拒绝，最终走普通整轮完成路径。单纯打开 streaming 不能保证加速。

关闭分段可验证此瓶颈，但不是最终产品修复：在 rapid 组第二轮，`<sep/>` 字面量泄漏进了实际投递内容。需要让提前投递原生支持完整的第一气泡，后续气泡仍按账本投递，或输出协议明确只产生一个消息。

### 2. 首消息也有模拟打字下限

`firstMessageTypingHoldMs` 按字数和打字配置计算下限，再减去从 requestStartedAt 起已经过去的时间。过去模型很慢时它不明显；提前流式变快后开始补足等待。

单气泡组完整回复在 2.013 / 1.748 秒就绪，投递却在 3.593 / 4.002 秒，即另外等待约 1.58 / 2.25 秒。打字时间是随机浮动值，不能推广为固定常数。

将 typingBaseDelaySeconds=0、typingMaxDelaySeconds=0、typingJitterRatio=0 后，rapid 第一轮完整回复在 2323 ms 就绪、2325 ms 投递，提前提交处理没有明显额外阻塞。

### 3. 回复提前了，整轮仍未释放

rapid 第一轮 2325 ms 已发送，模型仍继续写剧本，到 16571 ms 才结束 narrator。测试程序在首回复后约 341 ms 就发第二条：

- 第二条 26 ms 已接收入库；
- 等到 14052 ms 才能开始自己的 flush；
- 其模型请求在 14077 ms 开始；
- 完整回复在 16163 ms 就绪并发送。

这说明第二条约 14 秒耗在排队，模型自身生成聊天约 2.09 秒。`TurnEngine` 的 story 级 narrating 标记直到 `endFlush` 才释放，而当前 flush 仍 await 完整 narrative 请求。提前显示没有缩短下一轮的实际接话等待。

## 下一步建议

1. 消息合并先用 0–200 ms 小窗口对照，去掉默认 2 秒固定等待；是否恢复一点合并时间取决于连发消息测试。
2. 关闭模拟打字下限，保留真正需要的分段调度。
3. 保留“聊天内容在前”的输出方式，并修复提前发送对第一气泡的支持，防止 `<sep/>` 泄漏。
4. 首回复持久化/投递后允许下一轮聊天推进。生活叙事与低频状态整理移出前台串行占用，采用事件序号、快照和版本核对写回，不能简单删除并发锁，否则会乱序覆盖或重复投递。

第 4 项是连续聊天低延迟的主要结构性工作。仅调合并、打字和流式配置已经能让首条约 2.3 秒，但不能据此承诺连续每条都 2 秒。以上只有每组两轮观测，输出长度、缓存、提供商负载都有变化，不是 P95，也没有完成高并发与故障恢复验收。

本次只增加测试适配器配置和计时，Famila 默认逻辑、HDSI 上游源码均未改动。

## 复现

在 `../../.research/hdsi-eval` 运行：

```text
node run.cjs --live --latency=baseline
node run.cjs --live --latency=zero
node run.cjs --live --latency=stream
node run.cjs --live --latency=stream-single
node run.cjs --live --latency=stream-rapid
```

每次调用有全局 16 次请求上限、2048 token/输出上限及超时；不是无成本测试。原始 timeline、模型完整输出、token 用量、配置、SQLite 均在独立报告目录保留。计时包装标记原生事件，不生成或改写回复；SSE 在代理中实时透传。
