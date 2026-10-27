# 本机启动与联调

先在本机完成验收，再部署服务器。下列启动命令不会发布站点、推送 GitHub 或自动调用收费模型。

## Docker 本机部署

需要 Docker Engine 和 Docker Compose 2.30+。macOS 可使用 Docker Desktop，或安装 Docker CLI、Compose、Buildx 和 Colima 后运行 `colima start`。

首次部署需要私有 `.docker.env`。可按 `.env.example` 的字段填写，至少配置 `ADMIN_KEY`、`INGEST_KEY`、`READ_KEY`、`CONFIG_ENCRYPTION_KEY` 四个不同的随机密钥（建议各 32 字节的十六进制字符串），并将文件权限设为 `600`。本次本机部署已生成该文件；升级时保留原文件，尤其是加密密钥。使用 `KEY=value` 字面值格式，不要添加外围引号；文件已被 Git 和 Docker 构建上下文排除。

```sh
cd /Users/luhui.xie/AICost
docker compose up -d --build --wait
docker compose ps
```

访问 **http://127.0.0.1:8080**，在本机编辑器打开 `.docker.env`，复制 `ADMIN_KEY` 登录。端口只绑定本机；需要改端口时使用 `AGENTGUARD_PORT=8088 docker compose up -d --wait`。

```sh
docker compose logs --tail=100 agentguard
docker compose restart agentguard
docker compose down
```

SQLite 保存在 `agentguard-data` 命名卷中，独立于直接运行 Node 时的本地 `data/`。容器重建、重启和 `docker compose down` 保留数据；不要使用 `down -v` 删除数据卷。备份时保存整个卷和原 `.docker.env`，不得提交到 GitHub。电脑重启后需启动 Docker 或 `colima start`，容器按 `unless-stopped` 策略恢复运行。

## 准备与启动

在本机已合并本次代码的仓库执行。若下载的是完整源码包，先解压到新目录，再合并到现有仓库；保留已有未提交改动、`.env` 和 `data/`。

```sh
cd /Users/luhui.xie/AICost
node --version
npm ci
npm run setup:local
npm run doctor
npm run start:local
```

需要 Node.js 20.19 或更新版本。`setup:local` 在没有 `.env` 时生成四个不同的随机密钥，并设置文件权限为 `600`。已有 `.env` 不会被覆盖；已有数据库但缺少 `.env` 时会停止，要求恢复原加密密钥。

使用 nvm 时先执行 `nvm use`，仓库固定为 20.19.6。`npm ci` 会安装 SQLite 原生依赖 `better-sqlite3`；切换 Node.js 主版本后需重新安装。没有对应平台预编译包时，需要 Python 3 和 C/C++ 编译工具，详见部署说明。

使用本机编辑器打开 `.env`，复制 `ADMIN_KEY` 的值。打开 **http://127.0.0.1:8080**，把密钥填入网页登录框。密钥留在本机，不要提交到 Git 或粘贴到聊天中。

另开一个终端执行：

```sh
cd /Users/luhui.xie/AICost
npm run doctor -- --check-server
```

成功时 `server.authenticated` 为 `true`。诊断只显示密钥是否存在、客户端版本及连接状态，不输出密钥。Claude Code / Codex 版本可读取，不代表遥测已经联通。

默认只监听 `127.0.0.1`，数据写入本仓库的 `data/agentguard.sqlite`。从别的目录启动也不会另建账本。旧 `.env` 没有 HOST 时，启动脚本仍使用 `127.0.0.1`。修改 `.env` 中的 `PORT` 可换端口；终端环境的同名变量优先。只有准备对外部署时才显式设置其他 HOST。CONFIG_ENCRYPTION_KEY 缺失或无效会使 doctor 返回失败；已有账本时应恢复原密钥。

后端没有任务时，真实页面显示空态。登录失败、服务未启动或断网应显示错误，不应自动出现演练任务。检查只读权限时，退出后用 `READ_KEY` 登录。

## 不收费的隔离联调

```sh
npm test
npm run smoke:local
```

