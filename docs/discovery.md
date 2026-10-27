# Tutor 需求访谈

日期：2026-10-27（Asia/Shanghai）。阶段：需求讨论已整理为 [第一版规格](spec.md)。

## 来源与已知意图

来源：用户提供的“生成课堂讲解Skill”对话。本次引用接口返回了四条用户消息；助手回复均为内容引用占位标记，未取得回复正文。

- 用户希望把满意的课程讲解方法整理成可复用指令，让能力较弱的模型也能生成接近的内容、质量和行文。
- 用户观察到同一模型在网页聊天与 Codex 中的讲解质量有差别，怀疑与 system prompt 有关。这是待验证假设，尚不能据此认定原因。
- 用户随后明确希望基于 Pi SDK 自建课程讲解 mini agent，集成 PDF 解析、PDF 生成和 Typst 等功能。
- 最初请求是使用 ask-matt / grill-with-docs 梳理这个产品，并随访谈记录术语和决策；随后调用 to-spec 将讨论整理为规格。

## 第一轮：已确认

1. **使用形态**：先做个人本地 CLI。
2. **任务流程**：先对齐教学路线，再生成完整讲解，支持后续重讲、补推导和换例子。
3. **优先质量目标**：让学习者从讲解中学会，补必要前置知识、解释原因、展开关键推理并用例子检查理解。用户进一步明确：生成内容旨在替代课件。

覆盖口径已在第二轮 Q6 确认；超出材料的补充范围尚待具体任务限定。

## 第二轮：学习者记忆与覆盖范围

用户澄清：需要给 Agent 加记忆，记住用户某门课之前学到哪里、偏好和薄弱点。核心需求是学习者记忆，不能仅用任务续接或生成文件档案来替代。

- **已确认（Q4）**：通过对话反馈与可选练习了解学习情况；生成讲义后不强制测验。
- **Q5 的回复与后续动作**：用户要求先搜索现成记忆方案，不要造轮子。具体自动记录规则随后在 Q13 确认。
- **已确认（Q6）**：完整知识覆盖，例题可精选。覆盖指定资料中的全部不同知识点、公式条件和方法，允许重排顺序、补基础、合并重复讲述并精选代表例题。

建议区分讲解已覆盖、用户确认学过、练习验证的表现。生成某章讲义不能自动证明用户已学过或掌握。相关学习者记忆应影响下一次教学路线、前置解释和例题选择。

已确认使用本地记忆，当前不考虑多设备。按 Q13，明确进度、偏好与困难自动记录；进度和薄弱点按课程区分，推测附依据并标为待验证，用户可查看纠正且不逐条确认。优先试用现成 pi-memory 扩展，不自建记忆引擎。原始资料仍是核对公式和出处的依据。

## 工具组合与图表需求

