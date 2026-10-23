# 09 项目派生

本文件规定如何从基座创建一个新项目，以及项目与基座的关系。基座的完整结构见上游基座的 `框架树.md`（不随项目复制），本文件不重复。

## 上下游

- 基座是上游。标准、模板、脚本、校验器只在基座修改。
- 项目是下游。项目接收基座的复制件，之后独立演进。
- 派生完成后，项目与基座没有代码依赖，也不引用基座路径。基座的改动不会自动进入项目。

## 派生步骤

快速路径：`node scripts/init-project.mjs <目标目录> --owner <owner> --repo <repo> --author <名>` 一次做完第 1 至 4 步。以下是它做的事；手工做时按顺序来。

1. 复制 `辅助内容/开发框架/基座/` 的全部内容到新项目根目录。`templates/` 必须保留，`scripts/init-skill.mjs` 运行时读取它；它是上游 `开发框架/模板/` 的副本，派生后不再与上游同步，项目内可自行增删。
2. 删除整个 `evals/`（其中只有示例用例与示例测试）、`examples/` 目录、`test/base-only.test.mjs`（它读上游的 `框架树.md`，在项目里不成立）、`test/examples.test.mjs`（它检查只存在于基座的示例）、`scripts/init-project.mjs` 与 `test/init-project.test.mjs`（生成器只在基座用）、`scripts/pack.mjs` 与 `test/pack.test.mjs`（打包器只在基座用）、`scripts/check-projects.mjs` 与 `test/check-projects.test.mjs`（派生项目比对只在基座用）。保留 `skills/.gitkeep`，直到建出第一个技能：git 不跟踪空目录，删掉它会让新克隆缺少 `skills/`，`validate` 报 `E_NO_SKILLS_DIR`。
3. 用 `templates/root/` 的文件替换根文件：`README.md`、`AGENTS.md`、`CHANGELOG.md`、`package.json`、`.gitignore`（源文件名为 `gitignore`）、`.gitattributes`（源文件名为 `gitattributes`）、`.github/workflows/ci.yml`，同时把 `{{项目名}}`、`{{owner}}`、`{{repo}}` 换成实际值。`LICENSE` 保留，只改版权人。
4. 改 `package.json` 的 `name`，与仓库目录名一致；`version` 从 `0.1.0` 起。
5. 按需建 `docs/产品/`（模板 `templates/doc/PRD.md`）与 `docs/技术/`（模板 `templates/doc/技术文档.md`）。
6. 补全根文件中的 TODO，删掉不适用的行。根文件里不得留 TODO 或 `{{`。
7. `git init`，随后运行 `node scripts/install-hooks.mjs` 安装 pre-commit 钩子；首次提交用 `chore: 从基座派生`。
8. 运行 `npm run validate` 与 `npm test`，两者退出码为 0。

## 派生后必须改

| 位置 | 改什么 | 判断依据 |
|---|---|---|
| `package.json` | `name` | 与仓库目录名一致 |
| `README.md` | 用途、安装地址、技能表 | 装的命令能直接执行 |
| `AGENTS.md` | 项目是什么、改动同步表、禁止事项 | 表内无 TODO |
| `LICENSE` | 版权人 | 与仓库 owner 一致 |
| `CHANGELOG.md` | 首个版本段 | 版本号与 `package.json` 一致 |

## 占位符

模板里的双花括号占位符在派生时替换成下表的值。表外的占位符不得使用。

