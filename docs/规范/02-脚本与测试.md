# 02 脚本与测试

本文件规定脚本和测试的运行环境、接口和写法。模板见 `templates/script/script.mjs` 与 `templates/test/test.mjs`。

## 运行环境

- 只用 Node.js 内置模块，导入必须带 `node:` 前缀。
- `package.json` 的 `dependencies` 与 `devDependencies` 必须为空或不存在。
- 需要外部程序时，检测失败退出码为 3，错误信息写明安装方法，不静默降级。

## 文件

- 扩展名 `.mjs`，文件名 kebab-case。
- 仓库级脚本放在 `scripts/`；技能专用脚本放在该技能的 `scripts/`。
- 单个脚本超过 1000 行或 50 个函数时，按职责拆分。

## 接口

- 参数用 `--长名`。未知参数报错，退出码为 2。
- 退出码固定：0 成功，1 业务失败，2 参数错误，3 环境缺失。
- 支持 `--json` 时，stdout 只输出一个对象，结构为 `{ ok, errors, data }`。
- 人读的结果输出到 stdout，错误信息输出到 stderr。
- `--help` 输出用法并以 0 退出。

## 错误信息

中文，写明原因与修法。例如：`name "Bad_Name" 含大写字母。请改为小写英文与连字符。`

## 错误码

`--json` 输出的 `errors[]` 每项含 `code`、`message`，有明确归属文件时加 `file`。`code` 只取下表取值；新增错误码须同次写进本表并补测试。

| 码 | 触发条件 | 修法 |
|---|---|---|
| `E_FRONTMATTER` | 文件开头不是 `---` 包裹的 YAML，或含多行块标量、值含 `": "` 未加引号 | 按模板重写 frontmatter |
| `E_UNKNOWN_KEY` | frontmatter 含模板未列出的键 | 删掉该键 |
| `E_NAME` | `name` 缺失、超 64 字符、含大写或连续连字符 | 改为小写英文、数字与单连字符 |
| `E_NAME_MISMATCH` | `name` 与技能目录名不一致 | 改目录名或 `name`，保持相同 |
| `E_NAME_RESERVED` | 技能目录名为保留名（`skills`、`docs`、`templates`、`scripts`、`test`、`evals`、`examples`、`node_modules`） | 换一个目录名，同次改 `name` |
| `E_DESCRIPTION` | `description` 为空或超 1024 字符 | 补全或精简 |
| `E_COMPATIBILITY` | `compatibility` 超 500 字符 | 精简 |
| `E_BOOLEAN` | 布尔键取值不在 true/false、yes/no、on/off、1/0 | 改为合法取值 |
| `E_BODY_LINES` | 正文超 500 行 | 拆到 `workflows/` 或 `references/` |
| `E_BODY_SIZE` | `SKILL.md` 全文（含 frontmatter）超 20000 字符 | 拆到 `workflows/` 或 `references/` |
| `E_PLACEHOLDER` | 技能内任一 `.md` 仍含 `TODO` 或 `{{`，或流程文件名含 `TODO` | 补全正式内容；流程文件名改为正式中文名 |
| `E_LINK` | 引用的路径越出技能目录，或指向不存在的文件 | 修正路径或补文件 |
| `E_INDEX` | 根目录有 `README.md` 但未提及 `skills/` 下某个技能目录 | 更新 README 技能列表 |
| `E_FLAT` | `skills/` 下平铺 `.md` | 改为 `<name>/SKILL.md` |
| `E_NO_SKILL_MD` | 技能目录缺 `SKILL.md` | 补 `SKILL.md` |
| `E_NESTED` | `SKILL.md` 不在 `skills/<name>/` 下 | 移到正确层级 |
| `E_NO_SKILLS_DIR` | 缺少 `skills/`，或它不是目录 | 建成目录并放入技能 |
| `E_WORKFLOW_ORDER` | 流程文件名不是 `NN-名称.md`，或序号不连续、重复 | 按序号重命名 |
| `E_WORKFLOW_SECTION` | 流程文件缺固定小节 | 补齐五个小节 |
| `E_EXISTS` | `init-skill`、`init-project`、`pack` 的目标目录已存在且未加 `--force`，或 `pack --refresh` 的目标目录不存在 | 换名或加 `--force`；`--refresh` 换成既有打包产物，从零生成改用全量打包 |
| `E_TEMPLATE` | `templates/` 或 `--source` 目录缺失、根模板不齐（退出码 3），或打包时版本号、README 待替换行不可读，或比对项目时基座版本来源（`package.json` 与 `CHANGELOG.md`）不可读 | 恢复 `templates/` 或 `--source` 目录的模板；打包场景修好基座 `package.json` 版本号与根 README 模板的技能表行后重试；比对场景在完好的基座根目录运行 |
| `E_HOOK` | `install-hooks` 在非 git 仓库运行，或已有 pre-commit 钩子且未加 `--force` | 先 `git init`，或加 `--force` 覆盖 |
| `E_SYNC_GAP` | `check-projects` 发现派生项目与基座有差距：`.base-version` 未记录、早于 CHANGELOG 记录或落后若干版，或同步范围内文件内容不同、缺失 | 按 `规范/09` 的同步范围逐项判断后同步：属基座演进的从基座重新复制，属项目内容的保留；未记录版本的重派生或补记 `.base-version` |
| `E_IO` | 脚本读写文件失败的底层 IO 错误 | 看错误信息定位权限/磁盘后重试 |

