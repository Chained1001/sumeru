# {{项目名}}

TODO：一句话，写明解决什么问题、给谁用。

状态：TODO：实验、稳定、停止维护

## 安装

```bash
npx skills add {{owner}}/{{repo}}
```

前置条件：Node.js 24 及以上、git（提交前校验钩子需要）。版本不足时 `npm test` 第一步会给中文提示。

安装后确认：TODO：给一条命令或一次对话，能看出装成功（例如触发冒烟技能并看到固定回复）。

## 快速开始

1. 补全 `README.md`、`AGENTS.md`、`CHANGELOG.md`、`package.json` 里的 TODO；派生时未提供 `--author` 的，改 `LICENSE` 的版权行。
2. `node scripts/init-skill.mjs <技能名> --description "当…"` 生成第一个技能。
3. `git init`。
4. `node scripts/install-hooks.mjs` 安装提交前校验。
5. `npm run validate && npm test`。

## 技能列表

| 技能 | 用途 | 扩展键 |
|---|---|---|
| TODO：与技能目录名一致 | TODO：与 description 语义一致，不照抄 | 无 |

扩展键只填实际用到的，没有就写「无」，多个用逗号分隔。可填哪些键见 `docs/规范/01-技能写法.md` 的 frontmatter 表。表与 `skills/` 目录的一致性由 `npm run validate` 检查。

## 目录

| 路径 | 说明 |
|---|---|
| `skills/` | 技能源码，唯一发布内容 |
| `templates/` | 新建技能用的模板，不要删 |
| `docs/规范/` | 开发标准 |
| `scripts/`、`test/`、`evals/` | 校验、测试、评测 |

## 开发

| 命令 | 作用 |
|---|---|
| `npm run validate` | 静态校验 `skills/` 与 README 技能表 |
| `npm test` | 运行全部测试 |

## 反馈

TODO：提 Issue 的地址；不接收反馈时写「无，本项目不接收反馈」。

## 维护者

TODO：维护者名称与联系方式；不公开时写「由作者个人维护」。

## 许可证

MIT，见 LICENSE。
