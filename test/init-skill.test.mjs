import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageError, initSkill, renderSkill } from '../scripts/init-skill.mjs'
import { validateRepo } from '../scripts/validate.mjs'

const here = dirname(fileURLToPath(import.meta.url))

async function withSandbox(run) {
  const root = join(here, '.tmp', `init-${process.hrtime.bigint()}`)
  await mkdir(join(root, 'skills'), { recursive: true })
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('生成的技能替换了 name 与 description', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'sample-skill', description: '当需要测试时使用。' })
    const text = await readFile(join(root, 'skills', 'sample-skill', 'SKILL.md'), 'utf8')
    assert.match(text, /^name: sample-skill$/m)
    assert.match(text, /^description: 当需要测试时使用。$/m)
    assert.doesNotMatch(text, /\{\{/)
  })
})

test('未给 description 时生成的技能不能通过校验', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'draft-skill' })
    const codes = (await validateRepo(root)).map((e) => e.code)
    assert.ok(codes.includes('E_PLACEHOLDER'))
  })
})

test('补全后的技能通过校验', async () => {
  await withSandbox(async (root) => {
    const body = '# 草稿技能\n\n## 何时使用\n\n输入为文本时使用。\n\n## 步骤\n\n1. 读取输入，输出摘要。\n'
    await initSkill({ root, name: 'done-skill', description: '当需要摘要文本时使用。' })
    const file = join(root, 'skills', 'done-skill', 'SKILL.md')
    const { writeFile } = await import('node:fs/promises')
    const head = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n').split('---\n')[1]
    await writeFile(file, `---\n${head}---\n${body}`, 'utf8')
    assert.deepEqual(await validateRepo(root), [])
  })
})

test('CRLF 模板渲染为 LF：autocrlf 克隆的 payload 不产生 CRLF 技能文件', async () => {
  await withSandbox(async (root) => {
    const crlfTemplate = '---\r\nname: {{name}}\r\ndescription: {{description}}\r\n---\r\n\r\n# {{name}}\r\n'
    const rendered = renderSkill(crlfTemplate, { name: 'crlf-skill', description: '当需要测试行尾时使用。' })
    assert.equal(rendered.includes('\r\n'), false, '渲染结果不得含 CRLF')
    await initSkill({ root, name: 'crlf-skill', description: '当需要测试行尾时使用。' })
    const text = await readFile(join(root, 'skills', 'crlf-skill', 'SKILL.md'), 'utf8')
    assert.equal(text.includes('\r'), false, '生成文件不得含 CR')
  })
})

test('name 不合法时拒绝生成', async () => {
  await withSandbox(async (root) => {
    await assert.rejects(initSkill({ root, name: 'Bad_Name' }), /不合法/)
    assert.equal(existsSync(join(root, 'skills', 'Bad_Name')), false)
  })
})

test('目录已存在时拒绝覆盖', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'taken' })
    await assert.rejects(initSkill({ root, name: 'taken' }), /加 --force/)
    await initSkill({ root, name: 'taken', force: true, description: '当需要覆盖时使用。' })
  })
})

test('description 含 ": " 时自动加双引号', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'quoted', description: '用于：测试 a: b' })
    const text = await readFile(join(root, 'skills', 'quoted', 'SKILL.md'), 'utf8')
    assert.match(text, /^description: ".*a: b.*"$/m)
  })
})

test('--workflow 同时生成第一个流程文件，且流程骨架的占位符已替换', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'flow-made', description: '当需要测试流程生成时使用。', withWorkflow: true })
    const wf = join(root, 'skills', 'flow-made', 'workflows', '01-TODO.md')
    assert.ok(existsSync(wf), '应生成 workflows/01-TODO.md')
    const text = await readFile(wf, 'utf8')
    assert.doesNotMatch(text, /\{\{/)
    assert.match(text, /所属技能：flow-made/)
  })
})

test('不带 --workflow 时不生成 workflows 目录', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'plain-made', description: '当需要测试普通生成时使用。' })
    assert.equal(existsSync(join(root, 'skills', 'plain-made', 'workflows')), false)
  })
})

test('--workflow 生成的技能入口仍然能被校验器检查（不因流程缺节而误报）', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'flow-check', description: '当需要检查流程骨架时使用。', withWorkflow: true })
    assert.ok(existsSync(join(root, 'skills', 'flow-check', 'workflows', '01-TODO.md')), '必须真的生成了流程文件')
    const codes = (await validateRepo(root)).map((e) => e.code)
    assert.ok(!codes.includes('E_WORKFLOW_ORDER'), '序号 01 应连续')
    assert.ok(codes.includes('E_PLACEHOLDER'), '骨架仍含 TODO，应被标为占位符，不得悄悄通过')
  })
})

