# Tutor

组合现成工具的个人课程讲解 Agent：读取课程资料和学习者记忆，先对齐教学路线，再生成能够独立阅读、替代指定范围课件的讲解稿。

CLI 与本地浏览器工作台可从课程 PDF 生成可重建的讲解稿。安装依赖后，先导入资料并确认教学路线；确认时生成 Markdown、Typst、PDF 和图片，之后可用局部反馈继续修订。

课程资料会持续累计：同一课程可追加新版课件，系统保留资料与章节的稳定身份、来源版本、显式学习进度和已生成的章节讲解。新增资料只调整未开始章节；正在学习和已学完章节的名称、位置、来源与讲解不会被自动替换。详见 [长期课程学习](docs/course-learning.md)。

浏览器入口：`tutor gui`。支持上传资料、调整与确认路线、阅读和下载讲解稿、局部修订及学习反馈，详见 [GUI 使用说明](docs/gui.md)。

## 快速开始

首次运行前先完成配置：

从 [v0.2.0 Release 页面](https://github.com/cqu-moe/tutor/releases/tag/v0.2.0) 下载对应平台的可执行文件并核验校验和（该版本发布完成后可用；若页面尚未提供资产，使用下方 Actions 构建产物），再按 [macOS / Linux 安装说明](docs/install.md) 准备外部依赖。发行版无需 Node.js、Bun 或源码仓库；开发构建使用 Bun 1.4.4+。Agent 写入工具需要系统沙箱。

1. 按[模型配置](docs/models.md)准备一个支持文字和图片的 Pi 模型；不使用默认模型或默认 Pi 配置时，按文档在首次命令中提供 `--agent-dir` 与/或 `--model`。
2. 将本次选用的 OCR 凭据放入环境变量或自行创建的 `~/.config/tutor/env`：Mistral 使用 `MISTRAL_API_KEY`，MinerU 使用 `MINERU_API_TOKEN`。
3. 按安装说明设置 `TUTOR_RECTO_ROOT`、`TUTOR_PYTHON`、`TUTOR_DIAGRAM_PYTHON` 与 `TUTOR_TYPST_PACKAGE_CACHE`；首次导入前运行 `tutor doctor` 检查依赖和配置。

下列命令把课程资料和学习者记忆保存在当前目录下的 `.tutor/`，可以通过 `--data-dir` 指定其他位置：

```sh
tutor --env-file "$HOME/.config/tutor/env" doctor --ocr mistral
tutor --env-file "$HOME/.config/tutor/env" \
  --course "Digital Design" --pdf lecture.pdf --pages 21-24 \
  --ocr mistral --data-dir .tutor
```

`--pages` 使用 PDF 物理页码；若 PDF 自带书签，也可以用 `--chapter "精确书签标题"` 代替 `--pages`。章节选择会包含下一章标题所在的边界页，并把起止标题传给教学路线和生成阶段，避免漏掉前一页结尾或误讲下一章。

首次导入会解析所选页、保存原页和解析结果，然后显示教学路线。按提示输入调整意见，或输入 `confirm` 确认；未确认前不会生成完整讲解稿。之后可在新进程中重新生成或修订：

```sh
tutor --env-file "$HOME/.config/tutor/env" \
  --course "Digital Design" --data-dir .tutor --generate

tutor --env-file "$HOME/.config/tutor/env" \
  --course "Digital Design" --data-dir .tutor \
  --revise "补充第 23 页 De Morgan 定律的完整推导"

tutor --course "Digital Design" --data-dir .tutor --chapters
```

学习者记忆、模型和 OCR 配置、导出依赖、失败保全以及验收步骤见下方文档。Tutor 仅通过显式 `--env-file FILE` 读取配置文件；已有环境变量优先，不自动扫描当前目录的 `.env`。`doctor` 只做本地诊断，不自动安装、不调用模型或 OCR API。

任务中断后可用 `tutor --data-dir .tutor tasks --json` 查看原任务，再用 `--task-id ID --resume` 继续；确认、取消和待处理原因会跨重启保存。详见 [任务中断续跑](docs/task-resumption.md)。

## 开发与构建

```sh
bun install --frozen-lockfile
bun run tutor --help
bun run check:design
bun run typecheck
bun run build
# 可选：构建所有支持的平台
bun run build darwin-arm64 darwin-x64 linux-arm64 linux-x64
```

主程序与 GUI 共用根工作区和 `bun.lock`；TypeScript、Vite 和设计检查均由 Bun 执行。`bun run build` 自动构建并内嵌 GUI 静态资源。

产物为 `dist/tutor-<平台>-<架构>`，可以移动、重命名为 `tutor` 后直接执行。主程序、分层记忆实现、书签脚本和运行资源随可执行文件提供；文档排版及绘图工具按安装说明准备。Linux 目标使用 glibc，x64 使用 baseline 指令集；不包含 Windows 或 musl 构建。

配置好导出和绘图依赖后运行 `bun run test`。通过 `TUTOR_TEST_BINARY=/absolute/path/to/tutor bun run test` 可让同一组集成测试直接验证编译后的程序，而非源码入口。跨平台构建成功不代表已在对应平台运行验证。

[Bun distribution 工作流](.github/workflows/distribution.yml) 在 push、PR 和手动触发时构建四个平台，并在原生 Linux x64 runner 上移除 `node_modules` 后运行打包产物的 `doctor` 和全部集成测试。成功运行的 [GitHub Actions](https://github.com/cqu-moe/tutor/actions/workflows/distribution.yml) 提供 `tutor-executables` 下载，包含四个可执行文件、`SHA256SUMS` 和记录应用版本、源码提交、锁文件哈希与 Bun revision 的 `BUILD-PROVENANCE.txt`，保留 7 天。正式发布使用同一工作流通过后的主分支产物，在 [Releases](https://github.com/cqu-moe/tutor/releases) 持久提供；安装和校验命令见 [安装说明](docs/install.md#tutor-executable-and-doctor)。

## 当前范围（0.2.0）

- 本地 CLI 与浏览器工作台，输入课程 PDF 和补充截图。
- Pi SDK；支持 Magpie、BYOK API 和自定义兼容接口。
- 稳定课程与章节身份；已学和在学章节受保护，显式反馈更新学习进度。
- 课程与全局记忆分层，支持查看、纠正、删除与恢复。
- 持久化教学任务，支持跨进程继续、等待确认和显式取消；不提供数据丢失备份。
- 用户可配置 MinerU VLM 或 Mistral OCR。
- 静态表格、电路图和示意图；交付 Markdown、Typst、PDF 及必要图片。
- 先确认教学路线，再生成并支持局部修订。

课程资料、学习者记忆和凭据不作为仓库内容发布。

## 项目文档

- [GUI 使用说明](docs/gui.md)
- [长期课程学习](docs/course-learning.md)
- [第一版规格](docs/spec.md)
- [安装与依赖检查](docs/install.md)
- [第一版工具组合与流程（历史）](docs/plan.md)
- [需求与调研记录](docs/discovery.md)
- [模型配置](docs/models.md)
- [OCR 配置与缓存](docs/ocr.md)
- [讲解导出](docs/export.md)
- [静态图表](docs/diagrams.md)
- [局部修订](docs/revision.md)
- [学习者记忆](docs/memory.md)
- [任务中断续跑](docs/task-resumption.md)
- [真实课程验收](docs/acceptance.md)
- [领域术语](GLOSSARY.md)
- [Agent 工作约定](AGENTS.md)

需求和实现任务使用 [GitHub Issues](https://github.com/cqu-moe/tutor/issues)。工程技能配置位于 [docs/agents](docs/agents)，后续可直接编辑。
