# 05 版本与发版

本文件规定版本号、CHANGELOG 和发版步骤。

## 版本号

遵循语义化版本 `MAJOR.MINOR.PATCH`。

`npm test` 含 `package.json` 与 `CHANGELOG.md` 的版本一致性检查（`test/version.test.mjs`）：CHANGELOG 有版本段起，最新版本段须与 `version` 一致，不一致即测试失败。

| 改动 | 升位 |
|---|---|
| 破坏兼容：改技能名、删技能、改输入或输出的含义或结构、删除或放宽判据 | MAJOR |
| 新增功能，不破坏兼容 | MINOR |
| 修正错误、文字调整 | PATCH |

0.x 阶段，破坏兼容的改动升 MINOR，但须在该条目前加 `**BREAKING:**`。

同一次发布含多类改动时，取最高一级。

## 弃用

先弃用，再删除。

1. 在被弃用技能的 `description` 开头写：已弃用，改用 `<新名>`。这是 `description` 必须以「当」开头的唯一例外，见 `01-技能写法.md`。
2. 在 CHANGELOG 的 `Deprecated` 中记录替代方案与计划删除的版本。
3. 弃用至少经过一个 MINOR 版本，之后才能删除。0.x 阶段例外：过了一个 MINOR 即可删除，不必等 MAJOR——0.x 的破坏性改动只升 MINOR，等 MAJOR 等于永不删除。
4. 删除时在 `Removed` 中记录。

## CHANGELOG

- 文件开头写一句格式声明：格式遵循 Keep a Changelog，版本号遵循 Semantic Versioning。
- 按版本分段，格式为 `## [版本号] - YYYY-MM-DD`。未发布内容放在 `## [Unreleased]`。
- 分类小节只允许 `Added`、`Changed`、`Deprecated`、`Removed`、`Fixed`、`Security`，按此顺序，无内容的分类不写。安全修复单列 `Security`，不并入 `Fixed`。
- 破坏性变更不单设分类。写在 `Changed` 或 `Removed` 里，条目前加 `**BREAKING:**`。
- 每条以一句话描述，不加句号。

## 发版步骤

1. 运行 `npm run validate` 与 `npm test`，两者都通过。
2. 运行 `node scripts/init-skill.mjs --help` 等命令，确认命令行接口未变化。若有变化，在该条目前加 `**BREAKING:**`。
3. 更新 CHANGELOG：把 `[Unreleased]` 的内容移入新版本段。
4. 更新 `package.json` 的 `version`。
5. 打 tag，格式为 `vX.Y.Z`，与版本一致。
6. 创建发布，说明取自 CHANGELOG 对应段落。

## 安装

发布后，使用者通过下列命令安装：

```bash
npx skills add <owner>/<repo>
```

`--skill <名>` 可只装指定技能。

## 变更

修改本文件，同次在 `CHANGELOG.md` 的 `[Unreleased]` 段记录。
