// vault 的 CLI 测试：直接调 runCli 拿退出码与输出，不起子进程。
// 这正是把 io 做成可注入的收益——同一个接口在生产里接 stdout，在测试里接数组，
// 因此这些用例在禁止子进程管道的沙箱里照样跑（那条 spawn 探测只剩一条端到端用例需要）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
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

// 把卡对象落成 JSON 再交给 write 子命令：走的是 agent 真实会走的那条路，
// 而不是直接 import writeCard——CLI 的序列化边界本身也是要测的东西。
function writeCardViaCli(root, card) {
  const file = join(tmp(), 'card.json')
  writeFileSync(file, JSON.stringify(card), 'utf8')
  return run(['write', '--vault', root, '--card', file])
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
  assert.match(meta, /版本：2/)
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

test('index rebuild：从卡重算索引，修好手改造成的漂移', () => {
  // 索引是派生视图，手改它必然与卡分叉。rebuild 的意义就是把这种分叉一次抹平。
  const lib = tmp()
  run(['init', '--vault', lib])
  writeCardViaCli(lib, CARD)

  const indexPath = join(lib, 'INDEX.md')
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('表层傻乐里层认死理', '被人手改过的旧要点'), 'utf8')
  assert.equal(run(['check', '--vault', lib]).code, 1, '手改索引后 check 应报不一致')

  const rebuilt = run(['index', 'rebuild', '--vault', lib])
  assert.equal(rebuilt.code, 0, rebuilt.stdout)
  assert.match(rebuilt.stdout, /1 行/)
  assert.equal(run(['check', '--vault', lib]).code, 0, 'rebuild 后应恢复一致')
})

test('index rebuild --dry-run 只报数，不动索引', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  const before = readFileSync(join(lib, 'INDEX.md'), 'utf8')
  const r = run(['index', 'rebuild', '--vault', lib, '--dry-run'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /将重建/)
  assert.equal(readFileSync(join(lib, 'INDEX.md'), 'utf8'), before, '--dry-run 不该改索引')
})

test('index rebuild 跳过坏卡，好的照收，退出码 1', () => {
  // 一张坏卡不该让整个库失去可用索引——那会把局部错误放大成全库不可用。
  const lib = tmp()
  run(['init', '--vault', lib])
  writeCardViaCli(lib, CARD)
  const badRel = '故事零件/人物设定/卡-20261023-坏.md'
  mkdirSync(join(lib, '故事零件', '人物设定'), { recursive: true })
  writeFileSync(join(lib, badRel), '# 坏卡\n\n## 基本信息\n\n- 卡名：坏\n', 'utf8')

  const r = run(['index', 'rebuild', '--vault', lib])
  assert.equal(r.code, 1, '有坏卡应退出码 1')
  assert.match(r.stdout, /跳过 1 张坏卡/)
  const rows = readFileSync(join(lib, 'INDEX.md'), 'utf8')
  assert.match(rows, /甲/, '好卡应入索引')
  assert.ok(!rows.includes('坏.md'), '坏卡不该入索引')
})

test('index add 只补一张卡，不重扫全库', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  mkdirSync(join(lib, '故事零件', '人物设定'), { recursive: true })
  // 绕过 write 直接放卡，模拟索引里缺一行。
  writeFileSync(join(lib, CARD.relPath), '# 甲\n\n## 基本信息\n\n- 卡名：甲\n- 桶：故事零件\n- 类型族：S-02 人物设定\n- 子类：原型基底\n- 来源：口述\n- 来源等级：单源\n- 采集日期：2026-10-23\n- 时效状态：长期\n- 私有：否\n- 要点：表层傻乐里层认死理\n', 'utf8')
  assert.equal(run(['check', '--vault', lib]).code, 1, '未进索引时 check 应报错')

  const r = run(['index', 'add', '--vault', lib, '--path', CARD.relPath])
  assert.equal(r.code, 0, r.stdout)
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('index add 缺 --path 退出码 2，路径不存在退出码 1', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  assert.equal(run(['index', 'add', '--vault', lib]).code, 2)
  assert.equal(run(['index', 'add', '--vault', lib, '--path', '故事零件/无.md']).code, 1)
})

test('index 缺动作时退出码为 2', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  const r = run(['index', '--vault', lib])
  assert.equal(r.code, 2)
  assert.match(r.stderr, /rebuild 或 add/)
})

test('write 与 rebuild 产出的索引逐字相同，行序不取决于写入顺序', () => {
  // 两条写索引的路径若排序不同，check 会因顺序差异误报，这里钉住它们一致。
  const libA = tmp()
  const libB = tmp()
  for (const lib of [libA, libB]) run(['init', '--vault', lib])
  const second = { ...CARD, relPath: '故事零件/剧情桥段/卡-20261023-乙.md', basic: { ...CARD.basic, 卡名: '乙', 类型族: 'S-03 剧情桥段', 要点: '开局先给一个反常动作' } }

  writeCardViaCli(libA, CARD)
  writeCardViaCli(libA, second)
  writeCardViaCli(libB, second) // 反序写
  writeCardViaCli(libB, CARD)
  run(['index', 'rebuild', '--vault', libB])

  assert.equal(readFileSync(join(libA, 'INDEX.md'), 'utf8'), readFileSync(join(libB, 'INDEX.md'), 'utf8'))
})

// —— 批三：升级到格式版本 2，把「私有」转必填（A-06）

