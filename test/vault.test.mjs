// vault 库接口测试：只穿 writeCard 与 checkVault 两个 interface，不再直接调内部薄函数。
// 防的漂移：写卡与修索引脱节、校验漏抓、以及「卡存在但没进索引」这类半完成状态。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeCard, checkVault, SCHEMA_VERSION, defaultPrivate } from '../skills/material-vault/scripts/vault.mjs'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const created = []

// 受限沙箱禁止子进程走管道（EPERM）。与 cli.test.mjs、install-hooks.test.mjs 同一套探测：
// 这条曾经因为漏抄护栏，成了沙箱里唯一失败的测试。
const probe = spawnSync(process.execPath, ['-e', "process.stdout.write('ok')"], { encoding: 'utf8' })
const noSpawn = probe.stdout === 'ok' ? {} : { skip: '当前环境禁止子进程管道（EPERM），CLI 测试需在普通终端运行' }
const cliTest = (name, fn) => test(name, noSpawn, fn)

function makeLib() {
  const root = mkdtempSync(join(tmpdir(), 'sumeru-vault-'))
  created.push(root)
  writeFileSync(join(root, 'VAULT.md'), `# 素材库身份证\n\n版本：${SCHEMA_VERSION}\n简介：测试库\n`, 'utf8')
  return root
}

const card = (over = {}) => ({
  basic: {
    卡名: '表里反差性格核',
    桶: '故事零件',
    类型族: 'S-02 人物设定',
    子类: '原型基底',
    来源: '用户口述',
    来源等级: '单源',
    采集日期: '2026-10-23',
    时效状态: '长期',
    要点: '表层傻乐压低预期，里层认死理绝不回头',
    ...over,
  },
  dimension: { 性格核: '表层傻乐，里层认死理' },
  body: { 内容: '反差性格底盘', 借鉴意图: '借反差结构' },
})

const REL = '故事零件/人物设定/卡-20261023-反差性格核.md'

test('writeCard 一次写完卡与索引，checkVault 全绿', () => {
  const root = makeLib()
  const result = writeCard(root, card(), REL)
  assert.equal(result.ok, true, `写卡失败：${result.issues.join('；')}`)
  assert.ok(existsSync(join(root, REL)), '卡没落盘')
  assert.ok(existsSync(join(root, 'INDEX.md')), '索引没生成')
  assert.deepEqual(checkVault(root), [])
})

test('writeCard 补私有默认值：人物设定为否，开书点子为是', () => {
  const root = makeLib()
  writeCard(root, card(), REL)
  const text = readFileSync(join(root, REL), 'utf8')
  assert.match(text, /^- 私有：否$/m, 'S-02 应默认否')

  const rel2 = '故事零件/开书点子/卡-20261023-点子.md'
  writeCard(root, card({ 卡名: '点子', 桶: '故事零件', 类型族: 'S-01 开书点子', 子类: '高概念' }), rel2)
  assert.match(readFileSync(join(root, rel2), 'utf8'), /^- 私有：是$/m, 'S-01 应默认是')
})

test('writeCard 不覆盖调用方显式给的私有值', () => {
  const root = makeLib()
  writeCard(root, card({ 私有: '是' }), REL)
  assert.match(readFileSync(join(root, REL), 'utf8'), /^- 私有：是$/m)
  assert.equal(defaultPrivate('S-02 人物设定'), '否', '默认值本身不受影响')
})

test('重复写同一张卡不会在索引里产生两行', () => {
  const root = makeLib()
  writeCard(root, card(), REL)
  writeCard(root, card({ 要点: '改过的要点' }), REL)
  const rows = readFileSync(join(root, 'INDEX.md'), 'utf8').split('\n').filter((l) => l.startsWith('| 表里'))
  assert.equal(rows.length, 1, '同一路径应 upsert，不是追加')
  assert.match(rows[0], /改过的要点/, '索引应跟着卡更新')
  assert.deepEqual(checkVault(root), [])
})

