# Pi 文献调研系统

输入医学与生命科学研究主题，系统自动检索、阅读原文、建立证据关联、归纳研究范式并核验报告。GitHub Pages 是远程控制台，云端保留队列和私有成果，Windows 执行端承担模型与文献处理。电脑离线时任务等待，不显示为继续执行。

已部署工作台：https://veritas123-s.github.io/pi-literature-system/ 。云端：https://122.51.44.155/literature 。当前Windows执行端已配对并后台运行，登录工作台即可创建任务。科学质量目标仍需独立评估。

## 安装与运行

需要 Node.js 22.19 或更新版本、Python（pdfplumber、pypdfium2、reportlab）和中文字体。项目锁定 Pi 1.0.2。

```powershell
npm ci
npm run check
npm test
npm run build:web
```

复制 config.example.json 为 config.local.json，设置本地数据目录、模型和导出运行时。只保留准备使用的模型配置。codex-cli 模式使用已安装 Codex 的正常登录，不复制认证文件；兼容 API 模式通过环境变量读取密钥。

```powershell
npm run doctor
npm run research -- --topic "研究主题" --focus "关注的问题"
```

本地报告位于配置的数据目录下各任务的 artifacts 目录。中断后用 `--resume 任务ID` 接续相同输入。已记录但结果未知的请求默认不重试，需先核对私有请求台账；已落盘响应可恢复，不再次计为新调用。

## 远程使用

部署云服务并配置 GitHub OAuth 后，在网页完成登录、配对执行端。执行端凭据只在配对时返回一次，放入本机环境变量 `PI_LITERATURE_WORKER_TOKEN`，配置 workerId/cloudUrl，再运行 `npm run worker`。凭据不进入 GitHub 或浏览器永久存储。

当前电脑已保存受限的 `runtime/worker-token.dpapi`，只有同一Windows用户可以解密。双击 `Start-Pi-Literature.cmd` 可重新启动后台执行端；已运行时不会再开一个。此启动方式不更改系统执行策略。电脑重启后需重新启动；休眠或短时断网恢复后，仍存活的执行端会继续连接。其他电脑需重新配对。

网页新建任务先保留草稿，资料上传完成后才启动。运行中补资料先暂停，待执行端确认后上传，再继续。调整范围产生新版本，保留旧证据和报告。暂停在安全边界停止新增调用，取消会终止在途调用；取消和断网可能留下未知用量。

云端安装参见 deploy/README.md 和 deploy/windows/README.md。既有 Windows 云服务器使用新服务、loopback 4326 和独立数据目录，HTTPS 代理只增加 /literature/ 路由。GitHub OAuth 回调为外部 API 地址加 `/auth/github/callback`，不授予仓库操作权限。

## 输出与证据

报告提供领域地图、概念与脉络、主要结论、共识与争议、范式比较、知识缺口和阅读路线。HTML、DOCX、PDF 共用相同论断与引用图；附带题录、筛选、检索、证据、审计和范式表。未核验身份、排除或未实际引用的文献进入候选清单。

四类 Agent 是检索研究员、证据分析员、综合研究员和独立审计员。每次任务会话独立，所有角色复用同一模型配置。程序控制阶段、原文权限、三个请求并发上限和预算。摘要、全文获取、实际读取及图像核验分别记录。

完整原文、请求台账和模型凭据留在本地；模型所需片段发送给配置的服务商。云端只有私有报告、必要引用片段、任务状态和不含正文的检查点。美元费用未获供应商或已核实价格时显示未报告，Token 用量按实际回执累计。

## 验证状态

tests 覆盖真实 Pi 工具循环的工程夹具、权限、恢复、租约、暂停确认、文件清单、导入、检索分页和引用安全。scripts/live-search.ts 检查公开接口；scripts/live-pi.ts 检查真实模型工具调用和逐字原文引用。

这些检查不证明科学质量。四领域单 Agent 与四 Agent 的对照入口在 scripts/benchmark.ts，必须另行准备独立保留集和人工复核，缺资料时拒绝评分。当前科学质量阈值属于待验证目标。详见 docs/benchmark.md 与 VALIDATION.md。
