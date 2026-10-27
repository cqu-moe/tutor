# Tutor 第一版方案

状态：已整理为 [第一版规格](spec.md)，用户已确认测试边界；issue tracker 待配置，尚未发布。详细依据见 [discovery.md](discovery.md)，领域术语见 [GLOSSARY.md](../GLOSSARY.md)。

## 要做出的体验

在本机 CLI 中提供课程 PDF 或截图，Agent 读取资料与这门课的学习记忆，先给出教学路线。用户确认路线后，生成能独立阅读、替代课件的讲解稿；随后可继续要求重讲某节、补推导或换例题。

讲解覆盖指定范围内的全部不同知识点、公式条件和方法，允许重排顺序、补前置知识、合并重复讲述和精选例题。原图、公式和题目保留出处；新增例题明确标注为新增。

## 组合现成工具

| 部分 | 第一版采用方式 |
| --- | --- |
| Agent 与终端交互 | 嵌入 Pi SDK，复用会话、交互和工具执行能力，使用专门的课程讲解指令 |
| 模型接入 | 复用 Pi 的 provider、认证与模型选择能力，支持 Magpie、BYOK API 和自定义兼容接口，由用户配置 |
| 学习者记忆 | 本地 `pi-memory` 扩展；课程进度和薄弱点按课程组织 |
| 云端文档解析 | 同时接入 MinerU 精准解析 VLM 和 Mistral OCR，用户通过配置选择；默认 MinerU |
| 原页查看 | 现有 Poppler 渲染 PDF，Agent 结合页面图片核对公式、图表与电路关系 |
| 表格与电路图 | Typst 表格、Schemdraw SVG；一般标注示意图复用 CeTZ 等现成绘图能力 |
| 讲解与排版 | 复用现有课程讲解指令与 Recto/Typst 导出资产，保留 Markdown、Typst、PDF 和必要图片 |

自定义代码限于 CLI 入口、课程工作目录、配置读取与现成工具接入。两家 OCR 各提供必要调用即可；当前不引入更多服务的插件体系。

## 模型接入方式

复用本机 Pi 0.82.1 已有能力，第一版提供以下接入方式：

| 方式 | 如何接入 |
| --- | --- |
| Magpie | 复用现有 Pi `models.json` 中的 `magpie` provider；`codex/gpt-6.1-sol` 仅作为首轮测试默认值 |
| BYOK API | 用户提供自己的 API Key，使用 Pi 内建的 OpenAI、Anthropic、Gemini、DeepSeek、Mistral、OpenRouter 等 provider |
| 自定义兼容接口 | 按 Pi 的 `models.json` 配置服务地址、API 协议与模型 ID，并提供凭据；支持其已有的 Chat Completions、Responses、Anthropic Messages、Google Generative AI 协议 |

用户可选择 provider 和模型。认证复用 Pi 的本机凭据或环境变量，课程目录不保存密钥；模型接入与 OCR 服务分别配置。保留逐模型的 API 协议和图片输入能力配置，不能假定同一网关下的模型能力一致。

Pi 已有 provider 扩展机制，特殊协议或登录流程可使用现成扩展。上述三种方式先复用内建能力与配置，不额外开发模型网关或通用接入插件。依据：[内建 provider 与认证](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/providers.md)、[自定义接口配置](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/models.md)、[provider 扩展](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/custom-provider.md)。

## 一次任务的流程

1. 选定课程、资料和章节范围，读取相关学习记忆。
2. 通过所配置的 OCR 服务解析 PDF/截图，把结果与原页信息保存在课程目录，供后续修订复用。
3. 给出教学路线、需要补充的前置知识和材料中的疑点，由用户调整确认。
4. 按路线写讲解稿，使用现成图表工具生成必要插图，核对公式、真值表和电路连接。
5. 导出讲义并检查渲染结果；用户反馈可继续推动局部修改。
6. 按已确认规则更新学习者记忆。

云 OCR 根据配置使用指定服务。服务失败时显示具体问题并保留已有工作；更换服务由用户配置决定。原始课件保留。

## 记忆规则

- 自动记录用户明确表达的进度、偏好和困难。
- 进度与薄弱点按课程区分；通用讲解偏好用于后续任务，当前明确要求优先。
- 根据行为推测的薄弱点保留依据并标为待验证，用户纠正后更新。
- 生成讲义不等于用户已学过或掌握。通过对话反馈和可选练习了解学习情况。
- 可以查看、纠正和删除记录，不要求逐条确认。`pi-memory` 的恢复记录与删除行为按其现有能力提供，不承诺抹除全部历史副本。

## 首次验收

材料：数字化设计第二章课件中的“Boolean Functions / Complement of a Function”小节，建议先取 PDF 第 21–24 页，涵盖真值表、逻辑门实现、公式和例题；讲解中补充理解所需前置知识。

原文件：用户本机的 `02. Chapter_2_Boolean_Algebra_and_Logic_Gates 2026.pdf`，课件不随仓库发布。

- 模型接入可按用户配置选择。先用现有 Magpie 完成实际对话、工具调用和图片输入验证；BYOK 使用用户已配置的凭据验证切换，未实测的 provider 单独标明。
- 两家 OCR 均能按配置完成同一小段材料的解析；结果可回查原页。分别记录实际成功或缺少凭据等阻塞，不把接口封装完成当成实测通过。
- 生成的讲解稿覆盖该小节，公式和真值表可核对，电路图标注可读。
- Markdown、Typst、PDF 引用完整；PDF 逐页查看，Typst 可重新编译。
- 用独立测试课程记录模拟进度和薄弱点，重开会话后能取回并影响讲解；不把测试记录混入用户真实学习记忆。
- 是否达到“替代课件”的教学质量，由这份真实材料的试用反馈判断，不能仅凭文件生成成功认定。

## 当前边界与待准备项

第一版为个人本地 CLI，输入 PDF/截图，PPT 先转 PDF，输出静态图表。多设备、在线账号系统和 OpenUI 交互演示不在本版范围。

需要配置 MinerU API Token 和 Mistral API Key 才能完成两家服务的真实验收。安装、API 认证、真实 OCR、模型读图、PDF 全流程和跨会话记忆目前均未完成集成验证。
