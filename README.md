# Tutor

组合现成工具的个人课程讲解 Agent：读取课程资料和学习者记忆，先对齐教学路线，再生成能够独立阅读、替代指定范围课件的讲解稿。

当前处于规格与集成方案阶段，CLI 尚未实现。

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
- [领域术语](GLOSSARY.md)
- [Agent 工作约定](AGENTS.md)

需求和实现任务使用 [GitHub Issues](https://github.com/cqu-moe/tutor/issues)。工程技能配置位于 [docs/agents](docs/agents)，后续可直接编辑。
