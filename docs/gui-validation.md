# GUI 验收记录

## 0.2.0 最终审查修复验收（2026-11-02）

主集成执行者独立使用 Ego Lite / Chromium 和搬移后的 macOS ARM64 原生程序验证了本次修改。课程写入、GUI HTTP、磁盘状态及刷新读回为实际执行；歧义章节为合成 fixture，模型/OCR 为 localhost 响应。通过 CDP 增加 4 秒传输延迟观察待完成状态，没有替换业务响应。下方旧记录仅证明各自基线，不能单独验证本次 GUI 修改。

- 旧版重名提交没有字段关联，编辑后残留页面错误。本次错误聚焦章节名输入，并通过 `aria-invalid`、`aria-describedby` 关联行内说明；编辑后清除错误。真实保存时输入只读、按钮 `aria-busy=true`，焦点保留，成功后的章节名经刷新确认。后端重名文案仍为「请求格式无效。」，本次修复的是字段关联和反馈生命周期。
- 任务尚待确认时标记进度，实际冲突显示为行内错误与重试状态；取消任务后，进度写入成功并经刷新保留。进度、取消和空课程创建均实际观察到忙碌按钮与焦点保留，成功结果经页面重载读回；创建后进入新课程。没有用待完成状态或演示计时器冒充成功。
- 章节错误、待确认任务和已取消任务共 24 张矩阵截图均已查看，所有宽度均无横向溢出。待确认截图有部分主题过渡帧，未纳入本次提交；下表保留章节错误和等待有限 CSS 动画结束后重拍的已取消截图，共 16 张。
- 768/390/320px 使用粗指针模拟，操作高度至少 44px、章节输入字号 16px；1440px 细指针保持共享组件的 32/40px 尺寸。390px 减少动态效果下导航可由 Escape 关闭，焦点返回「打开导航」。

| 宽度 | 章节名错误 | 已取消任务（稳定主题） |
| --- | --- | --- |
| 1440px | [浅色](gui/screenshots/review-fixes/title-error-1440-light.png) / [深色](gui/screenshots/review-fixes/title-error-1440-dark.png) | [浅色](gui/screenshots/review-fixes/task-cancelled-1440-light.png) / [深色](gui/screenshots/review-fixes/task-cancelled-1440-dark.png) |
| 768px | [浅色](gui/screenshots/review-fixes/title-error-768-light.png) / [深色](gui/screenshots/review-fixes/title-error-768-dark.png) | [浅色](gui/screenshots/review-fixes/task-cancelled-768-light.png) / [深色](gui/screenshots/review-fixes/task-cancelled-768-dark.png) |
| 390px | [浅色](gui/screenshots/review-fixes/title-error-390-light.png) / [深色](gui/screenshots/review-fixes/title-error-390-dark.png) | [浅色](gui/screenshots/review-fixes/task-cancelled-390-light.png) / [深色](gui/screenshots/review-fixes/task-cancelled-390-dark.png) |
| 320px | [浅色](gui/screenshots/review-fixes/title-error-320-light.png) / [深色](gui/screenshots/review-fixes/title-error-320-dark.png) | [浅色](gui/screenshots/review-fixes/task-cancelled-320-light.png) / [深色](gui/screenshots/review-fixes/task-cancelled-320-dark.png) |

待完成状态另见 [取消任务](gui/screenshots/review-fixes/task-cancelling-320-dark.png)、[保存进度](gui/screenshots/review-fixes/progress-saving-320-dark.png)。章节保存和空课程创建的待完成断言来自 DOM 读回及成功后刷新验证；没有使用误命名的章节保存截图或未拍到提交按钮的创建截图证明忙碌状态。

本次验收源码 SHA256：

| 路径 | SHA256 |
| --- | --- |
| `gui/src/course.tsx` | `bcb2d821029b04b52e77ae958e04a8564fa5a86c2516d77a33f665d7a9475c31` |
| `gui/src/main.tsx` | `2a498b4ef283cda90165e333067375e076ddd1812a2e72e723b69d6f209daae7` |
| `gui/src/status.tsx` | `f885619d4e274db4c4b8975ece208ccaf212298862f5d0aae9192ad7680950f8` |

原生程序 SHA256 为 `4e200d79eead832ef5b1474c8d1a930dd675c1235a3d28a59f84c1d1ca827ed4`，GUI bundle 为 `index-DD5UxrYa.js`。同一修复的完整源码测试 51/51、移除构建依赖后的 macOS ARM64 相关原生测试 27/27、四目标构建、GUI 类型及设计检查通过；新增公共 CLI/GUI 回归验证普通导入的章节讲解与下载、受保护章节全部导出字节、截图改名去重及发布中断幂等性。