test('--reference / --asset / --agent 各生成一个骨架，标题已替换', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'scaffold-skill', description: '当需要骨架时使用。', withReference: true, withAsset: true, withAgent: true })
    const ref = await readFile(join(root, 'skills', 'scaffold-skill', 'references', '参考件.md'), 'utf8')
    const asset = await readFile(join(root, 'skills', 'scaffold-skill', 'assets', '版式.md'), 'utf8')
    const agent = await readFile(join(root, 'skills', 'scaffold-skill', 'agents', '子代理.md'), 'utf8')
    assert.match(ref, /^# 参考件$/m)
    assert.match(asset, /^# 版式$/m)
    assert.match(agent, /^# 子代理$/m)
    for (const text of [ref, asset, agent]) assert.doesNotMatch(text, /\{\{title\}\}/)
  })
})

test('--force --workflow 不与已有流程重号：下一个序号接在最大序号后', async () => {
  await withSandbox(async (root) => {
    const wf = join(root, 'skills', 'reflow', 'workflows')
    await mkdir(wf, { recursive: true })
    await writeFile(join(wf, '01-切分.md'), '# 切分\n', 'utf8')
    await initSkill({ root, name: 'reflow', description: '当需要重排流程时使用。', withWorkflow: true, force: true })
    assert.ok(existsSync(join(wf, '01-切分.md')), '已有流程应保留')
    assert.ok(existsSync(join(wf, '02-TODO.md')), '新流程应编号 02，不得与 01 重号')
    assert.deepEqual((await readdir(wf)).sort(), ['01-切分.md', '02-TODO.md'])
  })
})

test('已有最大流程序号达到 99 时拒绝继续生成', async () => {
  await withSandbox(async (root) => {
    const wf = join(root, 'skills', 'capped', 'workflows')
    await mkdir(wf, { recursive: true })
    await writeFile(join(wf, '99-收尾.md'), '# 收尾\n', 'utf8')
    await assert.rejects(
      () => initSkill({ root, name: 'capped', description: '当需要测试上限时使用。', withWorkflow: true, force: true }),
      (error) => error instanceof UsageError && error.message.includes('流程序号已达上限 99'),
    )
    assert.equal(existsSync(join(wf, '100-TODO.md')), false, '不得生成三位数序号')
  })
})

test('渲染期错误不被包装成模板缺失（模板读取只收窄 ENOENT）', async () => {
  // readTemplate 只把 ENOENT 转为 TemplateError；渲染函数自身的错误（如模板不是字符串）
  // 须原样上抛，由 main 统一归 E_IO，不得误报「模板缺失」。此处用非法模板输入佐证：
  // 非 ENOENT 的错误不是 TemplateError、也不带「模板缺失」字样。
  assert.throws(
    () => renderSkill(null, { name: 'bad-input', description: '当需要测试错误归类时使用。' }),
    (error) => !(error instanceof Error && error.message.includes('模板缺失')),
  )
})

test('--eval 生成仓库级用例，被测技能写成实际路径', async () => {
  await withSandbox(async (root) => {
    await initSkill({ root, name: 'eval-skill', description: '当需要用例时使用。', withEval: true })
    const file = join(root, 'evals', 'cases', 'eval-skill.md')
    assert.ok(existsSync(file), '必须生成 evals/cases/<name>.md')
    const text = await readFile(file, 'utf8')
    assert.match(text, /^- 被测技能：skills\/eval-skill$/m)
    assert.match(text, /^# eval-skill 冒烟$/m)
    assert.doesNotMatch(text, /\{\{title\}\}/)
  })
})

test('--all 一次生成全部五类骨架', async () => {
  await withSandbox(async (root) => {
    const result = await initSkill({
      root,
      name: 'full-skill',
      description: '当需要全部骨架时使用。',
      withWorkflow: true,
      withReference: true,
      withAsset: true,
      withAgent: true,
      withEval: true,
    })
    assert.equal(result.files.length, 6, '入口 + 流程 + 参考件 + 版式 + 子代理 + 用例')
    for (const rel of result.files) assert.ok(existsSync(join(root, rel)), `缺 ${rel}`)
  })
})

after(async () => {
  await rm(join(here, '.tmp', 'init-skill'), { recursive: true, force: true })
  try {
    await rmdir(join(here, '.tmp'))
  } catch (error) {
    if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
  }
})
