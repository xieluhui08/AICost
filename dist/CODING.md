# Claude Code / Codex 接入

AgentGuard 的编码工具适配器接收 OTLP HTTP 日志（JSON 或 protobuf，可 gzip），保存到 SQLite。使用 better-sqlite3 保存账本；需要 Node.js 20.19+，先执行 npm ci 安装依赖。默认监听 8080，当前预算状态协调只支持一个服务进程。

## 1. 启动服务与创建连接

```bash
npm ci
npm run setup:local
npm run doctor
npm run start:local
```

打开 http://127.0.0.1:8080/#coding，在统一登录处输入 ADMIN_KEY，在「新建连接」中选择 Claude Code 或 Codex。填写项目、客户、功能、每次会话预算和策略。只读查看可使用 READ_KEY。

- **只监测**：每个会话单独归集和判断预算；有父会话标识时归入父会话。只发告警，不停止客户端。没有完整父子标识时，不推断跨会话关系。
- **本机托管**：一条连接对应一次运行及其子任务。通过下方启动器执行；超预算、异常、人工拒绝会请求停止整个进程组。
- **计价**：Claude 上报 `cost_usd` 本身是估算值，需显式填写 USD/CNY 汇率。Codex 填写与实际遥测一致的模型 ID 及普通输入、输出、缓存读取、缓存写入四项 CNY/百万 Token 单价。可通过创建 API 的 `prices` 对象配置多个模型。
- `prices` 示例结构：`{"你的模型ID":{"input":1,"output":2,"cached":0.1,"creation":1}}`，数字仅为结构示意，不是官方价格。
- 未知费用显示「未计价」，不会冒充零成本。托管运行出现无法计价的模型完成事件会转人工。缺少缓存拆分但已知总输入/输出时，未知输入部分按配置的最高输入单价保守估算，价格快照中会记录此假设。
- `reasoning_tokens` 是输出 Token 的子集，不会再次加到输出；Claude 的总输入由普通输入 + 缓存读取 + 缓存写入构成。
- 记录金额不是 Claude/ChatGPT 订阅账单，不代表订阅额度、账户余额或最终 API 扣费。

新连接保留创建时的服务端策略快照，显式填写的预算和动作优先；修改费用策略不会追溯改变已有连接。

连接创建后只显示一次专属密钥。服务端只保存其 SHA-256 摘要；它不能读取其他连接、管理策略或审批。不要将密钥提交到 Git。

## 2. 本机托管运行（macOS / Linux）

在已安装官方 Claude Code / Codex CLI 的 Mac 终端中，先正常完成客户端自己的登录。模型登录信息由客户端管理，AgentGuard 不读取账户凭证。

```bash
export AG_URL='http://127.0.0.1:8080'
# 在当前终端安全设置 AG_CONNECTION_TOKEN，值为刚创建连接时显示的密钥。
# 不要把密钥写入仓库或脚本。
node scripts/guard-run.mjs --connection conn-你的连接ID -- claude -p "检查当前项目的一个问题"
# 或使用为 Codex 创建的另一条连接：
node scripts/guard-run.mjs --connection conn-你的连接ID -- codex exec "检查当前项目的一个问题"
```

只支持 `claude -p/--print`、`codex exec` 非交互任务。连接模式必须为「本机托管」，命令必须与连接选择的工具一致。服务部署在远程时必须使用 HTTPS；本地 loopback 可用 HTTP。

启动器为本次进程配置日志出口，不修改用户配置文件。Claude 额外通过 `--settings` 注入 `PreToolUse` 与 `SubagentStart` 钩子：

- 调用前在本机计算工具参数签名，只上传签名，不上传参数原文。
- 发现循环或已停止策略时，调用前钩子要求停止；服务不可达时阻止本次工具调用。
- 子智能体开始时上报唯一 `agent_id`，同一子智能体恢复执行不会重复计数。SubagentStart 官方钩子本身不能阻止创建，超过上限由启动器停止进程组。
- 管理员策略可能禁止或覆盖客户端遥测/钩子配置。请核对「收到遥测」和检测覆盖；不能仅凭启动命令成功判定已受保护。

启动器每 500ms 查询决策、约每 2 秒发送心跳。默认 120 秒未收到新的有效遥测或运行超过 15 分钟，会保护性停止；适用于短时自动化任务。正常结束、终端中断、预算或异常停止时，启动器只向它新建的进程组发送 TERM，随后 KILL 清理残留子进程，不扫描和终止其他 CLI 进程。

**这不是零超支硬配额。** 遥测是异步上报，在途请求可能继续计费；上游费用估算可能不完整。任务自行脱离进程组、远程子任务、启动器遭 SIGKILL/主机宕机均不在本机清理保证内。页面只有收到启动器最终心跳才显示「确认已停止」，失联显示离线。

转人工时同样先结束本次客户端进程。管理员在「编码工具」追加预算批准后，需要检查已经执行的操作，并手动恢复客户端会话或重新发起命令；AgentGuard 不自动重放任务，不承诺原地无损恢复，不自动替换 Claude/Codex 的模型。

## 3. 只监测连接

