# AgentGuard 部署说明

## 当前交付范围
- 默认网页：同源 Node API + SQLite 真实控制台。没有数据时显示空态，服务故障不回退演练。独立 `/demo.html` 保留本地模拟演练。
- 私有服务：Node.js 单进程 HTTP 服务，任务级共享预算、调用前预留、事件摄入、管理员审批、供应商兼容代理和机器人告警。
- 总览、任务追踪、风险审批、成本分析、费用策略、用量历史、编码工具和接入中心共用管理员／只读登录，访问密钥只保存在当前页面内存。静态托管无 Node API，不能提供真实控制台。
- 供应商兼容适配槽位：DeepSeek、通义、Kimi、豆包、MiniMax。均未使用真实凭证联调。
- Dify、Coze、n8n：通用 HTTP 节点模板，非原生插件。必须配置条件分支遵守 decision，否则被旁路的调用无法阻止。

## 启动
需要 Node.js 20.19。先执行 `npm ci`、`npm run setup:local`、`npm run doctor`，再运行 `npm run start:local`。
初始化仅在不存在 `.env` 时生成不同的随机 ADMIN_KEY、INGEST_KEY、READ_KEY 和 CONFIG_ENCRYPTION_KEY；已有配置不覆盖。默认只监听 127.0.0.1，终端环境优先于 `.env`，数据库路径固定在项目 data/ 下。完整本机流程见源码根目录 LOCAL-SETUP.md。
正式部署设置 NODE_ENV=production，此时每个访问密钥至少 32 字符；三个密钥必须不同，不能使用示例占位值。
Docker:
    docker build -t agentguard .
    docker run --env-file .docker.env -e NODE_ENV=production -e HOST=0.0.0.0 -p 127.0.0.1:8080:8080 -v agentguard-data:/app/data agentguard
Docker 使用独立的 .docker.env（KEY=value，无外围引号）；接入中心提供 Node 与 Docker 两种下载格式，不能混用。将访问密钥和加密密钥一并填入私有环境文件。
打开 http://127.0.0.1:8080，输入 ADMIN_KEY 管理，或 READ_KEY 只读查看。API 监听同一端口。容器需要 HOST=0.0.0.0；不要把本机 .env 的 HOST=127.0.0.1 直接用于容器。
启用 HTTPS 反向代理后再对外使用，不要把管理凭证交给终端用户。

## 供应商配置
每家供应商的前缀分别为 DEEPSEEK、QWEN、KIMI、DOUBAO、MINIMAX。
配置 PREFIX_BASE_URL（以 /v1 等兼容接口路径结束，不含 /chat/completions）、
PREFIX_API_KEY、PREFIX_MODEL、PREFIX_FALLBACK_MODEL。
另需配置 PREFIX_INPUT_CNY_PER_M、PREFIX_OUTPUT_CNY_PER_M、
PREFIX_FALLBACK_INPUT_CNY_PER_M、PREFIX_FALLBACK_OUTPUT_CNY_PER_M。
价格为人民币每百万 token，不会自动抓取或转换。请使用供应商当前官方文档核对。
代理仅转发 messages、max_tokens 和可选 temperature，不支持流式、多模态与工具调用参数。
所有模型请求必须经过代理；不支持拦截供应商网页订阅或绕过代理的请求。

## API
所有请求带 Authorization: Bearer 对应密钥。任务摄入、代理和运行决策用 INGEST_KEY（也接受 ADMIN_KEY）；管理操作用 ADMIN_KEY；控制台查询用 READ_KEY 或 ADMIN_KEY。
### 创建任务
POST /api/tasks
    {"id":"demo-001","policy":"research","customer":"星河科技","feature":"竞品分析"}
策略 ID：support / research / content。默认值在 dist/engine.mjs。
服务端状态与策略保存于 data/agentguard.sqlite 的 app_state 表，可在“费用策略”修改并持久保存。创建任务时可额外传入 name 和独立 budget；budget 需大于 0 且不超过 1,000,000 元。

策略使用版本号防止覆盖并记录审计；只影响新建任务和新建编码连接。已有任务或连接保留创建时的策略快照，编码连接显式预算和动作优先。管理员审批可为当前任务追加预算。

### 调用模型
POST /v1/chat/completions
额外请求头：
    X-Task-Id: demo-001
    X-Provider: deepseek
    X-Agent-Id: root
请求体：
    {"messages":[{"role":"user","content":"写一段新品介绍"}],"max_tokens":512}
返回 agentguard.decision 与实际供应商响应。
409 + decision=degrade：备用模型已选中，调用方可重试一次；不得无限自动重试。
409 + decision=approval/stop：暂停或终止工作流。