- 用户提供 [OpenUI](https://github.com/thesysdev/openui) 作为参考：Agent 可能频繁需要表格、电路图和示意图，希望提供可复用的脚手架。
- 用户明确约束：不自研难以维护的系统，组合现成工具，DIY 一个适合个人使用的 Agent；启用 Ponytail full。
- 实现取向：优先复用 Pi、现成记忆集成、资料解析、图表工具和排版工具，只写必要连接代码与教学指令。具体工具仍在核查。
- 已确认第一版只要求做好 PDF 中的静态图表。产品入口为本地 CLI，交付需要支持 PDF/Typst。

### OpenUI 已核查的事实

截至本次调研，OpenUI 主分支为 `9bc3192b894c4f002aa3f9192176b7f16f5dea2a`。

- [框架无关核心](https://github.com/thesysdev/openui/tree/9bc3192b894c4f002aa3f9192176b7f16f5dea2a/packages/lang-core)提供组件定义、提示生成、结构化语言解析与运行时；网页组件渲染由各前端包承担。
- [内置组件注册](https://github.com/thesysdev/openui/blob/9bc3192b894c4f002aa3f9192176b7f16f5dea2a/packages/react-ui/src/genui-lib/openuiLibrary.tsx)包含表格、可编辑表格及常见统计图；该清单未提供专用电路图组件。
- 已有 [Pi SDK 集成示例](https://github.com/thesysdev/openui/tree/9bc3192b894c4f002aa3f9192176b7f16f5dea2a/examples/harnesses/pi)。它是 Next.js 网页入口，当前示例接 OpenUI Cloud 并需要 THESYS_API_KEY；不能视为本地 CLI 的即插即用插件。
- 示例复用 Pi 会话对象，但没有按网页 threadId 恢复进程重启前会话的连接逻辑；这也不等于学习者记忆。
- 可借用现成前端集成。根据 Q7，当前第一版以 PDF 静态图表为目标，OpenUI 保留为未来交互展示的参考。表格可直接使用 [Typst table](https://typst.app/docs/reference/model/table/)，外部绘图工具的 SVG 可通过 [Typst image](https://typst.app/docs/reference/visualize/image/)嵌入。

**已确认（Q7）**：先做好 PDF 里的静态图表。

以上为文档与源码核查；尚未安装或运行 OpenUI，也未测试其与本项目的集成。

### 静态图表候选

- 表格：复用 Typst 原生表格或已有 Recto 导出路径。
- 电路图与数字逻辑图：优先考察 [Schemdraw](https://schemdraw.readthedocs.io/en/stable/)。[SVG 后端](https://schemdraw.readthedocs.io/en/stable/usage/backends.html)无需 Matplotlib/Numpy；[数字逻辑模块](https://schemdraw.readthedocs.io/en/stable/elements/logic.html)支持逻辑门、逻辑表达式绘图、真值表及卡诺图等。现成元素与布局 API 可直接复用。
- 一般带标注示意图：候选 [CeTZ](https://cetz-package.github.io/docs/)，使用 Typst 原生绘图能力和锚点定位。
- 绘图库成功输出不能证明电路连接或教学内容正确；需要原资料核对与成图检查。以上尚未运行样例或确定为依赖。

## 现成记忆方案调研

已查询现成实现，未安装、未上传学习数据、未运行召回评测。

### pi-memory：本地记忆首选试用方案

[仓库与文档](https://github.com/jayzeng/pi-memory)，读取的包版本为 0.4.2。它是现成 Pi 扩展，声明兼容 Pi >=0.81.1；本机为 0.82.1，声明范围符合，实际集成仍待验证。

- 记忆以本机 Markdown 文件保存，无需额外数据库或记忆服务账号；已有写入、读取、删除与恢复工具。
- 自动注入记忆上下文；持久信息主要依靠 Agent 调用写入工具或退出摘要，不等于自动可靠地识别学习掌握程度。
- 可选 qmd 提供关键词、语义和混合检索；未安装 qmd 时基础记忆工具仍可用。检索和上下文注入有长度与模式限制，需要用课程对话验证。
- `PI_MEMORY_DIR` 可选择课程记忆目录，但没有内建的课程/学习者类型模型。按课程启动与全局偏好的组织仍需要少量配置和教学指令，不自建记忆引擎。
- 删除有恢复记录，不能把从提示中移除等同于物理抹除所有副本。

### Hindsight：功能较完整的本地或托管备选

[官方概览](https://hindsight.vectorize.io/)与[本地 MCP](https://hindsight.vectorize.io/sdks/integrations/local-mcp)提供 retain、recall、reflect、分库和标签等能力。本地版自动启动 API 与内嵌 PostgreSQL，比文件型插件更重；提取记忆仍要调用一个模型，可配置远程或本地模型。尚未验证直接接 Pi 的完整路径。

### Mem0 托管：用于比较托管与本机

[官方托管/开源对比](https://docs.mem0.ai/platform/platform-vs-oss)明确两种形态共享核心提取与检索逻辑；托管负责向量存储、模型、嵌入服务和运行维护，提供管理界面及部分额外功能。托管本身不是更高记忆准确率的证明。

**已确认（Q8）**：用户明确“目前不考虑多设备，我觉得本地的没问题”。第一版采用本地记忆方向，pi-memory 为首选试用方案。托管选型不再阻塞第一版。

## 第三轮：输入、模型与验收材料

- **已确认（Q9）**：第一版支持 PDF 和补充截图，PPT 先导出为 PDF。用户进一步询问是否应集成 OCR 等服务，进入现成解析/OCR 工具选型。
- **已确认（Q10）**：首轮沿用现有 Pi 默认模型 `magpie` / `codex/gpt-6.1-sol`。用户后续明确这里应设计模型接入方式，包括 Magpie、BYOK API，并询问现成插件；该默认值不限制可选 provider 或模型。
- **已确认（Q11）**：先用现有数字化设计第二章“布尔代数与逻辑门”的一小节验收。
- **提问方式**：之后使用 Codex 原生提问工具，不再将访谈问题只放在普通回复中。

本轮只读环境检查：Node.js 为 v22.22.3；上述 Pi 默认模型配置已读取，尚未验证认证或发起模型调用。验收课件为用户本机的 `02. Chapter_2_Boolean_Algebra_and_Logic_Gates 2026.pdf`，课件不随仓库发布。pdfinfo 显示 45 页、由 PowerPoint 导出、未加密；已用 pdftotext 检查前 8 页，并查看第 9–27 页的文本标题和开头，不能视为全章阅读。单页 OCR 检查记录见下文。

第一版完整方案汇总于 [plan.md](plan.md)。依据已查看的文本，建议首次验收使用第 21–24 页的 Boolean Functions / Complement of a Function 小节。

### 模型接入调研

- 本机安装的 Pi 为 `@earendil-works/pi-coding-agent` 0.82.1。对照本机文档与官方 v0.82.1 文档，优先复用 SDK 的模型配置和认证能力。
- [内建 provider 与认证](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/providers.md)已支持 OpenAI、Anthropic、Gemini、DeepSeek、Mistral、OpenRouter 等 API Key 接入，可使用 Pi 登录入口、本机凭据文件或环境变量。BYOK 不需要另外安装通用插件。
- [自定义模型配置](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/models.md)支持设置 `baseUrl`、API 协议、模型与凭据，并允许逐模型覆盖协议。本机 Magpie 已通过 `models.json` 配置：provider 默认协议为 `openai-completions`，首轮模型覆盖为 `openai-responses`，声明支持文字和图片。仅检查了必要元数据，没有将密钥或服务地址写入文档。
- [SDK 模型选择](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/sdk.md)可通过 `ModelRuntime` 读取内建及自定义模型；会话可指定模型，也可沿用恢复会话或用户默认设置。
- [provider 扩展](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/custom-provider.md)支持特殊认证和非标准 API。当前 Magpie、内建 BYOK 和兼容接口用已有配置即可；没有发现必须为本项目新写 provider 插件的需求。
- 方案据此改为用户可配置模型接入，首轮默认值保留。模型服务和云 OCR 独立选择。配置可加载不代表实际认证、工具调用或图片输入已经通过，仍需集成验证。

### 第四轮：OCR 与自动记忆

- **已确认（Q12）**：用户选择优先接专门的云 OCR 服务。先前“本地 OCR 优先”的建议不作为第一版路线。
- **已确认（Q13）**：自动保存明确进度、反馈与偏好；进度和薄弱点按课程区分，推测保留依据并标为待验证，生成讲义不等于学会；支持查看纠正且不逐条确认。
- **已确认（Q14）**：用户选择 MinerU 与 Mistral 两种云 OCR，并明确“用户可配置”。第一版提供两者的配置选择。默认建议 MinerU；配置决定本次使用的服务，原始解析结果保存在本地供后续修订复用。

## OCR 与文档读取调研

- 本机已有 Poppler 与 Tesseract；Tesseract 已安装英语、简体/繁体中文等语言数据。PATH 中未找到 Docling 或 OCRmyPDF。
- Pi 当前选定模型的本地配置声明输入支持 `text` 与 `image`；这只是配置检查，尚未验证实际图片 API 调用。
- 已把验收课件第 8 页渲染为图片并查看，内容含 AND/OR/NOT 三个真值表。对这张渲染图运行 `tesseract ... stdout -l eng` 后，正文大致可读，但 `x+y` 变成 `xty`，三张表的结构未被保留。这是一次清晰数字课件渲染图的基本检查，不能代表真实扫描、手写或全章的识别效果。
- 按 Q12，第一版优先使用专门云 OCR；现有 Poppler 继续用于原页渲染与核对，Tesseract 保留为已有能力，不作为首选 OCR。原页仍是核对公式、表格和电路关系的依据。
- [Docling 官方文档](https://github.com/docling-project/docling)提供本地 PDF/图片解析、版面与表格结构、OCR、Markdown/JSON 导出和 CLI；[OCR 引擎](https://docling-project.github.io/docling/concepts/OCR/)可使用 Tesseract、RapidOCR、ocrmac 等。[公式增强](https://docling-project.github.io/docling/usage/enrichments/)可提取 LaTeX，需要额外模型执行，默认不启用多数增强步骤。尚未安装或评测 Docling。
- 初期调研将 [Mistral OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr)作为云端备选，提供 PDF/图片处理、表格输出和结构化块等能力。后续已选定两家云服务并核查文档与价格，详见下文；账号和实际调用仍未验证。
- Context7 本轮再次返回月度额度用尽，故使用 GitHub 与 Exa 阅读上述官方来源。

### 云 OCR 的选定接入方向

- **MinerU 精准解析（VLM）**：[官方生态工具仓库](https://github.com/opendatalab/MinerU-Ecosystem)已有 CLI、TypeScript SDK（`mineru-open-sdk`）和 MCP。TypeScript SDK 示例支持本地文件、页码选择、`model: vlm` 与保存图片等资源，可直接作为 Pi 工具内部调用，不自建 OCR 任务管理服务。
- MinerU 的[当前详细 API 文档](https://mineru.net/apiManage/docs)给出每文件不超过 200 MB / 200 页，账号每日 1000 页最高优先级额度；超过优先级额度不等于停止服务。[限流页](https://mineru.net/apiManage/limit)当前注明暂无商业化收费计划。另一个官方 llms.txt 对页数写 600，存在口径差异；第一版按详细 API 文档的 200 页保守处理。
- **Mistral OCR**：[官方 OCR 接口](https://docs.mistral.ai/studio/document-processing/basic_ocr)返回分页面 Markdown、图片、表格和可选结构块；[OCR 4.1 模型页](https://docs.mistral.ai/models/ocr-4-1)当前基础价格为 $4/1000 页，标注模式另计。首版无需额外标注服务。
- 两家服务的账号、Token 和真实识别效果尚未验证；目前未向任何 OCR 服务上传课件。
- 本机 Pi 0.82.1 的类型声明中未找到 `registerMcpServer`，不将“Pi 原生支持直接注册 MCP”当作已证实能力。优先复用官方 SDK/API，避免为了 OCR 再引入通用 MCP 适配层。
- Mathpix 仅用于选型比较，不纳入当前第一版。

## 可复用资产与实际检查

- 当前目录尚无 Git 仓库、源代码或项目配置。
- PATH 中已找到 Node.js、npm、pnpm、Pi、Typst 和 Poppler 的 PDF 工具。
- 已读取本机 Pi 包元数据及 SDK 文档：`@earendil-works/pi-coding-agent` 0.82.1，支持持久会话、恢复会话、自定义系统提示和加载上下文。会话持久化本身不能满足学习者记忆需求；尚未运行本项目的 SDK 集成。
- 已阅读现有 Recto `study-notes` 指令：其中已有独立可读的讲解、按学习依赖重组内容、核对公式与原页、精选例题、保存 Markdown 后导出 Typst/PDF 等规则。它可作为候选资产，不代表用户已决定复用或沿用其默认值。

## 规格化与测试边界

- 用户调用 `mattpocock-skills:to-spec`，要求综合已有讨论形成规格。
- 用户已确认以完整 CLI 学习任务作为主要测试入口：导入课程资料、确认教学路线、生成和修改讲解稿、重开会话取回学习者记忆。自动检查可见行为、文件和记忆规则；用真实课件验证两家 OCR、模型读图与 PDF，教学质量由用户试用判断。
- 已生成本地规格；当前目录仍无 Git remote、项目 issue tracker 或 triage 标签配置，尚未发布或应用 `ready-for-agent`。按该技能要求，发布前需运行 `/setup-matt-pocock-skills` 明确目标与约定。

## 记录约定

术语明确后写入根目录 `GLOSSARY.md`，只记录领域含义。仅在存在实质取舍、难以反转且需要解释原因的决策时建立 `docs/adr/`。实现方案、质量假设和未决问题不混入术语表。
