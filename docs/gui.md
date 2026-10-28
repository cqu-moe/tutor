# 本地浏览器工作台

运行 `tutor gui`，在本机浏览器管理课程。GUI 与 CLI 共用同一份课程资料、教学路线、学习者记忆和导出文件。

```sh
tutor --env-file "$HOME/.config/tutor/env" gui --ocr mistral --data-dir .tutor
```

默认打开 `http://127.0.0.1:4318`。`--port` 可改端口，`--port 0` 自动分配空闲端口；`--no-open` 只打印地址。按 Ctrl+C 停止。`--agent-dir`、`--model`、OCR 服务地址及显式环境文件的语义与 CLI 一致，已有环境变量优先。发行版已内嵌界面资源，运行时无需 Node.js、pnpm 或网络前端服务器。

## 操作流程

1. 在「导入课程资料」填写课程名，选择 PDF，并指定物理页码或完整书签标题。可添加最多 12 张 PNG/JPEG/WebP 截图；单次文件合计最多 120 MB。
2. 资料解析后，在课程详情查看教学路线。可提交调整意见，或「保存路线，稍后继续」。确认前不会生成讲解稿。
3. 点击「确认并生成讲解稿」。完成后可阅读文字预览，下载完整 PDF、Markdown、Typst、图片和图表源文件。
4. 在「讲解稿」提交局部反馈，修订成功后更新导出；失败沿用 CLI 的暂存和已发布文件保护。新资料尚未确认时仍可下载上一次导出。
5. 「学习反馈」用于保存或查询学习者记忆。「环境与配置」运行本地 doctor，不调用模型/OCR，也不校验在线凭据有效性。

刷新或关闭浏览器不停止任务。重启 GUI 会结束其子进程，但已经保存的教学路线可以继续确认；已确认路线可重新生成。运行中不要同时用另一个 CLI/GUI 进程写同一课程目录。

## 边界

- 服务只监听 `127.0.0.1`，拒绝不匹配的 Host、跨站 Origin 和缺失的会话标识；不提供远程访问配置。每次重启后刷新页面以获取新会话。
- GUI 一次执行一个任务，避免并发写入和沙箱状态冲突。原有 CLI 仍可独立使用。
- 上传的资料按现有流程发送至所选 OCR/模型服务；凭据只由本地环境和 Pi 配置读取，页面不提供凭据编辑。
- 浏览器文字预览不执行 HTML 或载入外部图片；数学公式、表格和插图以导出的 PDF 为准。
- 运行日志最多保留最近 32,000 个字符，任务状态只在当前 GUI 进程中保留，课程资料与输出保存在磁盘。

## 开发

后端继续使用 Bun 1.4.4+。前端由 CQU Moe Design 生成器创建，保留其独立 pnpm 11.19.0、Node.js 22.12+ 工具链和锁文件；`.design/` 包随源码提交。

```sh
bun install --frozen-lockfile --ignore-scripts
cd gui
pnpm install --frozen-lockfile
pnpm build
pnpm check:design
cd ..
bun run gui --no-open
```

前端修改后重新 `pnpm build` 并重启 GUI。独立的 Vite 开发服务器没有 Tutor 会话，不作为可用工作台入口。`bun run build` 会先构建前端，再将其编入所有请求的可执行文件。GUI HTTP 集成测试在 `test/gui.test.js`；同样支持 `TUTOR_TEST_BINARY` 验证打包产物。
