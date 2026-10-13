# 现有腾讯云 Windows 服务器的独立部署

此部署为现有腾讯云 Windows Server 2025（122.51.44.155，实例 ins-32j78kub）准备独立服务。API 只监听 `127.0.0.1:4326`，使用新的 `C:\ProgramData\PiLiteratureCloud\data`；计划任务以 LOCAL SERVICE 身份运行。现有应用目录、防火墙、安全组和代理配置不由脚本改写。

本实例已于2026-10-13完成独立部署、GitHub OAuth登录和Windows执行端配对。以下步骤用于复现或迁移；安装脚本默认仅做预检查，缺少认证设置时不能注册启动任务。云服务启动与代理应用使用单独的显式步骤。

1. 通过 Tencent CVM Orca 控制台进入这台服务器。用独立应用目录放置本项目、安装 Node.js 22.19 或更新版本并执行 `npm ci`。应用目录应包含依赖，管理员保留写权限。
2. 在私有目录创建 `service.env`，参考示例设置。GitHub OAuth 回调应为 `https://122.51.44.155/literature/auth/github/callback`；若改用域名，更新 API 地址及回调。GitHub Pages 地址填写完整子路径，以 `/` 结尾。
3. 先执行 `install-cloud.ps1 -ProjectPath <独立应用目录>`。确认检查结果后，在管理员 PowerShell 使用相同参数，加上 `-SecretEnvFile <私有文件> -Install` 注册 `PiLiteratureCloud` 计划任务。任务不会立即运行。
4. 审阅 `Caddy.literature.fragment`，将 API 路由合并到已有 HTTPS site block 的合适位置。现有 catch-all 路由可能影响顺序，必须先检查原配置。使用 Caddy 的验证命令核验完整配置后，再按原服务器的管理流程重载。GitHub Pages 的网页不需要静态网页块。
5. 手动启动计划任务，在服务器上检查 `http://127.0.0.1:4326/health`，再核验外网 `/literature/health`、OAuth 回调及浏览器上传。配置网页 API base 为 `https://122.51.44.155/literature`，执行端 cloudUrl 使用相同地址。浏览器任务路径为 `/literature/api/runs`，执行端路径为 `/literature/worker/claim`。

只停止 `PiLiteratureCloud` 计划任务即可停止新 API。回退代理时仅删除本次新增的路由片段，保留原服务；停止或回退不会清理数据。数据与 `cloud.sqlite`、WAL 文件、对象目录一起备份，私有环境文件另行保管。

LOCAL SERVICE 仅获得应用目录读取与独立数据目录修改权限。安装脚本拒绝被占用端口、同名任务及无项目标记的既有数据目录。私有环境文件不会写入源码、网页或 Git 仓库。

安装脚本已在本实例执行；任务调度、ACL、Caddy 路由、外网TLS与真实GitHub登录已检查。跨网络零模型调用任务完成领取、检查点、报告回传及私有下载，下载哈希与本机原件一致。重启和长期运行仍需实际验证。详情见根目录VALIDATION.md。

代理前缀由 [Caddy handle_path](https://caddyserver.com/docs/caddyfile/directives/handle_path) 去除，OAuth 回调 cookie 同时保留外部 `/literature/auth` 路径。上传上限片段使用 [request_body](https://caddyserver.com/docs/caddyfile/directives/request_body)，合并前应核对服务器现有 Caddy 版本并验证配置。