Claude Code（在启动客户端的 shell 设置；用户或管理员级配置也可）：

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="$AG_URL/api/telemetry/conn-你的连接ID/v1/logs"
export OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $AG_CONNECTION_TOKEN"
export OTEL_LOG_USER_PROMPTS=0
export OTEL_LOG_ASSISTANT_RESPONSES=0
export OTEL_LOG_RAW_API_BODIES=0
claude
```

默认 Claude 遥测不含工具参数，循环检测显示「缺少参数」。如自行开启 `OTEL_LOG_TOOL_DETAILS=1`，参数会传输给服务端、仅在内存中用于哈希；不落库原文。若不希望传输原文，使用托管启动器的调用前钩子。

Codex：在用户级 `~/.codex/config.toml` 中合并（不要覆盖原有其他配置，不要放在项目级配置）：

```toml
[otel]
log_user_prompt = false
exporter = { otlp-http = { endpoint = "http://127.0.0.1:8080/api/telemetry/conn-你的连接ID/v1/logs", protocol = "binary", headers = { Authorization = "${AG_OTEL_AUTH}" } } }
```

启动前设置 `AG_OTEL_AUTH="Bearer $AG_CONNECTION_TOKEN"`。修改配置后新开一个会话。不同版本的字段可能变化；没有参数就不做重复参数循环判断，没有父子 ID 就不推断子智能体关系。Codex 的 `spawn_agent` 工具结果若提供结构化 `agent_id`，可在创建后计数；否则仅依靠明确父子字段。

本实现只消费日志，不订阅指标计数器，避免同一调用同时由指标和日志重复收费。Codex 只把 `response.completed` 完成事件计为模型用量；工具事件、子任务完成时的上下文 Token 不重复加入模型总量。事件 ID 去重跨服务重启持久有效，但请勿把同一客户端同时配置到多个连接。

## 4. 历史、查询与导出

「用量历史 → 服务端账本」使用 READ_KEY 查看按时间、来源、项目、客户、功能和模型筛选后的记录、图表及 CSV。Token 明细包含缓存读取/写入、推理 Token，会话 ID 和价格快照。Token 未知保持未知。

历史导入接受已导出的 **OTLP JSON LogsServiceRequest** 文件（顶层 `resourceLogs`），不自动扫描 `~/.claude` 或 `~/.codex`，也不假定内部 JSONL 文件格式稳定。每批最多 1 MB、1000 条日志。

在只监测连接活动区域选择 JSON 文件导入，或：

```bash
node scripts/import-telemetry.mjs conn-你的连接ID /path/to/otlp-history.json
```

历史模式保留原始时间；UTC+8 归属日期。历史事件不触发实时告警和停止，使用单独历史任务；和同一连接的实时事件使用相同去重键。输出 accepted / duplicates / ignored / rejected，遇到不支持的事件类型不会伪造成功调用。可重复导入补充不同批次，但不支持修改已记账事件的价格回溯。

## 5. API 与权限

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| GET /api/coding/connections | READ_KEY / ADMIN_KEY | 连接、任务、覆盖、启动器状态、告警 |
| POST /api/coding/connections | ADMIN_KEY | 创建连接，只返回一次 token |
| GET /api/coding/events?connection_id=… | READ_KEY / ADMIN_KEY | 活动分页，limit≤500 |
| POST /api/coding/connections/:id/stop | ADMIN_KEY | 请求托管任务停止 |
| POST /api/coding/connections/:id/revoke | ADMIN_KEY | 撤销凭证，保留历史 |
| POST /api/coding/connections/:id/import | ADMIN_KEY | 只监测连接的历史 OTLP JSON |
| POST /api/telemetry/:id/v1/logs | 该连接 token | OTLP HTTP 日志；可加 historical=1 |
| GET /api/telemetry/:id/decision | 该连接 token | 只读取自身决策 |
| POST /api/telemetry/:id/heartbeat | 该连接 token | 托管启动器心跳和停止确认 |
| POST /api/tasks/:task-id/approve | ADMIN_KEY | approved 与 extraBudget；拒绝时 approved=false |

查询均使用参数化 SQL。归一化事件、状态和用量行在同一 SQLite 事务提交。告警沿用服务端 FEISHU_WEBHOOK / WECOM_WEBHOOK 设置；本次测试没有向真实机器人发送消息。共享 READ_KEY/ADMIN_KEY 是单团队权限模型，不是多租户隔离。

## 6. 验证与范围

`npm test` 覆盖 JSON/protobuf/gzip、缓存计数、重复事件、重启去重、来源隔离、事务失败、历史导入、风险判定、读写权限，以及真实模拟进程组的停止、断连保护、无关进程保护和前端交互。使用模拟遥测和进程，不调用付费模型。

尚需在你的客户端版本上验证：登录与管理员策略、实际遥测字段、运行子任务是否保留进程组、模型价格和 webhook 送达。Sites / GitHub Pages 仅发布静态前端；采集与数据库需本机或私有服务器运行。

官方协议参考（实现核对日期 2026-10-27）：
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/hooks
- https://learn.chatgpt.com/docs/config-file/config-advanced

## 凭证撤销与启动器归属

只监测和本机托管连接都可在网页撤销凭证。请求停止只停止当前任务决策，并不等同于撤销密钥。丢失或泄露连接密钥时，应撤销旧连接并新建。

启动器必须先以 starting 占用连接，后续心跳必须来自同一运行实例。终态重发仅作为幂等确认，不会改写后来批准的任务。运行实例已结束时不能复用其 runner ID。异常崩溃未提交终态的连接不会自动允许其他启动器抢占，需排查原进程后新建连接。

启动器不会向编码子进程传递 ADMIN_KEY、INGEST_KEY、READ_KEY 或 CONFIG_ENCRYPTION_KEY；客户端所需的模型 API Key 仍按本机环境提供。未知或无效费用不按免费处理，托管模式转人工确认。