test('索引是合法的 GFM 表格：表头与数据行之间不得有空行', () => {
  // readIndex 会跳过空行，所以这个缺陷对机器不可见，只有人看渲染结果时才会发现。
  const root = makeLib()
  writeCard(root, card(), REL)
  const lines = readFileSync(join(root, 'INDEX.md'), 'utf8').split('\n')
  const sep = lines.findIndex((l) => /^\|(-+\|)+-*$/.test(l.replace(/\s/g, '')))
  assert.ok(sep >= 0, '索引缺表头分隔行')
  assert.ok(lines[sep + 1]?.startsWith('|'), `分隔行下一行应是数据行，实际是「${lines[sep + 1]}」`)
})

test('校验不通过时不写任何文件，问题原样交回', () => {
  const root = makeLib()
  const result = writeCard(root, card({ 要点: '这'.repeat(41) }), REL)
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.includes('超 40')))
  assert.equal(existsSync(join(root, REL)), false, '校验失败不得留下半截卡')
  assert.equal(existsSync(join(root, 'INDEX.md')), false, '校验失败不得写索引')
})

test('缺相对路径时拒绝写入并说明格式', () => {
  const root = makeLib()
  const result = writeCard(root, card(), '')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.includes('相对路径')))
})

test('checkVault 抓得出坏卡与「卡未进索引」', () => {
  const root = makeLib()
  writeCard(root, card(), REL)
  // 绕过 writeCard 直接放一张没进索引的卡：这是最容易出现的半完成状态。
  const orphan = '故事零件/人物设定/卡-20261023-孤儿.md'
  writeFileSync(join(root, orphan), readFileSync(join(root, REL), 'utf8').replace('表里反差性格核', '孤儿'), 'utf8')
  const issues = checkVault(root)
  assert.ok(issues.some((i) => i.includes('卡未进索引')), '未抓未进索引的卡')
})

test('checkVault 抓得出索引指向不存在的卡与版本不匹配', () => {
  const root = makeLib()
  writeCard(root, card(), REL)
  writeFileSync(join(root, 'VAULT.md'), '# 素材库身份证\n\n版本：99\n简介：旧库\n', 'utf8')
  rmSync(join(root, REL), { force: true })
  const issues = checkVault(root)
  assert.ok(issues.some((i) => i.includes('须先升级')), '未报版本不匹配')
  assert.ok(issues.some((i) => i.includes('不存在的卡')), '未报断链索引行')
})

test('卡上多余的字段（历史字段）不会在重写时丢失', () => {
  const root = makeLib()
  writeCard(root, card(), REL)
  const withHistory = readFileSync(join(root, REL), 'utf8').replace(/^(- 要点：.*)$/m, '$1\n- 历史字段：旧来源=贴吧')
  writeFileSync(join(root, REL), withHistory, 'utf8')
  writeCard(root, card({ 要点: '再改一次' }), REL)
  const text = readFileSync(join(root, REL), 'utf8')
  assert.match(text, /历史字段：旧来源=贴吧/, '重写卡时历史字段被丢弃')
  assert.match(text, /再改一次/)
})

cliTest('CLI：好库退出码 0，坏库退出码 1', () => {
  const good = makeLib()
  const bad = makeLib()
  writeCard(good, card(), REL)
  const run = (root) => spawnSync(process.execPath, [join(base, 'skills', 'material-vault', 'scripts', 'vault.mjs'), 'check', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const ok = run(good)
  assert.equal(ok.status, 0, `好库应退出码 0，实际 ${ok.status}：${ok.stdout}${ok.stderr}`)
  assert.match(ok.stdout, /库校验通过/)

  const fail = run(bad)
  assert.equal(fail.status, 1, `空库应退出码 1，实际 ${fail.status}`)
  assert.match(fail.stderr, /索引为空/)
})

after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})
