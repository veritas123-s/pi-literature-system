# 云端与远程执行部署

云端只保存任务、进度、核验片段、已提交报告和短期上传资料。Windows 执行端主动连接云端，模型密钥留在执行端。GitHub Pages 运行静态网页，任务服务部署在独立服务器。

## 启动云端

1. 创建 GitHub OAuth App，回调地址填写 `https://你的服务域名/auth/github/callback`。复制 `.env.example` 为 `.env`，填入服务地址、完整网页地址、允许登录的 GitHub 账户和 OAuth 凭据。
2. 创建 `data/cloud`，将目录所有者设为容器中 node 用户（UID 1000）。从 `deploy` 目录执行 `docker compose up -d --build`。
3. 使用反向代理提供 HTTPS，并转发到本机 `127.0.0.1:8787`。配置请求体上限至少 100 MiB；浏览器页面地址必须与 `CLOUD_WEB_URL` 完全一致。
4. 登录网页并创建执行端，保存页面仅显示一次的执行端 token。将 workerId 和 token 配置到 Windows 执行端；token 不写入 Git 仓库。

云端 SQLite 和对象文件须同时备份。首版只运行一个云端实例，不能把同一数据库放在多个容器或共享网络文件系统。容器重启不会自动重跑已经失去租约的任务；同一执行端显式恢复任务后，执行版本递增，旧版本无法继续写入。

OAuth 使用浏览器绑定的随机 state、S256 PKCE、服务端 GitHub 令牌交换和 60 秒单次票据。GitHub 令牌不会发送给网页；网页持有 1 小时自有会话 token，退出后撤销。回跳地址和账户都有明确允许名单。`CLOUD_DEV_AUTH` 默认关闭；公开绑定拒绝开启开发登录。协议参数可查阅 [GitHub 官方文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

研究所有权使用 GitHub 数字账户 ID。允许名单中的登录名首次成功登录后绑定该 ID；同名但不同账户会被拒绝，避免用户名变更后继承旧研究资料。网页仍显示登录名。

## 本地联调

在项目根目录安装依赖后，设置 `CLOUD_HOST=127.0.0.1`、`CLOUD_DEV_AUTH=true`、`CLOUD_WEB_URL=http://localhost:5173/`，再执行 `npm run cloud`。开发登录由网页主动操作，不能用于公开部署。

## API 约定

浏览器携带 `Authorization: Bearer <session>`；执行端使用独立 `Authorization: Bearer <workerToken>`。两种凭据不可互换。所有研究路径都检查账户所有权。

| 能力 | 路径与输入 |
|---|---|
| 身份 | `GET /auth/github/start` → GitHub → `/auth/github/callback` → 网页 `#ticket=...`；`POST /auth/ticket {ticket}` → `{token,ownerId,expiresAt}` |
| 任务 | `GET /api/runs` → `{runs,workers}`；`POST /api/runs` 输入 RunSpec，可加 deferStart:true 创建 draft，上传后 `POST /api/runs/:id/start`；`GET /api/runs/:id` → `{run}` |
| 控制 | `POST /api/runs/:id/commands {kind,payload?}`；kind 为 pause/resume/cancel/scope；scope 允许 topic/focus/cutoffDate/sources |
| 事件 | `GET /api/runs/:id/events?afterSeq=0`，默认当前执行版本最新 500 条；`allEpochs=true` 返回全部版本最新 1000 条 |
| 资料 | `POST /api/runs/:id/uploads`，multipart file，PDF/RIS/BibTeX，仅 draft/queued/paused 接受；`GET /api/runs/:id/uploads` |
| 成果 | `GET /api/runs/:id/artifacts` → `{manifest}`；`GET /api/runs/:id/artifacts/:version/:name`；`GET /api/runs/:id/bundle` |
| 配对 | `POST /api/workers {name?}` → `{workerId,workerToken}`，token 仅返回一次 |
| 领取 | `POST /worker/claim` → `{run,checkpoint}`；任务空时 run 为 null |
| 续租 | `POST /worker/runs/:id/heartbeat {epoch,phase?,progress?}` → `{run,commands}` |
| 事件与检查点 | `POST /worker/runs/:id/events {epoch,events}`；seq 从 1 开始连续递增；`POST /worker/runs/:id/checkpoint {epoch,checkpoint}`，checkpoint 仅允许 phase/scopeVersion/localCheckpointHash/localState:true/workerId/lastEventSeq |
| 指令确认 | `POST /worker/runs/:id/commands/:commandId/ack {epoch,status,pauseAfterApply?}`，status 为 received/applied；scope 加 pauseAfterApply:true 原子更新版本并暂停 |
| 恢复 | `POST /worker/recover {runId,previousEpoch}`，同一执行端显式恢复，返回新 epoch 和检查点 |
| 状态 | `GET /worker/runs/:id/status`，仅归属执行端读取，返回 status/epoch/workerId/leaseUntil，可用于响应丢失后的完成判定 |
| 同步成果 | `POST /worker/runs/:id/artifacts/:version/:name`，原始字节，Content-Type 必须为 application/octet-stream；X-Run-Epoch 标识执行版本，X-Artifact-Mime 标识真实格式 |
| 结束 | `POST /worker/runs/:id/complete {epoch,status,manifest,gaps?}`，先核对全部上传文件哈希，再原子提交成果与最终状态 |
| 失败 | `POST /worker/runs/:id/fail {epoch,error,gaps?}`，保留检查点，记录简短错误并释放租约，不要求报告清单 |
| 接收导入 | `GET /worker/runs/:id/uploads?epoch=N` 与 `/uploads/:uploadId?epoch=N`；`POST /uploads/:uploadId/received {epoch,sha256}` 校验成功后清除云端暂存 |

重复事件仅接受相同内容；不允许跳过事件序号。暂停与取消显示请求状态，执行端确认后才改变实际运行状态。暂停请求期间继续允许续租、事件和检查点；applied 确认后释放租约。resume 将任务重新排队，下一次领取递增 epoch；含本地检查点的任务固定原执行端。取消指令优先，同一待确认控制请求不会重复创建。尚未领取的排队任务可以由云端直接暂停或取消。已提交成果不可覆盖，下载前必须通过完整清单提交。

## 部署验证边界

腾讯云Windows部署已验证真实GitHub登录、TLS、任务领取、成果回传和私有下载；完整记录见VALIDATION.md。自动测试另行验证权限、租约、事件、指令与成果提交逻辑。Docker部署、最大尺寸上传、跨网络故障、重启和长期运行仍待环境验证。
