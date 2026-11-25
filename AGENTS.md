# 开发规范

- 正式实现、功能集成测试和验收必须由本地进程连接远端 PostgreSQL `famila_test`。不得以 SQLite 或本机数据库的结果替代这一链路的验收。
- 线上 QQ、App 和长期对话实例只连接 `famila_prod`；使用 `NODE_ENV=production`、`FAMILA_DB_ENV=prod`。本地开发使用 `FAMILA_DB_ENV=test`。
- 测试不得暂停线上服务、修改生产人设或向生产库写入测试数据。测试接口不得在生产库启用。
- 每次持久化测试使用独立请求 ID，核验远端记录，保留已有测试数据；不得为了重跑默认清空数据库。一个测试库同时只运行一个 HDSI 实例，验收脚本顺序执行并正常关闭。
- SQLite/sql.js 仅可用于不依赖远端存储的离线单元回归或明确标注的历史对照实验，不计入正式集成验收。
- 详细流程与命令见 `docs/development.md`；阶段目标见 `plan.MD`。
