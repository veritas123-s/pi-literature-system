# 文献调研工作台

在项目根目录运行 `npm run web`，打开 `http://127.0.0.1:5173/`。首次连接填写云端服务地址，再使用允许登录的 GitHub 账户登录。网页只保存服务地址；登录凭据和新生成的执行端凭据只保留在当前页面。

页面包含任务创建、资料上传、预算与检索截止日期、任务列表、执行端在线状态、四类 Agent 活动、运行事件、检查点、指令确认、报告、证据库、研究范式、覆盖与纳排记录、独立核验和文件下载。

资料先上传到准备状态的任务，全部上传成功后才启动调研。上传失败时保留任务，可补传后点击“开始调研”。已开始任务需要先暂停并等待执行端确认，随后补传资料、继续运行。

生产服务必须使用 HTTPS。本机开发只允许回环地址 HTTP；“本机开发登录”和“添加工程测试资料”两个入口仅存在于开发页面，并且本机开发登录还需要云端显式启用。浏览器刷新后重新登录。

## 静态网页发布

`npm run build:web` 生成 `web/dist/`。可以设置公开配置 `VITE_API_URL` 和 `VITE_BASE_PATH`，例如 `/pi-literature-system/`。这些变量不得包含密钥。云端的 `webUrl` 必须与网页最终 URL 完全一致，包括目录末尾的 `/`。

独立仓库中的 `.github/workflows/pages.yml` 只能手动触发。在仓库设置中选择 GitHub Actions 为 Pages 发布来源，并按需设置公开变量 `RESEARCH_API_URL`。仅前端静态文件被发布，研究资料与后端凭据保留在私有服务和本地执行端。

## 验证与工程演示

自动验证：`npm run check`、`node --import tsx --test test/web-api.test.ts test/web-security.test.ts`、`npm run build:web`。

工程演示使用独立的本机云端，设置 `CLOUD_DEV_AUTH=true`、`CLOUD_DEV_OWNER_ID=web-ui-test-owner`、`CLOUD_PORT=4326`、`CLOUD_PUBLIC_URL=http://127.0.0.1:4326`、`CLOUD_WEB_URL=http://127.0.0.1:5173/` 和独立的 `CLOUD_DATA_DIR`。网页开发登录后创建标题含“工程”的测试任务，可使用“添加工程测试资料”按钮测试 multipart 上传。

自动HTTP用例位于test/web-api.test.ts，覆盖准备资料、启动、暂停确认、继续和私有附件下载。本轮桌面/窄屏人工浏览器验收另使用本地忽略目录中的工程客户端，模拟产物与角色事件不进入生产包；这些检查不调用模型，也不作为科学性能评估。