`smoke:local` 启动一次性本地服务、临时 SQLite 和 loopback 模型替身，验证网页与 API 同源、管理员和只读权限、代理计费、预算审批和停止，以及五个控制台 API。结束后清理自己创建的临时目录和进程。

它不读取你的 `.env`、不修改实际 `data/`、不调用供应商、不发送群消息。通过这一步不代表真实模型或 CLI 联调通过。

## 在本机接入真实模型

1. 保持本机服务运行，打开“接入中心”。使用管理员连接，在“管理服务端连接”填写一家供应商的地址、API Key、准确模型 ID 和实际单价。
2. 保存后检查模型列表。配置备用模型时同时核验备用模型。部分供应商不支持 `/models`，需按其文档核对生成接口。
3. 在“费用策略”设置小额测试预算，使用专门的测试客户和功能名。真实测试可能产生费用，先核对预算和单价。
4. 通过下面的显式小额检查命令完成一次最短文本请求，核对任务详情、用量历史、成本分析及供应商返回的 Token。保留任务 ID，重复上报同一事件时检查幂等；模型生成请求本身不要自动重试。
5. 验证预算停止、人工审批和备用模型降级。停止不会撤销已发送请求的费用。

服务运行且供应商已保存后，另开终端执行（**会调用真实模型，可能产生费用**）：

```sh
npm run check:provider -- --provider DEEPSEEK --budget 0.1 --confirm-paid-request
```

可将 DEEPSEEK 替换为 QWEN、KIMI、DOUBAO 或 MINIMAX。命令读取本机 `.env` 的管理／摄入密钥，使用已保存的供应商配置，创建独立“本机联调／供应商连通性”任务，只发送一条最多 16 输出 Token 的请求，不自动重试。默认地址按 `.env` 的 PORT 组合，也可用 `AG_URL` 指定本机 origin。预留超过预算时拒绝发送；预算是风险控制阈值，不能保证最终账单绝不超出。模型不支持该请求参数时会报错，不能把它记作通过。

命令成功后仍需在网页核对金额、模型和任务状态，并与供应商用量对账。未传 `--confirm-paid-request` 不执行请求。自动测试和隔离 smoke 仅访问本地模型替身，不调用真实供应商。

模型 API 示例见 `dist/DEPLOY.md`。密钥保存在本机服务端的加密配置中。Node `.env` 与 Docker `.docker.env` 格式不同，当前本机启动使用 Node 格式。

## 在同一台 Mac 联调 Claude Code / Codex

1. 先确认客户端已安装且能独立完成任务：`claude --version`、`codex --version`。客户端安装和账户登录在本机完成。
2. 在“编码工具”先创建“只监测”连接，填写模型价格或汇率、项目及客户。保存一次性密钥，按弹窗设置本机遥测。
3. 运行一个小任务并刷新网页，核对客户端、会话、模型、Token、费用及检测覆盖。没有收到遥测时，检查客户端版本和本机日志，不能算验收通过。
4. 再创建“本机托管”连接，用弹窗的 `guard-run.mjs` 命令执行非交互任务。任务必须由此启动器启动，才有可验证的进程停止控制。
5. 测试停止、预算转人工、审批后人工重启、连接撤销和服务断开保护。页面必须显示启动器实际停止确认；仅有“停止决策”不能证明进程已退出。

完整命令和边界见 `dist/CODING.md`。`AG_CONNECTION_TOKEN` 填写对应连接的一次性密钥；模型供应商凭证仍由官方客户端自己使用。

## 浏览器验收与服务器迁移

本机逐页检查真实数据、表单校验、刷新、重复点击、断网恢复、只读角色和导出内容。飞书／企业微信使用测试群明确发送一条消息并确认收到；工作流平台验证 stop / approval 分支不会继续调用模型。

通过后再迁移：备份整个 `data/` 和原 `CONFIG_ENCRYPTION_KEY`，配置 HTTPS 与持久卷、不同的生产访问密钥，使用单 Node 进程。迁移前停止写入或采用 SQLite 一致性备份，不要只复制运行中的主数据库文件。服务器部署和真实外部联调不由 smoke 命令自动执行。