## 脚本清单

| 脚本 | 用途 | 退出码 |
|---|---|---|
| `scripts/validate.mjs` | 静态校验 `skills/` 与 README 技能表 | 0、1、2 |
| `scripts/init-skill.mjs` | 从模板生成技能骨架 | 0、1、2、3 |
| `scripts/install-hooks.mjs` | 安装 pre-commit 提交前校验钩子 | 0、1、2 |
| `scripts/init-project.mjs` | 从基座生成新项目（仅基座，派生时删除） | 0、1、2、3 |
| `scripts/check-projects.mjs` | 只读比对派生项目与基座的版本与同步范围差距（仅基座，派生时删除） | 0、1、2、3 |
| `scripts/pack.mjs` | 把基座打包为 skill-starter 技能仓库内容，或加 `--refresh` 只重建其技能目录（仅基座，派生时删除） | 0、1、2、3 |

## 写文件

- 默认不覆盖已有文件。覆盖须显式传入 `--force`。
- 批量生成骨架类写文件的场景，先写临时文件再重命名，避免中途失败留下半截；单个小文件（钩子、根文件渲染）可直写。
- 提供 `--dry-run` 的命令，只输出将要做的动作，不落盘。

## 测试

- 框架固定为 `node:test`，断言固定为 `node:assert/strict`。
- 运行命令固定为守卫与测试两段，由 `npm test` 经 `&&` 串联调用：先 `node -e` 版本守卫（动态读 `package.json` 的 `engines.node`，当前 Node 主版本低于要求时输出中文提示并以退出码 1 拒绝继续，npm 未装 engine-strict 时低版本机器在第一步即得明确提示），后 `node --test --test-isolation=none "test/*.test.mjs"`。`--test-isolation=none` 让用例在同一进程运行，避免测试运行器自身 spawn 失败。
- 测试只断言可观测输出：返回值、退出码、写入的文件内容、stdout 与 stderr。不断言内部函数是否被调用。
- 允许条件跳过，写法固定为 `test('名称', { skip: <条件> && '<原因>' }, fn)`。原因写明什么条件下不适用。禁止无条件跳过与永久跳过。
- 禁止占位断言，如 `assert(true)`。
- 测试使用的临时目录放 `test/.tmp/` 或系统临时目录，均须自清理；`test/.tmp/` 已在 `.gitignore` 中排除。
- 测试夹具放在 `test/fixtures/`，故意写错的样例不得放进 `skills/`。

## 行为评测

- 用例放 `evals/cases/`，模板 `templates/eval/case.md`，长期保留；一次运行的记录放 `辅助内容/测试目录/`，模板 `templates/test-run/`，不入库。
- 用例判据编号用 `C-`，与参考件的 `J-` 不共用号段。
- 每次运行把用例的 `C-NN` 逐条抄进结论，结果只写通过、不通过、未测。
- 类型只有两种：硬性不通过即用例不通过；参考不通过只记录，不改变用例结论。
- 判定技能有效须与基线对照：同一指令在无技能（或改动前版本）下运行一次，记录差异。用例的「基线」小节不适用时写「无」并给理由（由人核对）。
- 触发用例：文件名前缀 `trig-`，测 `description` 触发准确性——一条应触发的真实感指令加一条不应触发的近似指令，负例选关键词相近但需求不同的难例。
- 行为评测不进 `npm test`：它需要真实 agent，结论取决于模型与宿主版本。`test/` 只做静态检查（用例结构、编号连续、被测技能存在）。
- 覆盖下限：每个技能至少一条用例（类型由人核对，存在性由 `evals.test.mjs` 检查）；有 `workflows/` 的技能至少一条负例（文件名前缀 `neg-`）、有 `scripts/` 的技能至少一条断言退出码与 stdout（这两条脚本不检查，由人核对）。

## 变更

修改本文件，同次在 `CHANGELOG.md` 的 `[Unreleased]` 段记录。
