// vault.mjs 库接口测试：身份证、索引、卡的读写与校验（J-03/J-06/J-09 的机器判定）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const vault = await import(pathToFileURL(join(base, 'skills', 'material-vault', 'scripts', 'vault.mjs')).href)

function makeLib() {
  const root = mkdtempSync(join(tmpdir(), 'sumeru-vault-'))
  mkdirSync(join(root, '故事零件', '人物设定'), { recursive: true })
  vault.writeVaultMeta(root, '测试库')
  return root
}

const goodCard = (over = {}) => `# 素材卡

## 基本信息

- 卡名：${over.卡名 ?? '表里反差性格核'}
- 桶：${over.桶 ?? '故事零件'}
- 类型族：${over.类型族 ?? 'S-02 人物设定'}
- 子类：${over.子类 ?? '原型基底'}
- 来源：用户口述
- 来源等级：${over.来源等级 ?? '单源'}
- 采集日期：2026-10-23
- 时效状态：${over.时效状态 ?? '长期'}
- 要点：${over.要点 ?? '表层傻乐压低预期，里层认死理绝不回头'}

## 类型维度

- 性格核：表层傻乐，里层认死理

## 正文

- 内容：反差性格底盘
- 原文摘录或事实要点：看着傻乐没心机，其实认死理
- 借鉴意图：借反差结构
- 关联卡：
- 补充记录：
`

test('读写身份证与索引：建库、产卡、落行、校验全绿', () => {
  const root = makeLib()
  try {
    const rel = '故事零件/人物设定/卡-20261023-反差性格核.md'
    writeFileSync(join(root, rel), goodCard())
    const card = vault.readCard(join(root, rel))
    assert.equal(card.basic.卡名, '表里反差性格核')
    vault.appendIndex(root, vault.indexRowFor(card, rel))
    assert.equal(vault.readIndex(root).length, 1)
    assert.deepEqual(vault.checkCard(card), [])
    assert.deepEqual(vault.checkVault(root), [])
    const meta = vault.readVaultMeta(root)
    assert.equal(meta.exists, true)
    assert.equal(typeof meta.version, 'number')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('校验抓得出坏卡：超字要点、非法时效、非法等级、非法桶', () => {
  const root = makeLib()
  try {
    const rel = '故事零件/人物设定/卡-20261023-坏卡.md'
    const bad = goodCard({
      要点: '这'.repeat(45),
      时效状态: '新鲜',
      来源等级: '可靠',
      桶: '攒料',
    })
    writeFileSync(join(root, rel), bad)
    const card = vault.readCard(join(root, rel))
    const issues = vault.checkCard(card)
    assert.ok(issues.some((i) => i.includes('超 40')), '未抓要点超字（J-03）')
    assert.ok(issues.some((i) => i.includes('时效状态')), '未抓非法时效（J-06）')
    assert.ok(issues.some((i) => i.includes('来源等级')), '未抓非法来源等级（J-09）')
    assert.ok(issues.some((i) => i.includes('桶')), '未抓非法桶')
    vault.appendIndex(root, vault.indexRowFor(card, rel))
    const vaultIssues = vault.checkVault(root)
    assert.ok(vaultIssues.length >= 4, '整库校验未聚齐坏卡问题')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('版本不匹配与断链索引行都会被报', () => {
  const root = makeLib()
  try {
    writeFileSync(join(root, 'VAULT.md'), '# 素材库身份证\n\n版本：99\n简介：旧库\n')
    vault.appendIndex(root, { 卡名: '幽灵', 桶: '故事零件', 类型族: 'S-02', 子类: 'x', 要点: 'y', 时效: '长期', 相对路径: '不存在/卡.md' })
    const issues = vault.checkVault(root)
    assert.ok(issues.some((i) => i.includes('须先升级')), '未报版本不匹配')
    assert.ok(issues.some((i) => i.includes('不存在的卡')), '未报断链索引行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI：好库退出码 0，坏库退出码 1', () => {
  const good = makeLib()
  const bad = makeLib()
  try {
    const rel = '故事零件/人物设定/卡-20261023-反差性格核.md'
    writeFileSync(join(good, rel), goodCard())
    vault.appendIndex(good, vault.indexRowFor(vault.readCard(join(good, rel)), rel))
    const run = (root) => execFileSync('node', [join(base, 'skills', 'material-vault', 'scripts', 'vault.mjs'), 'check', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(run(good), /库校验通过/)
    writeFileSync(join(bad, 'VAULT.md'), '# 素材库身份证\n\n版本：1\n简介：坏库\n')
    assert.throws(() => run(bad), (e) => e.status === 1 && /索引为空/.test(e.stderr), '空库应退出码 1')
  } finally {
    rmSync(good, { recursive: true, force: true })
    rmSync(bad, { recursive: true, force: true })
  }
})