这是 Chromium 桌面与触屏/减少动态效果模拟证据；未验证真实手机、屏幕阅读器、Safari/Firefox 或真实模型/OCR 账户。其他三个目标仅在本地完成编译，新的 Linux 原生 CI 与正式发布由后续集成负责。当前浏览器证据及 DOM 收据保存在本地 `.build/verification/gui-review-fixes.md` 与 `.build/gui-review-qa/`。

## 0.2.0 教学任务基线验收（2026-11-02）

主集成执行者在 #18 最终界面上使用 Ego Lite / Chromium 完成以下实际操作；#19 复用此证据，没有重复浏览器验收或修改 GUI 源码。模型/OCR 来自 localhost fixture，课程文件、官方 Pi 任务、导出和浏览器下载为真实执行。

- 上传一页 PDF，保存路线并刷新：原任务身份保持、仍待确认，没有自动生成。
- 显式取消后刷新仍为取消；明确新建的生成任务成功。终止性模型 401 仅显示取消，不提供无效继续按钮。
- 等待与终止状态分别检查 1440/768/390/320px、浅色/深色，共 16 张完整页面截图，逐张视觉检查，所有 `scrollWidth <= clientWidth`。
- 768/390/320px 触屏模拟的输入字号 16px、任务按钮至少 44px；1440px 使用共享系统的 14px/40px。长中英文标题正常换行。
- 320px、减少动态效果下打开导航再按 Escape，焦点回到「打开导航」，无遗留滚动锁。
- 浏览器下载的真实 A4 PDF 经 `pdfinfo` 与 `pdftotext` 检查，有预期讲解文字和页码引用。

| 宽度 | 待确认 | 终止性模型失败 |
| --- | --- | --- |
| 1440px | [浅色](gui/screenshots/tasks/awaiting-1440-light.png) / [深色](gui/screenshots/tasks/awaiting-1440-dark.png) | [浅色](gui/screenshots/tasks/terminal-1440-light.png) / [深色](gui/screenshots/tasks/terminal-1440-dark.png) |
| 768px | [浅色](gui/screenshots/tasks/awaiting-768-light.png) / [深色](gui/screenshots/tasks/awaiting-768-dark.png) | [浅色](gui/screenshots/tasks/terminal-768-light.png) / [深色](gui/screenshots/tasks/terminal-768-dark.png) |
| 390px | [浅色](gui/screenshots/tasks/awaiting-390-light.png) / [深色](gui/screenshots/tasks/awaiting-390-dark.png) | [浅色](gui/screenshots/tasks/terminal-390-light.png) / [深色](gui/screenshots/tasks/terminal-390-dark.png) |
| 320px | [浅色](gui/screenshots/tasks/awaiting-320-light.png) / [深色](gui/screenshots/tasks/awaiting-320-dark.png) | [浅色](gui/screenshots/tasks/terminal-320-light.png) / [深色](gui/screenshots/tasks/terminal-320-dark.png) |

