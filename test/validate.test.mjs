import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSkillText, parseArgs, validateRepo } from '../scripts/validate.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const tmpBase = async () => {
  const { mkdir } = await import('node:fs/promises')
  const base = join(here, '.tmp', 'validate')
  await mkdir(base, { recursive: true })
  return base
}
const fixtures = join(here, 'fixtures')
const codes = (errors) => errors.map((e) => e.code)
const skill = (frontmatter, body = '# 正文\n') => `---\n${frontmatter}\n---\n${body}`
const OK = 'name: sample\ndescription: 当需要测试时使用。'

test('合法的 frontmatter 与正文通过', () => {
  assert.deepEqual(checkSkillText('sample', skill(OK)), [])
})

test('name 含大写报 E_NAME', () => {
  assert.deepEqual(codes(checkSkillText('Sample', skill('name: Sample\ndescription: x'))), ['E_NAME'])
})

test('name 含连续连字符报 E_NAME', () => {
  assert.deepEqual(codes(checkSkillText('a--b', skill('name: a--b\ndescription: x'))), ['E_NAME'])
})

test('name 与目录名不一致报 E_NAME_MISMATCH', () => {
  assert.deepEqual(codes(checkSkillText('dir-name', skill('name: other\ndescription: x'))), ['E_NAME_MISMATCH'])
})

test('目录名为保留名报 E_NAME_RESERVED', () => {
  assert.deepEqual(codes(checkSkillText('docs', skill('name: docs\ndescription: x'))), ['E_NAME_RESERVED'])
  assert.deepEqual(codes(checkSkillText('sample', skill(OK))), [])
})

test('缺少 description 报 E_DESCRIPTION', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill('name: sample'))), ['E_DESCRIPTION'])
})

test('description 长度边界：1024 通过，1025 报错', () => {
  assert.deepEqual(checkSkillText('sample', skill(`name: sample\ndescription: ${'字'.repeat(1024)}`)), [])
  assert.deepEqual(codes(checkSkillText('sample', skill(`name: sample\ndescription: ${'字'.repeat(1025)}`))), ['E_DESCRIPTION'])
})

test('未知字段报 E_UNKNOWN_KEY', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill(`${OK}\nfoo: bar`))), ['E_UNKNOWN_KEY'])
})

test('布尔字段拼写错误报 E_BOOLEAN，合法拼写通过', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill(`${OK}\nuser-invocable: maybe`))), ['E_BOOLEAN'])
  assert.deepEqual(checkSkillText('sample', skill(`${OK}\nuser-invocable: No`)), [])
})

test('compatibility 长度边界：500 通过，501 报 E_COMPATIBILITY', () => {
  assert.deepEqual(checkSkillText('sample', skill(`${OK}\ncompatibility: ${'字'.repeat(500)}`)), [])
  assert.deepEqual(codes(checkSkillText('sample', skill(`${OK}\ncompatibility: ${'字'.repeat(501)}`))), ['E_COMPATIBILITY'])
})

test('以 - 开头的参数（含单短横与单独的 -）一律报未知参数', () => {
  assert.throws(() => parseArgs(['-x']), /未知参数 -x/)
  assert.throws(() => parseArgs(['-abc']), /未知参数 -abc/)
  assert.throws(() => parseArgs(['-']), /未知参数 -/)
  assert.deepEqual(parseArgs(['--json']).json, true, '合法长参数不受影响')
  assert.deepEqual(parseArgs(['some/path']).root, 'some/path', '普通路径仍可作为位置参数')
})

test('缺少 frontmatter 报 E_FRONTMATTER', () => {
  assert.deepEqual(codes(checkSkillText('sample', '# 没有 frontmatter\n')), ['E_FRONTMATTER'])
})

test('多行块标量报 E_FRONTMATTER', () => {
  assert.deepEqual(codes(checkSkillText('sample', skill('name: sample\ndescription: >\n  多行'))), ['E_FRONTMATTER'])
})

test('正文超过 500 行报 E_BODY_LINES，500 行通过', () => {
  const ok = skill(OK, Array(500).fill('行').join('\n') + '\n')
  const tooLong = skill(OK, Array(501).fill('行').join('\n') + '\n')
  assert.deepEqual(checkSkillText('sample', ok), [])
  assert.deepEqual(codes(checkSkillText('sample', tooLong)), ['E_BODY_LINES'])
})

test('SKILL.md 全文超 20000 字符报 E_BODY_SIZE，恰 20000 通过', () => {
  const make = (total) => {
    const head = `---\n${OK}\n---\n`
    return head + '字'.repeat(total - [...head].length)
  }
  assert.equal([...make(20000)].length, 20000)
  assert.deepEqual(checkSkillText('sample', make(20000)), [])
  assert.deepEqual(codes(checkSkillText('sample', make(20001))), ['E_BODY_SIZE'])
})

test('合法仓库通过校验', async () => {
  assert.deepEqual(await validateRepo(join(fixtures, 'valid')), [])
})