### 上报工具、失败或子节点
POST /api/tasks/demo-001/events
    {"id":"event-001","agent":"root","tool":"web_search","input":{"q":"AI"},
     "cost":0.02,"error":false}
创建子节点时增加 childId。所有后代都关联相同根任务 ID。
id 必须唯一；相同事件 ID 重放不会重复计费。
外部事件的 cost 由可信摄入者提供，没有独立账单验证；不能向非可信租户暴露 INGEST_KEY。
代理已记录模型成本，外部事件不得重复上报相同费用。

### 决策与审批
GET /api/tasks/demo-001/decision
POST /api/tasks/demo-001/approve （管理员）
    {"approved":true,"extraBudget":5}
拒绝：
    {"approved":false}
完成：
POST /api/tasks/demo-001/finish
    {"status":"success"}
可用状态 success / failed。只有 running 且没有未结算调用的任务才能标记完成。
GET /api/tasks 返回任务与聚合指标，支持 q、status、customer、feature、offset、limit。READ_KEY 也可读取，不能修改。

### 真实控制台接口

| 接口 | 权限 | 返回或操作 |
| --- | --- | --- |
| GET /api/session | READ / ADMIN | 登录角色及管理权限 |
| GET /api/overview | READ / ADMIN | 状态计数、成本指标、最新任务和告警 |
| GET /api/tasks/:id | READ / ADMIN（兼容 INGEST） | 任务、事件及审计 |
| GET /api/alerts | READ / ADMIN | 风险列表与分页 |
| GET /api/costs | READ / ADMIN | 客户／功能聚合、模型费用与任务结果 |
| GET /api/policies | READ / ADMIN | 三种策略及版本 |
| PUT /api/policies/:id | ADMIN | budget、loop、retries、children、action、revision |
| GET /api/audit | READ / ADMIN | 按 task_id 或 policy_id 筛选操作记录 |

策略 revision 与当前不一致返回 409；重新读取后确认再保存。只读角色执行管理操作返回 403。

## 飞书与企业微信
设置 FEISHU_WEBHOOK、WECOM_WEBHOOK。
飞书签名机器人另设 FEISHU_SECRET，企业微信关键字可设 AgentGuard。
仅风险事件触发告警；失败记录到服务日志。当前无告警重试队列和去重配送保障。
网页演示不会发送任何告警。

## 检测与计费口径
- 循环：该智能体最近 12 次事件中，同一智能体相同工具与规范化参数重复达到阈值。
- 重试：同一智能体连续失败次数；该智能体成功事件重置连续计数。
- 膨胀：根任务累计唯一 childId 数。并非活跃并发数或语义进展检测。
- 预算：共享任务账本、同步预留防止单进程并发争抢。
- 请求前按 messages UTF-8 字节估算输入、max_tokens 估算输出；实际供应商 tokenization、
  隐藏推理 token、缓存和其他计费项目可能不同，因此不能承诺绝对零超支。
- 缺失 usage 或网络结果不确定时按预留金额保守计费，并提示人工对账。
- 已发送的调用不能撤销收费；停止控制后续请求。运行时停止须由工作流遵守决策。
- 任务停止、结束或待审批后收到的迟到事件仍入账，但不会重新开启任务或覆盖审批状态。
- 已花完预算时，降级策略也会停止；降级不能绕过总预算。
- 重启时未结算预留计入成本；运行中任务进入人工审批，已停止或结束任务保持原状态，避免遗失可能已产生的支出。
- 成功率：success / (success + failed + stopped)。
- 成功任务成本：全部累计费用 / 成功任务数量（包含失败与运行中费用）。

## 生产化前的必要工作
真实供应商及工作流平台联调；更准确的 tokenizer / 账单对账；
跨副本预算协调；租户隔离与用户认证；更细粒度的个人操作审计；
Webhook 重试队列；保存和恢复工作流检查点；异常误报评估。
模型代理的新记录仅保存 messages 的摘要用于循环比对，不保存对话原文；旧记录不会自动清理。通用事件摄入仍会保存调用方上报的 input，请自行脱敏，不能将敏感数据或密钥放入事件参数。
data 文件夹应使用持久卷，并在正式接入前配置保留周期和访问控制。

## 验证
npm ci
npm test
包含检测引擎回归、HTTP 权限与幂等、模拟上游并发预留与降级、真实控制台 API 与 DOM 验收、本机脚本及独立演练回归。
另运行 npm run smoke:local，用临时 SQLite 与本地模型替身检查本机服务链路；不读取实际 .env 或 data/。
测试使用模拟供应商，不产生 API 费用。DOM 测试不替代真实浏览器视觉与可访问性测试。
真实外部服务未验证。