此记录覆盖桌面 Chromium 与触屏模拟。真实手机、Safari/Firefox、屏幕阅读器、真实服务及教学质量仍未验证。自动化跨重启/单文件证据见 [课程与恢复验收](acceptance.md#version-020-course-and-restart-acceptance)。

## 第一版历史记录（2026-10-28）

以下保留 PR #12 当时的工具链与截图证据。当前开发仅使用根 Bun 工作区；历史 pnpm 命令和进程内任务描述不作为当前要求。

日期：2026-10-28。

设计系统版本：`@cqu-moe/theme` 1.1.0、`@cqu-moe/ui` 1.1.0、`lucide-react` 1.48.0。前端从官方生成器创建，沿用其主题初始化、CSS 顺序、pnpm 工具链和本地发布包。

复用组件：AppShell、ContentContainer、PageHeader、PageState、Button、ActionButton、Input、Textarea、Label、Select、Tabs、Alert、ThemeMenu 和单一 Toaster。课程列表、导入表单和课程详情遵循包内页面及表单布局约定，没有复制基础控件或覆盖 `.ds-*` 内部样式。

### 自动检查

- PR #12 审查修复后，源代码 GUI 集成测试 3 项通过；macOS arm64 独立可执行文件的全套回归 14 项通过，包含真实文档导出。
- 截图命名回归先在旧实现上失败（期望 `题目-3.PNG`，实际为 `screenshot-1.png`），修复后通过。覆盖中文原名、大写扩展名、同名不同内容的两张图片、模型收到原名，以及斜杠、反斜杠和 NUL 路径拒绝。
- 其余 GUI 检查覆盖内嵌资源、本机访问限制、文件下载边界、实际 CLI 子进程导入、调整、重启后继续、确认、过期路线拒绝、关闭时上传清理和导出失败保护。
- `bun run build` 通过（包括前端 TypeScript 检查及 Vite 构建）；`pnpm check:design` 通过；`git diff --check` 通过。
- Vite 提示主 JS 分块超过 500 kB，当前压缩前约 598 kB。界面随本机可执行文件分发，暂未另做代码分割。

### 浏览器检查

使用 Ego Lite / Chromium，在真实 Bun GUI 服务上操作：

- 导入 PDF → 查看及调整教学路线 → 模拟模型失败 → 保留反馈并继续重试 → 确认 → 导出 → 浏览器下载 PDF。下载文件经检查为一页有效 A4 PDF。
- 导入页已检查 390、768、1440px 的浅色与深色，以及 320px 内容重排。本轮在修复后的打包版上，补齐教学路线和讲解稿的以下 16 组截图，并逐张查看。
- 触屏模拟下表单字号 16px、基本控件高度至少 44px；移动导航可用 Escape 关闭，焦点返回触发按钮，没有遗留滚动锁。
- 查看真实空课程页、任务进行中、路线待确认、成功、失败和已有输出状态；失败后输入内容仍保留，已发布输出可继续下载。
- 修正了业务链接样式覆盖共享主按钮文字颜色的问题；最终界面使用共享的浅灰/白色和石墨灰层次。

| 视口宽度 | 教学路线 | 已保存的讲解稿 |
| --- | --- | --- |
| 1440px | [浅色](gui/screenshots/route-1440-light.png) / [深色](gui/screenshots/route-1440-dark.png) | [浅色](gui/screenshots/lecture-1440-light.png) / [深色](gui/screenshots/lecture-1440-dark.png) |
| 768px | [浅色](gui/screenshots/route-768-light.png) / [深色](gui/screenshots/route-768-dark.png) | [浅色](gui/screenshots/lecture-768-light.png) / [深色](gui/screenshots/lecture-768-dark.png) |
| 390px | [浅色](gui/screenshots/route-390-light.png) / [深色](gui/screenshots/route-390-dark.png) | [浅色](gui/screenshots/lecture-390-light.png) / [深色](gui/screenshots/lecture-390-dark.png) |
| 320px | [浅色](gui/screenshots/route-320-light.png) / [深色](gui/screenshots/route-320-dark.png) | [浅色](gui/screenshots/lecture-320-light.png) / [深色](gui/screenshots/lecture-320-dark.png) |

教学路线使用长中英文课程名，包含等待确认状态、调整表单和稍后继续入口。16 组的 `scrollWidth` 均不超过 `clientWidth`；768/390/320px 开启触屏模拟，输入字号 16px，确认、保存、调整与修订按钮高度 44px。1440px 精细指针下为共享系统默认的 14px/40px。截图覆盖完整滚动页面，桌面滚动条会占用 15px 宽度。

320px 下实际提交路线调整、保存并刷新后继续；减少动态效果模式下，导航 Escape 关闭后焦点返回「打开导航」，没有遗留滚动锁；「跟随系统」响应系统明暗切换，刷新保留选择。

### PR #12 审查项

1. **验收证据**：补齐上述视口/主题矩阵。检查中发现任务状态栏的长英文课程名会把 320px 页面撑到 337px；添加业务文本换行后，实际宽度恢复为 320px，核心操作完整可达。
2. **图标尺寸**：课程列表 `FileText` 改为 16px；浏览器读回两行图标均为 16×16px。[320px 列表截图](gui/screenshots/courses-320-light.png)。
3. **测试耦合**：移除对生成提示词固定英文措辞的断言，保留实际请求次数、确认持久化、导出失败及旧输出保全检查。
4. **截图来源名**：每张上传图片在独立临时目录中保留原文件名，由既有 CLI 写入课程来源元数据；同名图片不互相覆盖，文件名不能携带路径或 NUL。

接口验证分层：OCR 和模型响应来自本地 fixture；HTTP 服务、CLI 子进程、磁盘持久化、Recto/Pandoc/Typst 导出及浏览器下载为实际执行。没有调用真实在线 OCR 或模型账户。

设计系统反馈：未发现需要修改共享组件的问题，未创建外部 issue。设计例外：无共享组件分叉；Markdown 预览只供阅读文字，完整数学、表格及插图通过 PDF 查看。

待人工验收：真实手机、Safari/Firefox、屏幕阅读器、首帧及动效体感；未调用真实在线模型/OCR 账户。远程构建与 Linux 原生测试结果以 PR 最新提交的 Actions 检查为准；其他平台的原生运行及 macOS 签名不属于本次验收。
