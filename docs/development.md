# 开发与验收规范

正式实现与验收应由本地进程连接远端 `famila_test`。服务、HDSI worker、工具与模型代理运行在本机；对话、故事、记忆、意图及工具状态保存在远端 PostgreSQL。模拟网页和本地模型替身可以用于确定性验收，但持久化链路仍使用远端测试库。

线上长期对话和 QQ/App 实例只使用 `famila_prod`。生产进程设置 `NODE_ENV=production`、`FAMILA_DB_ENV=prod`；本机 `.env` 设置 `FAMILA_DB_ENV=test`，填写 `FAMILA_TEST_PG_*` 和可读取的 `FAMILA_PG_CA_FILE`。凭证不提交到 Git。

## 验收约束

- 不暂停线上服务，不向生产库写入测试数据，不通过测试入口修改生产角色。
- `evaluation` 不允许连接生产库。页面通知实验入口仅在显式启用 evaluation、使用 PostgreSQL test 且不是生产进程时开放。
- 保留测试库现有数据，使用独立运行编号和请求 ID，记录本次运行的起始水位；报告只收集本轮新增条目和回复，避免旧记录污染验收或触发去重回放。
- 同一测试库的 HDSI 验收脚本顺序运行；遇到活动实例锁先定位本地测试实例，不切换到 SQLite 绕过验收。结束时关闭 worker、模型代理和数据库连接。
- 核对远端消息、回复及页面通知记录，并记录模型调用数、阶段耗时、完整剧本和实际回复。日志不得记录模型或数据库密钥。
- 无实际回复不自动判为故障。核对模型输出和落库 `interaction`：`reply.mode=none` 可以是主动沉默，检查已读状态、剧本理由与后续条件保留；选择 `immediate` 时才核对实际投递。区分工具执行次数、模型请求次数和已提交幕数。
- SQLite/sql.js 可继续用于离线单元回归和明确标注的历史对照实验；这类结果不代表远端 PostgreSQL 的正式功能验收已通过。

## 命令

在项目根目录使用 Node.js >=20.19.5：

```bash
npm run build
npm run check:boundaries
npm test
node --test tests/*.test.cjs
```

以上包括离线回归。正式 PostgreSQL 集成验收顺序执行：

```bash
node scripts/postgres-chat-smoke.cjs
npm run test:search
```

`test:search` 使用真实配置模型、本地 HDSI native 进程、远端 `famila_test` 和模拟 90 秒网页加载，覆盖搜索发起、加载期间补充需求、40 秒提醒及结果通知。它保留测试记录，自动生成报告，并直接核对 PostgreSQL 中的本轮数据。

这个实验是 `plan.MD` 中经典加载场景的验收入口。完整阶段验收还需补齐立即返回、失败/取消、重启/乱序/重复通知等场景及规定重复次数，不能用单次经典场景替代全部五类验收。

本次 PostgreSQL 场景通过及其边界见 [延时搜索验收记录](delayed-search-acceptance.md)。
