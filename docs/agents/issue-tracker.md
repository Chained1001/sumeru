# Issue tracker: GitHub

本仓库的工程票与规格存在 GitHub Issues 里，仓库是 `Chained1001/sumeru`。读写一律用 `gh` CLI。

## 与 PRD 的分工

本仓库已有一套产品侧文档，两者分工如下，不要混：

| 记什么 | 写在哪 | 编号 |
|---|---|---|
| 功能项、验收项、开放问题 | `docs/产品/PRD.md` | F-xx、A-xx、Q-xx |
| 架构决策与风险 | `docs/技术/技术文档.md` | D-xx、R-xx |
| 拆到可独立完工的工程票 | GitHub Issues | `#N` |

工程票只**引用**编号，不复制需求正文（复制必然漂移，改一处漏一处；见 `AGENTS.md` 的「事实源」节）。一张票写成「实现 F-14 的 card move 子命令，验收按 A-07」，而不是把 F-14 整段抄过来。

## Conventions

- **建票**：`gh issue create --title "..." --body "..."`。正文多行时用 heredoc 或 `--body-file`。
- **读票**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列票**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` 与 `--state` 过滤。
- **设为某票的子票**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+）。旧版用 `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（要**数据库 id**，不是 `#number`）。不支持子票时，在子票正文顶部写 `Part of #<parent>`。
- **评论**：`gh issue comment <number> --body "..."`。
- **打／撤标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关票**：`gh issue close <number> --comment "..."`。

在克隆目录里跑 `gh` 会自动推断仓库，不必每次给 `--repo`。

## Pull requests as a triage surface

**PRs as a request surface: no.** _（设成 `yes` 表示本仓库把外部 PR 也当需求入口，`/triage` 会读这个标记。）_

设成 `yes` 后，PR 走与 issue 相同的标签与状态，命令换成 `gh pr` 系列：

- **读 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列待分诊的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论／打标签／关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个号段，裸写 `#42` 可能指两者之一：先用 `gh pr view 42`，取不到再 `gh issue view 42`。

## When a skill says "publish to the issue tracker"

建一条 GitHub issue。

## When a skill says "fetch the relevant ticket"

按上面「读票」读。

## Wayfinding operations

供 `/wayfinder` 用。**地图**是一条 issue，**子票**是它的子 issue。

- **地图**：一条打 `wayfinder:map` 标签的 issue，正文装 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子票**：作为地图的子 issue 关联（见「设为某票的子票」）。子票不可用时，把子票加进地图正文的任务清单，并在子票正文顶部写 `Part of #<map>`。标签 `wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。认领后指派给动手的开发者。
- **阻塞**：用 GitHub 原生的 issue 依赖，这是 UI 里可见的标准表示。加边用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的**数字数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，**不是** `#number`，也不是 `node_id`）。GitHub 用 `issue_dependencies_summary.blocked_by` 报未关闭的阻塞数，这是真正的闸门。依赖功能不可用时，退回在子票正文顶部写 `Blocked by: #<n>, #<n>`。所有阻塞方都关闭后，该票才算解除阻塞。
- **前沿查询**：列出地图的未关闭子票（`gh issue list --state open`，范围限地图的子 issue 或任务清单），丢掉有未关闭阻塞的（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里还有未关闭的票）和已有指派的；按地图里的顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一次写操作。
- **解决**：`gh issue comment <n> --body "<答案>"`，再 `gh issue close <n>`，最后把一段上下文指针（要点＋链接）追加到地图的 Decisions-so-far。
