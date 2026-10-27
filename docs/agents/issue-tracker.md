# Issue tracker: GitHub

本项目的需求、规格和任务保存在 [cqu-moe/tutor 的 GitHub Issues](https://github.com/cqu-moe/tutor/issues)。使用 `gh` CLI 操作；所有示例中的仓库均为 `cqu-moe/tutor`。

## 操作约定

- 创建：`gh issue create --repo cqu-moe/tutor --title "..." --body-file <正文文件>`。
- 读取：`gh issue view <number> --repo cqu-moe/tutor --json number,title,body,labels,comments`。
- 列表：`gh issue list --repo cqu-moe/tutor --state open --json number,title,body,labels,comments`；按需使用 `--label` 与 `--state`。
- 更新正文：`gh issue edit <number> --repo cqu-moe/tutor --body-file <正文文件>`。
- 评论：`gh issue comment <number> --repo cqu-moe/tutor --body-file <正文文件>`。
- 添加或删除标签：`gh issue edit <number> --repo cqu-moe/tutor --add-label "..."` / `--remove-label "..."`。
- 关闭：`gh issue close <number> --repo cqu-moe/tutor --comment "..."`。
- 多行正文先写入文件，再传给 `--body-file`，保留换行并避免 shell 展开正文。
- 实际标签名按 `docs/agents/triage-labels.md` 映射。

## 技能约定

- “publish to the issue tracker” 表示创建或更新 GitHub Issue。
- “fetch the relevant ticket” 表示读取对应 Issue 的正文、标签与评论。
- GitHub Issue 与 PR 共用编号；若对象类型不明，先解析类型，再使用相应命令。

## Pull requests as a triage surface

**PRs as a request surface: no.**

PR 不默认作为 triage 的需求入口。若以后启用，使用 `gh pr view`、`gh pr diff`、`gh pr list` 和相应编辑命令读取与管理。

## 子任务与依赖

- 使用 GitHub 原生子 Issue；支持时使用 `gh issue create --repo cqu-moe/tutor --parent <parent> ...` 或 `gh issue edit <parent> --repo cqu-moe/tutor --add-sub-issue <child>`。
- 无法使用原生子 Issue 时，在子任务正文顶部注明 `Part of #<parent>`，并在父 Issue 中维护任务列表。
- 阻塞关系优先使用 GitHub 原生 issue dependencies；通过 `gh api` 添加时使用 Issue 的数据库 ID，不使用显示编号代替。
- 无法使用原生依赖时，在正文顶部记录 `Blocked by: #<number>`。所有阻塞项关闭后才视为任务可执行。

## Wayfinder

- 地图是一条使用 `wayfinder:map` 标签的 Issue，保存 Notes、Decisions-so-far 和 Fog。
- 子任务链接到地图，按需使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task` 标签；这些标签在实际使用时创建。
- 只领取未关闭、没有未解决阻塞且无人领取的任务，并指派给执行者。
- 解决后记录结论、关闭子任务并在地图中添加相关结论的链接。
