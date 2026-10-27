# AgentGuard

智能体费用与行为控制工具。追踪任务成本，检测重复调用、连续失败和子智能体超限，并按策略停止、降级或转入人工审批。

## 能力

- Claude Code / Codex 遥测接入、历史导入、模型与项目用量对比。
- 本机托管启动器：预算/风险停止、人工确认、断连保护；Claude 调用前及子智能体启动钩子。
- SQLite 持久调用账本，自动迁移旧 JSON 数据。
- 用量历史：日期筛选、模型明细、客户/功能筛选、每日趋势、365 天热力图与 CSV 导出。
- 任务级费用归集与调用前预算预留。
- 按智能体隔离的循环检测和连续失败计数。
- 根任务累计唯一子智能体上限。
- 客服、研究和内容三种费用策略，数据库保存、版本冲突检查和变更审计。
- 总览、任务追踪、风险审批、成本分析与费用策略使用真实服务端数据；统一管理员／只读登录。
- 按客户、产品功能统计总成本、成功率和成功任务成本。
- 接入中心可编辑、加密保存、停用和检测模型/告警配置；静态预览可编辑并下载部署配置片段。
- 模型兼容代理配置：DeepSeek、通义千问、Kimi、豆包、MiniMax。
- Dify、Coze、n8n HTTP 接入示例；飞书、企业微信机器人告警。

## 快速开始

需要 Node.js 20.19 或更新版本。

`.nvmrc` 固定为已验证的 20.19.6；使用 nvm 时先执行 `nvm use`。SQLite 通过 `better-sqlite3` 访问，切换 Node.js 主版本后请重新执行 `npm ci` 安装对应的原生模块。

```bash
npm ci
npm run setup:local
npm run doctor
npm run start:local
```

访问 `http://127.0.0.1:8080`，使用本机 `.env` 中的 `ADMIN_KEY` 登录。完整本机流程见 [LOCAL-SETUP.md](LOCAL-SETUP.md)，Docker、模型配置与 API 示例见 [部署说明](dist/DEPLOY.md)。

Docker 本机部署：准备私有 `.docker.env` 后执行 `docker compose up -d --build --wait`。默认仅绑定 `127.0.0.1:8080`，SQLite 持久化到 `agentguard-data` 命名卷。配置与维护命令见 [Docker 本机部署](LOCAL-SETUP.md#docker-本机部署)。

## 网页与服务的边界

默认入口是同源 Node API + SQLite 控制台。总览、任务追踪、风险与审批、成本分析、费用策略、编码工具、用量历史和接入中心共用一次登录；`READ_KEY` 只能查看，`ADMIN_KEY` 可管理。密钥只保存在当前页面内存，刷新后重新登录。没有任务时显示空态，服务不可用时显示错误，不会退回模拟数据。

演练保留在独立的 `/demo.html`，数据保存在浏览器 localStorage，不会控制真实任务或调用付费模型。静态托管站点没有 Node API，不能替代本机或私有服务。部署检查项只是人工记录，不是自动完成部署的证明。

策略修改作用于新建通用任务和新建编码连接，已有任务、已有编码连接保留创建时的策略快照；编码连接显式填写的预算和动作优先。停止、审批、完成与策略变更留下管理员或摄入角色的审计记录。接入步骤和检测边界见 [编码工具接入](dist/CODING.md)。

服务使用 SQLite WAL 及事务保存状态和调用记录，当前预算协调仍限单进程。多租户或多副本部署需要集中预算协调、租户权限与凭证管理。模型代理支持非流式文本请求；供应商计费差异、在途请求和不确定结算意味着不能承诺绝对零超支。具体限制见部署说明。网页保存接入配置还需设置 CONFIG_ENCRYPTION_KEY，详见部署说明的“在接入中心编辑配置”。

## 测试

```bash
npm test
npm run smoke:local
```

测试覆盖引擎规则、权限、事件幂等、并发预算预留、降级、停止与恢复，以及页面表单、筛选和演练。上游服务使用本地模拟，不消耗 API 费用。DOM 测试不替代真实浏览器和外部服务联调。

## 目录

```text
dist/index.html       控制台入口
dist/app.mjs          真实控制台、统一会话与页面交互
dist/demo.html        独立演练入口
dist/demo-app.mjs     浏览器本地演练
dist/engine.mjs       浏览器与服务共享的检测引擎
dist/console.css      控制台视觉样式
dist/usage-ui.mjs     用量页面与只读 API 连接
dist/coding-ui.mjs    编码工具接入与活动页面
telemetry.mjs         OTLP 解码与两个客户端的事件归一化
coding.mjs            连接、权限、遥测事务与控制决策
scripts/setup-local.mjs 本机配置初始化
scripts/start-local.mjs 本机启动（读取 .env）
scripts/doctor.mjs     本机环境与连接诊断
scripts/local-smoke.mjs 隔离联调（临时数据与本地上游）
scripts/check-provider.mjs 显式开启的真实模型小额请求
scripts/guard-run.mjs 本机托管启动器
scripts/claude-hook.mjs Claude 调用前与子任务启动钩子
ledger.mjs            SQLite 持久账本、迁移与查询
server.mjs            API、模型代理与告警
test.mjs              引擎回归测试
http-test.mjs         API 回归测试
proxy-test.mjs        模型代理与恢复测试
ui-test.mjs           DOM 交互测试
```

请勿提交 `.env`、供应商密钥、Webhook 或运行数据。示例配置仅包含占位内容。

## 功能验收

执行 `npm ci && npm test`。入口覆盖、已修复问题及真实浏览器／供应商接入的验证边界见 [TESTING.md](TESTING.md)。

上线前复审结论与未放行条件见 [RELEASE-QA.md](RELEASE-QA.md)。五个核心页面已接入服务端；当前仍是单组织私有部署的预发布候选版本，需在目标电脑完成真实浏览器、供应商及 Claude/Codex 联调后再部署服务器。
