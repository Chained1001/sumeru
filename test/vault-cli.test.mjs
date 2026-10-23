// vault 的 CLI 测试：直接调 runCli 拿退出码与输出，不起子进程。
// 这正是把 io 做成可注入的收益——同一个接口在生产里接 stdout，在测试里接数组，
// 因此这些用例在禁止子进程管道的沙箱里照样跑（那条 spawn 探测只剩一条端到端用例需要）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli, parseCliArgs } from '../skills/material-vault/scripts/vault.mjs'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const created = []

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'sumeru-cli-'))
  created.push(dir)
  return dir
}

// 假 adapter：收输出、收退出码，不碰真进程。
function run(argv, cwd = process.cwd()) {
  const out = []
  const err = []
  const code = runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), cwd })
  return { code, stdout: out.join('\n'), stderr: err.join('\n') }
}

const CARD = {
  relPath: '故事零件/人物设定/卡-20261023-甲.md',
  basic: { 卡名: '甲', 桶: '故事零件', 类型族: 'S-02 人物设定', 子类: '原型基底', 来源: '口述', 来源等级: '单源', 采集日期: '2026-10-23', 时效状态: '长期', 要点: '表层傻乐里层认死理' },
  dimension: { 性格核: '反差' },
  body: { 内容: '底盘' },
}

test('--help 输出用法且退出码为 0', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /子命令/)
  assert.match(r.stdout, /detect/)
  assert.match(r.stdout, /init/)
})

test('无子命令时打用法，退出码为 2', () => {
  const r = run([])
  assert.equal(r.code, 2)
  assert.match(r.stdout, /用法/)
})

test('未知参数与未知子命令退出码为 2', () => {
  assert.equal(run(['check', '--nope']).code, 2)
  assert.equal(run(['没这个命令']).code, 2)
})

test('需要值的旗标缺值时退出码为 2，且不把下一个旗标当值', () => {
  assert.equal(run(['init', '--vault']).code, 2)
  assert.equal(run(['init', '--vault', '--json']).code, 2)
  assert.throws(() => parseCliArgs(['init', '--vault']), /需要一个值/)
})

test('detect：指定、就近、未找到三种回报', () => {
  const lib = tmp()
  assert.equal(run(['init', '--vault', lib]).code, 0)

  const given = run(['detect', '--vault', lib])
  assert.equal(given.code, 0)
  assert.match(given.stdout, /指定/)

  // 从桶目录里往上看，应命中库根：这是「就近」的真实用法。
  const near = run(['detect'], join(lib, '故事零件'))
  assert.equal(near.code, 0)
  assert.match(near.stdout, /就近/)

  const none = run(['detect'], tmp())
  assert.equal(none.code, 1)
  assert.match(none.stdout, /未找到库/)
})

test('init 一次写齐身份证、索引表头与四个桶目录', () => {
  const lib = join(tmp(), '素材库')
  const r = run(['init', '--vault', lib, '--intro', '我的库'])
  assert.equal(r.code, 0, r.stdout)
  for (const name of ['VAULT.md', 'INDEX.md', '故事零件', '写作方法', '作品案例', '现实避坑']) {
    assert.ok(existsSync(join(lib, name)), `init 未建出 ${name}`)
  }
  const meta = readFileSync(join(lib, 'VAULT.md'), 'utf8')
  assert.match(meta, /版本：1/)
  assert.match(meta, /简介：我的库/)
})

test('init 不覆盖已有库，退出码为 1', () => {
  const lib = tmp()
  assert.equal(run(['init', '--vault', lib]).code, 0)
  const again = run(['init', '--vault', lib])
  assert.equal(again.code, 1)
  assert.match(again.stdout, /已是素材库/)
})

test('刚 init 的空库 check 通过：空索引不是错', () => {
  // 这条防的是把「没有卡」误报成「索引缺失」——新建库本来就该一张卡也没有。
  const lib = tmp()
  run(['init', '--vault', lib])
  const r = run(['check', '--vault', lib])
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /0 张卡/)
})

test('write 写入卡并同步索引，退出码 0', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  const cardFile = join(tmp(), 'card.json')
  writeFileSync(cardFile, JSON.stringify(CARD), 'utf8')
  const r = run(['write', '--vault', lib, '--card', cardFile])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.ok(existsSync(join(lib, CARD.relPath)))
  assert.match(readFileSync(join(lib, 'INDEX.md'), 'utf8'), /甲/)
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('write 缺 --card 退出码为 2，坏 JSON 退出码为 2', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  assert.equal(run(['write', '--vault', lib]).code, 2)

  const bad = join(tmp(), 'bad.json')
  writeFileSync(bad, '{不是 json', 'utf8')
  assert.equal(run(['write', '--vault', lib, '--card', bad]).code, 2)
})

test('write 校验不通过退出码为 1，且不落任何文件', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  const cardFile = join(tmp(), 'card.json')
  writeFileSync(cardFile, JSON.stringify({ ...CARD, basic: { ...CARD.basic, 要点: '这'.repeat(41) } }), 'utf8')
  const r = run(['write', '--vault', lib, '--card', cardFile])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /超 40/)
  assert.equal(existsSync(join(lib, CARD.relPath)), false)
})

test('--json 输出单个可解析对象，形状稳定', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  const r = run(['check', '--vault', lib, '--json'])
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.errors, [])
  assert.equal(payload.data.cards, 0)
})

test('--json 在参数错误时也给 JSON 而不是纯文本', () => {
  // 调用方加了 --json 就是在程序化消费，任一出错路径都得是同一形状。
  const r = run(['check', '--nope', '--json'])
  assert.equal(r.code, 2)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.ok, false)
  assert.ok(payload.error)
})

test('没有一个子命令会调 process.exit：脚本作为模块被 import 时不杀宿主', () => {
  // process.exit 会在 import 时直接终止调用方进程，测试里无法捕获，只能静态查源码。
  const source = readFileSync(join(base, 'skills', 'material-vault', 'scripts', 'vault.mjs'), 'utf8')
  const calls = [...source.matchAll(/process\.exit\s*\(/g)]
  assert.equal(calls.length, 0, 'vault.mjs 又出现 process.exit，会杀掉宿主进程；请改为返回退出码')
})

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})
