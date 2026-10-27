# Tutor

组合现成工具的个人课程讲解 Agent：读取课程资料和学习者记忆，先对齐教学路线，再生成能够独立阅读、替代指定范围课件的讲解稿。

CLI 已可从真实课程 PDF 生成可重建的讲解稿。安装依赖后，先用一条导入命令确认教学路线；确认时生成 Markdown、Typst、PDF 和图片，之后可用局部反馈继续修订。

## 快速开始

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --env-file=.env.local bin/tutor.js \
  --course "Digital Design" --pdf lecture.pdf --pages 21-24 \
  --ocr mistral --data-dir ./courses
```

首次导入会解析所选页、保存原页和解析结果，然后显示教学路线。按提示输入调整意见，或输入 `confirm` 确认；未确认前不会生成完整讲解稿。之后可在新进程中重新生成或修订：

```sh
node --env-file=.env.local bin/tutor.js \
  --course "Digital Design" --data-dir ./courses --generate

node --env-file=.env.local bin/tutor.js \
  --course "Digital Design" --data-dir ./courses \
  --revise "补充第 23 页 De Morgan 定律的完整推导"
```

学习者记忆、模型和 OCR 配置、导出依赖、失败保全以及验收步骤见下方文档。Tutor 不自动读取任意 env 文件；上面的 `--env-file=.env.local` 是 Node 的启动参数。

## 第一版范围

- 本地 CLI，输入课程 PDF 和补充截图。
- Pi SDK；支持 Magpie、BYOK API 和自定义兼容接口。
- 本地学习者记忆；按课程保留进度和薄弱点。
- 用户可配置 MinerU VLM 或 Mistral OCR。
- 静态表格、电路图和示意图；交付 Markdown、Typst、PDF 及必要图片。
- 先确认教学路线，再生成并支持局部修订。

课程资料、学习者记忆和凭据不作为仓库内容发布。

## 项目文档

- [第一版规格](docs/spec.md)
- [工具组合与流程](docs/plan.md)
- [需求与调研记录](docs/discovery.md)
- [模型配置](docs/models.md)
- [OCR 配置与缓存](docs/ocr.md)
- [讲解导出](docs/export.md)
- [局部修订](docs/revision.md)
- [学习者记忆](docs/memory.md)
- [真实课程验收](docs/acceptance.md)
- [领域术语](GLOSSARY.md)
- [Agent 工作约定](AGENTS.md)

需求和实现任务使用 [GitHub Issues](https://github.com/cqu-moe/tutor/issues)。工程技能配置位于 [docs/agents](docs/agents)，后续可直接编辑。