## 手动停止
POST /api/tasks/demo-001/stop，使用 ADMIN_KEY，JSON 请求体为 {}。
停止阻止后续调用，已发送请求仍会结算。重复停止返回当前停止状态；已成功或失败的任务不能改为停止。

## SQLite 用量账本

使用 better-sqlite3 连接 SQLite，兼容 Node.js 20.19+，无需安装数据库服务。先执行 npm ci 安装依赖；如果当前平台没有预编译原生模块，需要 Python 3 和 C/C++ 编译工具（macOS 使用 Xcode Command Line Tools，Linux 使用 make 与 g++）。切换 Node.js 主版本后应重新执行 npm ci。数据保存在 data/agentguard.sqlite，使用 WAL 模式；请挂载整个 data 目录，不要只挂载数据库单文件。
首次启动时，如果存在旧 data/state.json，会在事务中导入并保留原文件。之后以 SQLite 为准，不再读取旧文件。迁移不补造历史 Token、模型或日期：无日期的历史余额仅在「全部」时间中计入。
备份时先停止服务，复制整个 data 目录；或使用 SQLite 在线备份工具。不要在运行时只复制主数据库文件而遗漏 WAL。
当前服务仍只支持一个 Node 进程写入同一个账本；不要通过多副本共享此文件扩容。

### 查看真实用量

1. 完成本机初始化并启动服务。
2. 在同一服务打开 /#usage，用 READ_KEY 或 ADMIN_KEY 登录一次。
3. 密钥只存在于页面内存，多个页面共享本次登录；刷新页面后需重新输入。
4. 调用模型代理或上报事件后，点击刷新，即可按时间、模型、客户和功能查看。

GET /api/usage?from=2026-10-01&to=2026-10-31&model=model-id&offset=0&limit=50
Authorization: Bearer READ_KEY

也允许 ADMIN_KEY，但不接受 INGEST_KEY。READ_KEY 不能创建任务、审批或调用模型。
可选筛选字段：from、to、provider、model、customer、feature、source；日期为 YYYY-MM-DD，按 Asia/Shanghai 自然日包含首尾两天。省略日期查询全部记录。limit 为 1–500，offset 为非负整数。
返回 summary、daily、models、rows、options、undated。undated 是全账本无日期记录统计；请求明细分页，聚合统计覆盖全部匹配记录。所有金额均为 CNY。

### Token 与费用

模型代理保存供应商、实际响应模型、请求模型、输入/输出/缓存 Token、耗时、状态及当次配置的价格快照。
缓存命中价可配置 PREFIX_CACHE_INPUT_CNY_PER_M 或 PREFIX_FALLBACK_CACHE_INPUT_CNY_PER_M；未配置时采用普通输入价。当前支持 DeepSeek prompt_cache_hit_tokens 与兼容格式 prompt_tokens_details.cached_tokens。
输入 Token 已包含缓存 Token，不能再次将缓存 Token 加到输入/输出总量。缓存率分母仅包含具有缓存字段的请求输入。缺失用量显示“未知”；页面 Token 合计是已知部分。
usage_priced 表示供应商用量 × 当次配置价格，并非供应商实付账单；reserved_estimate 表示用量缺失时的保守预留估算；reported 表示外部上报费用；legacy 表示迁移记录。订阅额度不换算为实际 API 支出。

### 上报其他工具的历史用量

POST /api/tasks/{task-id}/events 可额外传入以下字段（任务需先创建）：
    {"id":"unique-log-entry", "at":"2026-10-01T08:00:00Z",
     "provider":"provider-id", "model":"actual-model-id", "source":"claude-code",
     "input_tokens":1000, "output_tokens":200, "cached_tokens":800,
     "duration_ms":1200, "cost":0.02, "error":false}
Token 和耗时为非负整数，不知道时省略或填 null。cached_tokens 不得大于 input_tokens。费用由导入者提供，记录为 reported。
这是一套通用上报协议。Claude Code / Codex 已有独立 OTLP 适配与托管启动器，见 [编码工具接入](CODING.md)；不会自动读取供应商账号或扫描本地日志目录。导入历史事件也会经过护栏判断；建议使用专门的导入任务，不与正在运行的任务混用。代理已经记账的调用不要重复上报。

CSV 导出当前筛选下所有匹配明细，未知字段留空。API 返回 snapshot 行号上界；导出后续分页携带该值，新入账记录不会挤动旧分页。刷新后才纳入新增记录。此保证针对服务内追加写入，不支持外部工具直接修改或删除账本。

## 编码工具