// 造一个格式第 1 版的老库：卡上没有「私有」行，VAULT.md 记版本 1。
function makeV1Lib() {
  const lib = tmp()
  mkdirSync(join(lib, '故事零件', '人物设定'), { recursive: true })
  mkdirSync(join(lib, '故事零件', '开书点子'), { recursive: true })
  writeFileSync(join(lib, 'VAULT.md'), '# 素材库身份证\n\n版本：1\n简介：老库\n', 'utf8')
  const v1Card = (name, family, sub) => `# ${name}\n\n## 基本信息\n\n- 卡名：${name}\n- 桶：故事零件\n- 类型族：${family}\n- 子类：${sub}\n- 来源：口述\n- 出处链接：\n- 来源等级：单源\n- 采集日期：2026-10-01\n- 时效状态：长期\n- 要点：${name}的要点\n\n## 类型维度\n\n- 性格核：反差\n\n## 正文\n\n- 内容：底盘\n`
  const a = join(lib, '故事零件', '人物设定', '卡-20261001-老卡甲.md')
  const b = join(lib, '故事零件', '开书点子', '卡-20261001-老点子.md')
  writeFileSync(a, v1Card('老卡甲', 'S-02 人物设定', '原型基底'), 'utf8')
  writeFileSync(b, v1Card('老点子', 'S-01 开书点子', '高概念'), 'utf8')
  return { lib, cards: [a, b] }
}

test('upgrade --dry-run 列清单且一个字节都不改', () => {
  const { lib, cards } = makeV1Lib()
  const before = cards.map((f) => readFileSync(f, 'utf8'))

  const r = run(['upgrade', '--vault', lib, '--dry-run'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /未落盘/)
  assert.match(r.stdout, /2 张卡/)
  assert.match(r.stdout, /私有=否/)
  assert.match(r.stdout, /私有=是/)
  assert.deepEqual(cards.map((f) => readFileSync(f, 'utf8')), before, '--dry-run 改了文件')
})

test('upgrade 实跑：补私有、版本升 2、check 通过', () => {
  const { lib, cards } = makeV1Lib()
  assert.equal(run(['check', '--vault', lib]).code, 1, 'v1 老库 check 应失败')

  const r = run(['upgrade', '--vault', lib])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(readFileSync(cards[0], 'utf8'), /^- 私有：否$/m)
  assert.match(readFileSync(cards[1], 'utf8'), /^- 私有：是$/m)
  assert.match(readFileSync(join(lib, 'VAULT.md'), 'utf8'), /版本：2/)
  assert.equal(run(['check', '--vault', lib]).code, 0, '升级后 check 应通过')
})

test('upgrade 重跑不产生任何改动：内容与 mtime 均不变', () => {
  // A-06 明写这一条。无条件重写会让每次重跑都刷新 mtime，升级就不再幂等。
  const { lib, cards } = makeV1Lib()
  run(['upgrade', '--vault', lib])
  const targets = [...cards, join(lib, 'VAULT.md'), join(lib, 'INDEX.md')]
  const before = targets.map((f) => ({ text: readFileSync(f, 'utf8'), mtime: statSync(f).mtimeMs }))

  const r = run(['upgrade', '--vault', lib])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /没有要升级的卡/)
  targets.forEach((f, i) => {
    assert.equal(readFileSync(f, 'utf8'), before[i].text, `${f} 内容变了`)
    assert.equal(statSync(f).mtimeMs, before[i].mtime, `${f} 的 mtime 变了，升级不幂等`)
  })
})

test('upgrade 把已删字段挪进「历史字段」，值不丢', () => {
  // 删一个字段不等于删它的数据：老值挪走留着，人还能看回去。
  const { lib, cards } = makeV1Lib()
  writeFileSync(cards[0], readFileSync(cards[0], 'utf8').replace('- 要点：', '- 旧来源：贴吧\n- 要点：'), 'utf8')
  const r = run(['upgrade', '--vault', lib])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  const text = readFileSync(cards[0], 'utf8')
  assert.match(text, /历史字段：旧来源=贴吧/, '老值没挪进历史字段')
  assert.ok(!/^- 旧来源：/m.test(text), '被删字段应已移出基本信息')
})

test('upgrade 对补不出的必填字段填「待补」并退出码 1', () => {
  const { lib, cards } = makeV1Lib()
  writeFileSync(cards[0], readFileSync(cards[0], 'utf8').replace('- 来源等级：单源\n', ''), 'utf8')
  const r = run(['upgrade', '--vault', lib])
  assert.equal(r.code, 1, '有待补字段应退出码 1')
  assert.match(r.stdout, /待补/)
  assert.match(readFileSync(cards[0], 'utf8'), /- 来源等级：待补/)
})

test('upgrade 在缺身份证时退出码 1 并说明原因', () => {
  const lib = tmp()
  const r = run(['upgrade', '--vault', lib])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /缺 VAULT\.md/)
})

test('当前格式的新库跑 upgrade 是空操作', () => {
  const lib = tmp()
  run(['init', '--vault', lib])
  writeCardViaCli(lib, CARD)
  const before = readFileSync(join(lib, CARD.relPath), 'utf8')
  const r = run(['upgrade', '--vault', lib])
  assert.equal(r.code, 0)
  assert.equal(readFileSync(join(lib, CARD.relPath), 'utf8'), before)
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