test('断开的引用报 E_LINK', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'broken-link'))), ['E_LINK'])
})

test('嵌套的 SKILL.md 报 E_NESTED', async () => {
  assert.ok(codes(await validateRepo(join(fixtures, 'invalid', 'nested'))).includes('E_NESTED'))
})

test('平铺的 .md 报 E_FLAT', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'flat-file'))), ['E_FLAT'])
})

test('目录缺少 SKILL.md 报 E_NO_SKILL_MD', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'no-skill-md'))), ['E_NO_SKILL_MD'])
})

test('README 未在技能表行提及技能报 E_INDEX；散文提及不算，无 README 时不检查', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'idx-'))
  try {
    const dir = join(root, 'skills', 'indexed-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: indexed-skill\ndescription: 当需要测试索引时使用。'))
    assert.deepEqual(await validateRepo(root), [], '无 README.md 时跳过索引检查')

    // 散文顺带提及技能名不算入索引：必须出现在表格行（首列）才通过。
    await writeFile(join(root, 'README.md'), '# 项目\n\n本项目的 indexed-skill 很好用。\n')
    assert.deepEqual(codes(await validateRepo(root)), ['E_INDEX'])

    await writeFile(join(root, 'README.md'), '# 项目\n\n| 技能 | 用途 |\n|---|---|\n| indexed-skill | 测试 |\n')
    assert.deepEqual(await validateRepo(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('引用越出技能目录报 E_LINK', async () => {
  assert.deepEqual(codes(await validateRepo(join(fixtures, 'invalid', 'outside-link'))), ['E_LINK'])
})

test('E_NO_SKILLS_DIR 两分支：目录缺失与 skills 是文件', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const emptyRoot = await mkdtemp(join(await tmpBase(), 'noskills-'))
  const fileRoot = await mkdtemp(join(await tmpBase(), 'skillsfile-'))
  try {
    assert.deepEqual(await validateRepo(emptyRoot), [{ code: 'E_NO_SKILLS_DIR', file: 'skills/', message: '缺少 skills/ 目录' }])
    await writeFile(join(fileRoot, 'skills'), 'skills 被文件占位', 'utf8')
    assert.deepEqual(await validateRepo(fileRoot), [{ code: 'E_NO_SKILLS_DIR', file: 'skills/', message: 'skills/ 不是目录，请改为目录并放入技能' }])
  } finally {
    await rm(emptyRoot, { recursive: true, force: true })
    await rm(fileRoot, { recursive: true, force: true })
  }
})

test('本基座自身通过校验', async () => {
  assert.deepEqual(await validateRepo(join(here, '..')), [])
})

test('workflows 中的流程文件缺少固定小节报 E_WORKFLOW_SECTION', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-抽取.md'), '# 抽取\n\n## 目的\n\n只有目的。\n')
    assert.ok(codes(await validateRepo(root)).includes('E_WORKFLOW_SECTION'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workflows 序号不连续报 E_WORKFLOW_ORDER', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  const full = '## 目的\n\nx\n\n## 输入\n\nx\n\n## 步骤\n\nx\n\n## 产出\n\nx\n\n## 停止条件\n\nx\n'
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-抽取.md'), '# 抽取\n\n' + full)
    await writeFile(join(dir, 'workflows', '03-校对.md'), '# 校对\n\n' + full)
    assert.ok(codes(await validateRepo(root)).includes('E_WORKFLOW_ORDER'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workflows 文件结构完整且序号连续时通过', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  const full = '## 目的\n\nx\n\n## 输入\n\nx\n\n## 步骤\n\nx\n\n## 产出\n\nx\n\n## 停止条件\n\nx\n'
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-抽取.md'), '# 抽取\n\n' + full)
    await writeFile(join(dir, 'workflows', '02-校对.md'), '# 校对\n\n' + full)
    assert.deepEqual(await validateRepo(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('流程文件名含 TODO 报 E_PLACEHOLDER，内容不含 TODO 时不误报正文占位符', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(await tmpBase(), 'wf-'))
  const full = '## 目的\n\nx\n\n## 输入\n\nx\n\n## 步骤\n\nx\n\n## 产出\n\nx\n\n## 停止条件\n\nx\n'
  try {
    const dir = join(root, 'skills', 'flow-skill')
    await mkdir(join(dir, 'workflows'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), skill('name: flow-skill\ndescription: 当需要测试流程时使用。', '# 入口\n'))
    await writeFile(join(dir, 'workflows', '01-TODO.md'), '# 骨架\n\n' + full)
    const errs = await validateRepo(root)
    assert.deepEqual(errs.map((e) => `${e.code}@${e.file}`), [`E_PLACEHOLDER@skills/flow-skill/workflows/01-TODO.md`])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

after(async () => {
  await rm(join(here, '.tmp', 'validate'), { recursive: true, force: true })
  try {
    await rmdir(join(here, '.tmp'))
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
})