| 占位符 | 取值 | 出现在 |
|---|---|---|
| `{{项目名}}` | `package.json` 的 `name`，与仓库目录名一致 | `root/README.md`、`root/AGENTS.md`、`doc/PRD.md`、`doc/技术文档.md` |
| `{{owner}}` | GitHub 用户名或组织名 | `root/README.md`、`root/package.json` |
| `{{repo}}` | GitHub 仓库名 | `root/README.md`、`root/package.json` |
| `{{name}}` | 技能目录名 | `skill/SKILL.md`、`skill/workflow.md` |
| `{{description}}` | 技能的 `description`，由 `init-skill.mjs` 传入 | `skill/SKILL.md` |
| `{{序号}}` | 两位序号，从 `01` 起 | `skill/workflow.md` |
| `{{步骤组名}}` | 步骤组的中文短名 | `skill/workflow.md` |
| `{{title}}` | 文件标题，如「摘要判据」 | `skill/reference.md`、`skill/asset.md`、`skill/agent.md`、`eval/case.md` |
| `{{项目}}` | 被测试的项目目录名 | `test-run/运行说明.md`、`test-run/结论.md` |
| `{{目的}}` | 冒烟、回归、功能、探索、对比 | 同上 |
| `{{轮次}}` | `rNN`，从 `r01` 起 | 同上 |

`init-project.mjs` 替换根文件里的 `项目名`、`owner`、`repo` 三个占位符；`init-skill.mjs` 替换 `skill/` 下的 `name`、`description`、`序号`、`步骤组名`、`title` 五个，其中 `title` 机器只替换为通用名「参考件」「版式」「子代理」，评测用例（模板 `eval/case.md`）替换为「<名> 冒烟」，具体名称由人改。其余靠人替换，替换后全文不得残留双花括号。

## 回灌

- 项目要改标准，改基座，再从基座重新复制。项目内的 `docs/规范/` 不直接改。
- 回灌只复制基座的对应文件，不合并项目已有的改动，也不把项目文件带回基座。
- 项目可以向基座回灌通用模板或脚本，前提是去掉全部业务名词，并补齐基座的测试。

## 派生后的同步范围

基座升级时，项目按下表决定哪些文件跟随重新复制（基座到项目），哪些永不回灌（保留项目版本）：

- 跟随重新复制：`docs/规范/` 全部、`scripts/validate.mjs`、`scripts/init-skill.mjs`、`scripts/install-hooks.mjs`（框架树标为必需，派生步骤 7 运行它）、`templates/` 全部、`.gitattributes` 与 `.gitignore`、`ci.yml` 等双份根文件（项目根与 `templates/root/` 各一份，同次改）、`test/version.test.mjs` 等基座演进新增的仓库级测试。
- 永不回灌：`skills/`、`evals/`、`docs/产品/`、`docs/技术/`，以及根 `README.md`、`AGENTS.md`、`CHANGELOG.md` 的项目内容。
- 核对方法：优先在基座运行 `node scripts/check-projects.mjs <项目路径>`——它读项目根 `.base-version` 报告落后几版（未记录、早于基座 CHANGELOG 记录均计差距），并按下述固定清单逐文件比对：`docs/规范/*.md`、`scripts/validate.mjs`、`scripts/init-skill.mjs`、`templates/` 全部、`test/version.test.mjs`、`.gitignore`、`.gitattributes`、`.github/workflows/ci.yml`，内容不同或项目缺失都会列出；退出码 0 即范围内完全同步。「等基座演进新增的仓库级测试」里清单之外的新测试仍靠手工判断。脚本不可用时后退为全手工：与基座同名文件逐一 `diff`，内容不同的逐份判断——属基座演进的重新复制，属项目内容的保留。
- 理由：基座只演进规范、模板、脚本与门禁，项目的技能与文档是项目自己的产出，两者不混。

## 不回灌的内容

- `docs/产品/`、`docs/技术/`、`skills/`、`evals/cases/` 属于项目，留在项目。
- 调研、语料、测试运行记录放在 `辅助内容/`，两个方向都不进仓库。

## 检查

- `npm run validate` 退出码为 0。
- `npm test` 退出码为 0。`standards.test.mjs` 与 `templates.test.mjs` 的「副本与源头逐字一致」在项目内按设计跳过（源头不在项目里），其余测试不得跳过。
- `README.md`、`AGENTS.md`、`CHANGELOG.md`、`package.json` 不含 `TODO` 与 `{{`（脚本不检查，由人核对）。

## 变更

修改本文件，同次在 `CHANGELOG.md` 的 `[Unreleased]` 段记录。