新增「编码工具」页：Claude Code / Codex OTLP HTTP 接入、连接级密钥、历史导入、监测与托管控制。完整配置、价格口径、运行限制见 [CODING.md](CODING.md)。升级时 SQLite 自动增加字段与事件表；先备份 data/，仍使用单 Node 进程运行。Docker 镜像运行采集后端，本机启动器与官方 CLI 在 Mac/Linux 主机上执行。

## 在接入中心编辑配置

接入中心提供两种模式：

- **编辑部署配置**：在线预览也可打开表单，填写 DeepSeek、通义、Kimi、豆包、MiniMax 的地址、密钥、模型和单价，或飞书/企业微信 Webhook。可暂存本页草稿、分别下载 Node `.env` 或 Docker `.docker.env` 片段。Node 格式供 `node --env-file` 使用，Docker 格式供 `docker run --env-file` 使用，不是 shell 脚本，不要 source。草稿只在内存中，刷新后清除；不会请求供应商，也不表示已接通。请把下载片段合并进私有 `.env`，不要提交包含密钥的文件。
- **管理服务端连接**：在自己的 Node 服务网页输入 ADMIN_KEY 后，可编辑、保存、停用和检测。READ_KEY 只能查看脱敏状态。该入口连接网页同源后端；静态 Sites/GitHub Pages 没有配置数据库。

`npm run setup:local` 已为新环境生成加密密钥。手工配置环境时，第一次从网页保存前生成：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

把生成的 64 位十六进制值写入私有 `.env` 的 `CONFIG_ENCRYPTION_KEY`，然后重启服务。此密钥不是 ADMIN_KEY。此后在网页保存集成配置无需重启，下一次调用即使用新配置。

集成配置以 AES-256-GCM 加密存入 SQLite 的 `integration_configs` 表，密钥只在环境变量中。API 不返回原始 API Key、Webhook 或签名密钥。修改时，密钥留空保留原值；显式勾选“清除”删除原值。已保存配置优先于该供应商的环境变量；停用时也不会退回旧环境变量。加密密钥缺失或变更后配置会锁定，需要恢复原密钥，不会自动使用旧凭证。请将密钥和数据库分别备份。

状态含义：

- 草稿：尚未部署，只存在当前页面。
- 已保存：持久化且已用于代理/告警，尚未完成检测。
- 检测通过：模型列表检查通过，或机器人接受测试消息；不等于完整生成、计费或消息送达都已验证。

“检查模型列表”只对已保存的基础地址发起 GET `/models`，核对身份认证、主模型 ID 及配置的备用模型 ID，不调用聊天生成、不计入调用账本。部分兼容供应商不提供这个接口，会明确显示检查失败，需结合供应商文档进行实际调用验证。没有自动生成测试、没有自动修改单价。

“发送测试告警”会向已保存的 Webhook 发送一条 AgentGuard 测试消息。飞书支持签名密钥，企业微信按自定义机器人消息格式发送。真实异常通知与测试使用同一份生效配置。

Dify、Coze、n8n 的“编辑节点配置”可填写服务地址、任务 ID、客户、功能及策略，生成通用 HTTP 节点 JSON。它不是平台原生导入文件或插件，需在平台添加对应 HTTP 与条件节点。云端平台不能通过 localhost 访问你的电脑；使用平台可访问的私有/HTTPS 服务地址。停止/审批分支必须由工作流执行方遵守。

管理 API：

| 接口 | 权限 | 用途 |
| --- | --- | --- |
| GET /api/integrations | READ_KEY / ADMIN_KEY | 脱敏配置与状态 |
| PUT /api/integrations/:id | ADMIN_KEY | 保存 enabled、values、revision；可带 clearSecrets |
| POST /api/integrations/:id/test | ADMIN_KEY | 显式传入 confirm=true 执行检测 |

`revision` 使用读取时的版本号；其他页面已更新时返回 409，避免覆盖。配置更新会清除旧检测结果；检测进行中配置发生变化，旧结果不会覆盖新配置。

## 存储故障与恢复

账本写入失败时返回 503，内存恢复到最后成功提交的状态；后续写入与运行决策会停止服务，避免继续产生无法可靠记账的费用。先修复磁盘空间或 SQLite 权限，再重启服务；未结算预留按中断恢复规则进入对账。HTTP 503 不是调用未产生费用的保证，已经发送给供应商的请求仍可能计费。

## 发布验收

当前交付为单组织、单 Node 进程的私有部署候选版本。正式上线前须完成真实浏览器、供应商、告警机器人和编码客户端联调，以及目标服务器的持久卷与备份恢复演练。多租户公网服务不在当前认证与数据隔离能力内。完整评审与尚未放行项见源码中的 RELEASE-QA.md。
