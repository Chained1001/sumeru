// 防的漂移：evals/cases 的用例与 templates/eval/case.md 脱节、被删光，或指向不存在的技能。
// 只做静态检查；行为层（模型是否给出合格产出）需要真实 agent，按 templates/test-run/ 人工记录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(base, 'evals', 'cases')
const SECTIONS = ['## 输入', '## 基线', '## 期望', '## 判据', '## 覆盖']

test('evals/cases 存在时，每个用例合模板、编号连续、技能路径存在', async () => {
  if (!existsSync(dir)) return
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md'))
  assert.ok(names.length > 0, 'evals/cases/ 存在但为空：留至少一条用例，或整个删掉 evals/')
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8')
    for (const s of SECTIONS) assert.ok(text.includes(s), `${name} 缺 ${s}`)

    const skill = /^- 被测技能：(.+)$/m.exec(text)?.[1]?.trim()
    assert.ok(skill, `${name} 缺「被测技能」字段`)
    assert.ok(existsSync(join(base, skill, 'SKILL.md')), `${name} 的被测技能不存在：${skill}`)

    const rows = [...text.matchAll(/^\| (C-\d{2}) \|/gm)].map((m) => m[1])
    assert.ok(rows.length > 0, `${name} 的判据表没有 C- 编号`)
    assert.equal(new Set(rows).size, rows.length, `${name} 的 C- 编号重复`)
    rows.forEach((id, i) => assert.equal(id, `C-${String(i + 1).padStart(2, '0')}`, `${name} 的 C- 编号须从 01 起连续`))

    const cover = text.slice(text.indexOf('## 覆盖'))
    for (const id of rows) assert.ok(cover.includes(id), `${name} 的 ${id} 未被覆盖表引用`)
  }
})

test('每个技能至少有一条评测用例', async () => {
  if (!existsSync(dir)) return
  const skillsDir = join(base, 'skills')
  if (!existsSync(skillsDir)) return
  const covered = new Set()
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.md'))) {
    const text = await readFile(join(dir, name), 'utf8')
    const skill = /^- 被测技能：(.+)$/m.exec(text)?.[1]?.trim()
    if (skill) covered.add(skill.replace(/\\/g, '/'))
  }
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    assert.ok(covered.has(`skills/${entry.name}`), `技能 ${entry.name} 没有评测用例（覆盖下限：每个技能至少一条用例，类型由人核对）`)
  }
})

test('用例里的固定文本与技能正文一致', async () => {
  if (!existsSync(dir)) return
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.md'))) {
    const text = await readFile(join(dir, name), 'utf8')
    const literal = /恰为 `([A-Z][A-Z0-9-]{5,})`/.exec(text)?.[1]
    if (!literal) continue
    const skill = /^- 被测技能：(.+)$/m.exec(text)?.[1]?.trim()
    const skillText = await readFile(join(base, skill, 'SKILL.md'), 'utf8')
    assert.ok(skillText.includes(literal), `${name} 的固定文本 ${literal} 不在 ${skill}/SKILL.md 中`)
  }
})
