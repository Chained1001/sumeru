import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../skills/material-vault/scripts/vault.mjs'

const REL_A = '故事零件/人物设定/卡-20261001-老卡甲.md'
const REL_B = '故事零件/人物设定/卡-20261001-老卡乙.md'

function oldCard(name, sourceLevel = '单源') {
  return `# ${name}\n\n## 基本信息\n\n- 卡名：${name}\n- 大类：故事零件\n- 类型：S-02 人物设定\n- 细分：原型基底\n- 来源：口述\n- 来源等级：${sourceLevel}\n- 采集日期：2026-10-01\n- 时效状态：长期\n- 要点：${name}的反差\n\n## 类型维度\n\n- 性格核：反差\n\n## 正文\n\n- 内容：原有内容\n`
}

function library(t) {
  const root = mkdtempSync(join(tmpdir(), 'sumeru-upgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '故事零件', '人物设定'), { recursive: true })
  writeFileSync(join(root, 'VAULT.md'), '# 素材库身份证\n\n版本：1\n简介：混合老库\n', 'utf8')
  writeFileSync(join(root, REL_A), oldCard('老卡甲'), 'utf8')
  writeFileSync(join(root, REL_B), oldCard('老卡乙'), 'utf8')
  return root
}

function run(root, ...args) {
  const out = []
  const err = []
  const code = runCli([...args, '--vault', root, '--json'], { out: (s) => out.push(s), err: (s) => err.push(s) })
  return { code, result: JSON.parse(out.join('\n')), stderr: err.join('\n') }
}

function snapshot(files) {
  return files.map((file) => ({ text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs }))
}

test('upgrade 重跑仍报告已有待补，不改文件也不误报完成', (t) => {
  const root = library(t)
  writeFileSync(join(root, REL_A), oldCard('老卡甲', ''), 'utf8')
  assert.equal(run(root, 'upgrade').code, 1)
  const files = [REL_A, REL_B, 'VAULT.md', 'INDEX.md'].map((rel) => join(root, rel))
  const before = snapshot(files)
  const again = run(root, 'upgrade')
  assert.equal(again.code, 1, '已有待补没有被用户填好，重跑不能宣布成功')
  assert.equal(again.result.ok, false)
  assert.ok(again.result.errors.some((e) => e.file === REL_A && /来源等级.*待补/.test(e.message)))
  assert.deepEqual(snapshot(files), before, '重跑需保持内容与 mtime 不变')
})

test('upgrade 单卡写入失败会列明路径、继续升级其余卡，修复后重跑可恢复', (t) => {
  const root = library(t)
  // 将原子写的临时目标占成目录，跨平台稳定制造这张卡的写入错误。
  const blocked = join(root, `${REL_A}.tmp-${process.pid}`)
  mkdirSync(blocked)
  const failed = run(root, 'upgrade')
  assert.equal(failed.code, 1)
  assert.equal(failed.result.ok, false)
  assert.ok(failed.result.errors.some((e) => e.file === REL_A), '失败清单缺少坏卡路径')
  assert.match(readFileSync(join(root, REL_B), 'utf8'), /- 私有：否/)
  assert.match(readFileSync(join(root, REL_B), 'utf8'), /历史正文：内容=原有内容/)
  assert.match(readFileSync(join(root, 'VAULT.md'), 'utf8'), /版本：1/, '有卡写入失败时不能把整库标成已升级')

  rmSync(blocked, { recursive: true })
  const recovered = run(root, 'upgrade')
  assert.equal(recovered.code, 0, JSON.stringify(recovered.result))
  assert.equal(run(root, 'check').code, 0)
  const files = [REL_A, REL_B, 'VAULT.md', 'INDEX.md'].map((rel) => join(root, rel))
  const before = snapshot(files)
  assert.equal(run(root, 'upgrade').code, 0)
  assert.deepEqual(snapshot(files), before, '恢复后重跑仍应幂等')
})

test('upgrade 非法枚举不被当作升级成功，也不妨碍好卡升级', (t) => {
  const root = library(t)
  const bad = oldCard('老卡甲', '听说可信')
  writeFileSync(join(root, REL_A), bad, 'utf8')
  const failed = run(root, 'upgrade')
  assert.equal(failed.code, 1)
  assert.equal(failed.result.ok, false)
  assert.ok(failed.result.errors.some((e) => e.file === REL_A && /来源等级/.test(e.message)))
  assert.equal(readFileSync(join(root, REL_A), 'utf8'), bad, '不能猜测并覆盖非法来源等级')
  assert.match(readFileSync(join(root, REL_B), 'utf8'), /- 私有：否/)
  assert.match(readFileSync(join(root, 'VAULT.md'), 'utf8'), /版本：1/)
})

test('upgrade dry-run 报出待补但不写占位值、不声称已写', (t) => {
  const root = library(t)
  writeFileSync(join(root, REL_A), oldCard('老卡甲', ''), 'utf8')
  const files = [REL_A, REL_B, 'VAULT.md'].map((rel) => join(root, rel))
  const before = snapshot(files)
  const out = []
  const code = runCli(['upgrade', '--vault', root, '--dry-run'], { out: (s) => out.push(s), err: () => {} })
  assert.equal(code, 1)
  assert.match(out.join('\n'), /未落盘/)
  assert.match(out.join('\n'), /未写入占位值/)
  assert.doesNotMatch(out.join('\n'), /已填「待补」/)
  assert.deepEqual(snapshot(files), before)
  assert.equal(existsSync(join(root, 'INDEX.md')), false, '空跑不应创建索引')
})

test('upgrade 卡已落盘但索引失败，重跑仍修复索引并完成版本升级', (t) => {
  const root = library(t)
  const index = join(root, 'INDEX.md')
  mkdirSync(index)
  const failed = run(root, 'upgrade')
  assert.equal(failed.code, 1)
  assert.equal(failed.result.ok, false)
  assert.match(readFileSync(join(root, REL_A), 'utf8'), /- 私有：否/)
  assert.match(readFileSync(join(root, REL_B), 'utf8'), /- 私有：否/)
  assert.match(readFileSync(join(root, 'VAULT.md'), 'utf8'), /版本：1/)
  rmSync(index, { recursive: true })
  assert.equal(run(root, 'upgrade').code, 0)
  assert.equal(run(root, 'check').code, 0)
  const files = [REL_A, REL_B, 'VAULT.md', 'INDEX.md'].map((rel) => join(root, rel))
  const before = snapshot(files)
  assert.equal(run(root, 'upgrade').code, 0)
  assert.deepEqual(snapshot(files), before)
})
