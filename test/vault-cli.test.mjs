// vault 的 CLI 测试：直接调 runCli 拿退出码与输出，不起子进程。
// 这正是把 io 做成可注入的收益——同一个接口在生产里接 stdout，在测试里接数组，
// 因此这些用例在禁止子进程管道的沙箱里照样跑（那条 spawn 探测只剩一条端到端用例需要）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs'
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
// —— 批四：卡管理（F-14、A-07、A-12）。五个动作都走 runCli，不起子进程。
// 判据里反复出现「每步后 check 退出码 0」：索引是派生视图，改卡、删卡、挪类型若只动了文件没动索引，
// 下一步检索就会拿到断链的行，这种漂移只能靠 check 抓。

// 造一个带两张卡的库：甲在人物设定，乙在剧情桥段，两者都带补充记录与关联卡（merge 要两边都有值）。
function makeCardLib() {
  const lib = tmp()
  run(['init', '--vault', lib])
  const a = { ...CARD, body: { ...CARD.body, 补充记录: '2026-10-20 补了原型', 关联卡: '卡-丙' } }
  const b = {
    relPath: '故事零件/剧情桥段/卡-20261023-乙.md',
    basic: { ...CARD.basic, 卡名: '乙', 类型族: 'S-03 剧情桥段', 要点: '开局先给一个反常动作' },
    dimension: { 冲突结构: '反常动作钩子' },
    body: { 内容: '乙的底盘', 补充记录: '2026-10-21 补了变体', 关联卡: '卡-丁' },
  }
  assert.equal(writeCardViaCli(lib, a).code, 0)
  assert.equal(writeCardViaCli(lib, b).code, 0)
  assert.equal(run(['check', '--vault', lib]).code, 0, '夹具本身应是干净的库')
  return { lib, a, b }
}

const cardText = (lib, rel) => readFileSync(join(lib, rel), 'utf8')
const indexRows = (lib) => readFileSync(join(lib, 'INDEX.md'), 'utf8').split('\n').filter((l) => /^\| (?!卡名)/.test(l) && l.startsWith('|'))
const TRASH = '已删卡片'

test('card edit 改要点：卡与索引一起改，check 退出码 0', () => {
  const { lib } = makeCardLib()
  const r = run(['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '要点', '--value', '改过的要点'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(cardText(lib, CARD.relPath), /^- 要点：改过的要点$/m)
  assert.match(readFileSync(join(lib, 'INDEX.md'), 'utf8'), /改过的要点/, '索引没跟着卡改')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card edit 可改类型维度节的字段，也可清空可选字段', () => {
  const { lib } = makeCardLib()
  const dim = run(['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '性格核', '--value', '表里反差', '--section', '类型维度'])
  assert.equal(dim.code, 0, dim.stdout)
  assert.match(cardText(lib, CARD.relPath), /^- 性格核：表里反差$/m)

  const empty = run(['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '出处链接', '--value', ''])
  assert.equal(empty.code, 0, '清空可选字段是合法改法，不该被当成缺 --value')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card edit 拒绝改桶与类型族：那两行决定了文件位置，须走 card move', () => {
  const { lib } = makeCardLib()
  const r = run(['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '桶', '--value', '写作方法'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /card move/)
  assert.match(cardText(lib, CARD.relPath), /^- 桶：故事零件$/m, '被拒绝时不得改动卡')
})

test('card edit 不新建卡上没有的字段，check 仍为 0', () => {
  const { lib } = makeCardLib()
  const r = run(['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '不存在的字段', '--value', 'x'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /不新建/)
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card delete 把卡移进 已删卡片/ 并保留原相对路径；check 不因它报错', () => {
  const { lib } = makeCardLib()
  const r = run(['card', 'delete', '--vault', lib, '--path', CARD.relPath])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.equal(existsSync(join(lib, CARD.relPath)), false, '原位置应已空出')
  assert.ok(existsSync(join(lib, TRASH, CARD.relPath)), `已删卡片/ 里应保留原相对路径：${TRASH}/${CARD.relPath}`)
  assert.ok(!readFileSync(join(lib, 'INDEX.md'), 'utf8').includes(CARD.relPath), '索引行应已删除')
  assert.equal(run(['check', '--vault', lib]).code, 0, '回收站里的卡不算活卡，check 不该报「卡未进索引」')
  assert.equal(indexRows(lib).length, 1, '索引行数应等于活卡数')
})

test('A-07：删掉的卡能用 restore 找回到原路径，索引行一并补回', () => {
  const { lib } = makeCardLib()
  const rel = CARD.relPath
  const before = cardText(lib, rel)
  assert.equal(run(['card', 'delete', '--vault', lib, '--path', rel]).code, 0)

  const r = run(['card', 'restore', '--vault', lib, '--path', rel])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.ok(existsSync(join(lib, rel)), 'restore 应放回原路径')
  assert.equal(cardText(lib, rel), before, 'restore 不该改卡的内容')
  assert.ok(!existsSync(join(lib, TRASH, rel)), '回收站里的那份应已移走')
  assert.match(readFileSync(join(lib, 'INDEX.md'), 'utf8'), new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '索引行应补回')
  assert.equal(run(['check', '--vault', lib]).code, 0)
  assert.equal(indexRows(lib).length, 2, '索引行数与卡数相等（A-07 判据）')
})

test('restore 遇到原位置已占用时退出码 1，且不覆盖那张卡', () => {
  const { lib, a } = makeCardLib()
  assert.equal(run(['card', 'delete', '--vault', lib, '--path', a.relPath]).code, 0)
  // 删完再在同名位置建一张同路径的新卡，模拟「删了又建同名卡」。
  assert.equal(writeCardViaCli(lib, { ...a, basic: { ...a.basic, 卡名: '新甲', 要点: '新卡的要点' } }).code, 0)

  const r = run(['card', 'restore', '--vault', lib, '--path', a.relPath])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /已被占用/)
  assert.match(cardText(lib, a.relPath), /^- 卡名：新甲$/m, '占用位置的那张卡被覆盖了')
  assert.ok(existsSync(join(lib, TRASH, a.relPath)), 'restore 失败时回收站里的卡应原样留着')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card restore 对不在回收站的路径退出码 1，不凭空造卡', () => {
  const { lib } = makeCardLib()
  const r = run(['card', 'restore', '--vault', lib, '--path', '故事零件/人物设定/卡-20261023-无.md'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /已删卡片/)
  assert.equal(existsSync(join(lib, '故事零件/人物设定/卡-20261023-无.md')), false)
})

test('card merge：两边的补充记录与关联卡都留下，被并入卡进 已删卡片/', () => {
  const { lib, a, b } = makeCardLib()
  const r = run(['card', 'merge', '--vault', lib, '--from', b.relPath, '--into', a.relPath])
  assert.equal(r.code, 0, r.stdout + r.stderr)

  const text = cardText(lib, a.relPath)
  assert.match(text, /补充记录：2026-10-20 补了原型；2026-10-21 补了变体/, '两边的补充记录应都在，用「；」连接')
  assert.match(text, /关联卡：卡-丙；卡-丁/, '两边的关联卡应都在，不丢任何一边')
  assert.ok(!existsSync(join(lib, b.relPath)), '被并入卡应离开原位置')
  assert.ok(existsSync(join(lib, TRASH, b.relPath)), '被并入卡应进 已删卡片/')
  assert.ok(!readFileSync(join(lib, 'INDEX.md'), 'utf8').includes(b.relPath), '索引里不该再有被并入卡的行')
  assert.equal(run(['check', '--vault', lib]).code, 0)
  assert.equal(indexRows(lib).length, 1, '合并后索引行数与活卡数相等')
})

test('card merge 在只有一边有值时直接搬过去，不留下孤零零的分号', () => {
  const { lib, a, b } = makeCardLib()
  // 把被并入卡的补充记录清空，只剩关联卡有值。
  assert.equal(run(['card', 'edit', '--vault', lib, '--path', b.relPath, '--field', '补充记录', '--value', '', '--section', '正文']).code, 0)
  assert.equal(run(['card', 'merge', '--vault', lib, '--from', b.relPath, '--into', a.relPath]).code, 0)
  const text = cardText(lib, a.relPath)
  assert.match(text, /^- 补充记录：2026-10-20 补了原型$/m, '目标卡原有的值应原样保留，不该被空值拼上分号')
  assert.match(text, /^- 关联卡：卡-丙；卡-丁$/m)
})

test('card merge 指向同一张卡或指向回收站里的卡时退出码 1', () => {
  const { lib, a, b } = makeCardLib()
  assert.equal(run(['card', 'merge', '--vault', lib, '--from', a.relPath, '--into', a.relPath]).code, 1)

  assert.equal(run(['card', 'delete', '--vault', lib, '--path', b.relPath]).code, 0)
  const r = run(['card', 'merge', '--vault', lib, '--from', b.relPath, '--into', a.relPath])
  assert.equal(r.code, 1, '已删卡不参与合并')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card move：桶与类型族两行与目录一起改，文件名不变', () => {
  const { lib } = makeCardLib()
  const next = '故事零件/剧情桥段/卡-20261023-甲.md'
  const r = run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件', '--family', 'S-03 剧情桥段'])
  assert.equal(r.code, 0, r.stdout + r.stderr)

  assert.ok(existsSync(join(lib, next)), '文件应在新目录')
  assert.equal(existsSync(join(lib, CARD.relPath)), false, '旧位置应空出')
  const text = cardText(lib, next)
  assert.match(text, /^- 桶：故事零件$/m)
  assert.match(text, /^- 类型族：S-03 剧情桥段$/m)
  // 目录取族名不带编号：注册表的产卡路径是 素材库/<桶>/<族名>/。
  assert.equal(dirname(next).split('/')[1], '剧情桥段')
  const index = readFileSync(join(lib, 'INDEX.md'), 'utf8')
  assert.ok(!index.includes(CARD.relPath), '索引里不该留旧路径的行')
  assert.match(index, /S-03 剧情桥段/, '索引行应跟上新的类型族')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card move 新路径已存在时退出码 1，不覆盖也不动卡', () => {
  const { lib } = makeCardLib()
  // 甲的第一次挪类型占住 剧情桥段/卡-20261023-甲.md，再写一张同名卡回人物设定，就撞上了。
  const moved = '故事零件/剧情桥段/卡-20261023-甲.md'
  assert.equal(run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件', '--family', 'S-03 剧情桥段']).code, 0)
  assert.equal(writeCardViaCli(lib, { ...CARD, basic: { ...CARD.basic, 要点: '第二张甲' } }).code, 0)

  const r = run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件', '--family', 'S-03 剧情桥段'])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /已存在/)
  assert.match(cardText(lib, CARD.relPath), /^- 要点：第二张甲$/m, '被拒绝时旧位置的卡不得改动')
  assert.match(cardText(lib, moved), /^- 要点：表层傻乐里层认死理$/m, '已在新位置的卡不得被覆盖')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card move 换桶：跨桶时目录与「桶」行一起改', () => {
  const { lib } = makeCardLib()
  const next = '写作方法/写作技巧/卡-20261023-甲.md'
  const r = run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '写作方法', '--family', 'S-07 写作技巧'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.ok(existsSync(join(lib, next)))
  assert.match(cardText(lib, next), /^- 桶：写作方法$/m)
  assert.match(cardText(lib, next), /^- 类型族：S-07 写作技巧$/m)
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card move 拒绝不合法的桶与非注册表段式的类型族', () => {
  const { lib } = makeCardLib()
  assert.equal(run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '杂项', '--family', 'S-03 剧情桥段']).code, 1)
  assert.equal(run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件', '--family', '剧情桥段']).code, 1)
  assert.equal(run(['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件', '--family', 'S-03 剧情桥段']).code, 0, '同位置且字段已对得上时应视作未移动，退出码 0')
})

test('A-12：连续做「挪类型 → 改要点 → 删卡」，每步后 check 均为 0，全程不手改 INDEX.md', () => {
  // 判据里那句「全程没有手改 INDEX.md」，落到测试上就是：除了 CLI，没人写这个文件。
  // 因此这里只断言 CLI 的结果，索引的每个中间态都由 check 逐列对账兜住。
  const { lib } = makeCardLib()
  const indexSnapshots = [readFileSync(join(lib, 'INDEX.md'), 'utf8')]

  const next = '故事零件/剧情桥段/卡-20261023-甲.md'
  for (const argv of [
    ['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件', '--family', 'S-03 剧情桥段'],
    ['card', 'edit', '--vault', lib, '--path', next, '--field', '要点', '--value', '挪过之后再改的要点'],
    ['card', 'delete', '--vault', lib, '--path', next],
  ]) {
    const step = run(argv)
    assert.equal(step.code, 0, `${argv.slice(0, 2).join(' ')} 失败：${step.stdout}${step.stderr}`)
    assert.equal(run(['check', '--vault', lib]).code, 0, `${argv.slice(0, 2).join(' ')} 之后 check 未通过`)
    assert.equal(indexRows(lib).length, listCardCount(lib), `${argv.slice(0, 2).join(' ')} 之后索引行数与卡数不等`)
    indexSnapshots.push(readFileSync(join(lib, 'INDEX.md'), 'utf8'))
  }
  assert.match(indexSnapshots[1], /剧情桥段/, '挪类型后索引应指向新类型族')
  assert.match(indexSnapshots[2], /挪过之后再改的要点/, '改要点后索引应跟着改')
  assert.ok(!indexSnapshots[3].includes('卡-20261023-甲'), '删卡后索引不该再有这一行')
})

// 活卡数：桶目录下以「卡-」开头的 .md，不含 已删卡片/。与 vault.mjs 的 listCards 同一口径。
function listCardCount(lib) {
  let n = 0
  const walk = (dir, depth) => {
    if (depth > 2 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === TRASH) continue
      if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1)
      else if (/^卡-.+\.md$/.test(entry.name)) n++
    }
  }
  walk(lib, 0)
  return n
}

test('card 系列：参数缺失退出码 2，目标卡不存在退出码 1', () => {
  const { lib } = makeCardLib()
  const missing = [
    ['card'],
    ['card', 'edit', '--vault', lib, '--path', CARD.relPath],
    ['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '要点'],
    ['card', 'delete', '--vault', lib],
    ['card', 'restore', '--vault', lib],
    ['card', 'merge', '--vault', lib, '--from', CARD.relPath],
    ['card', 'merge', '--vault', lib, '--into', CARD.relPath],
    ['card', 'move', '--vault', lib, '--path', CARD.relPath, '--bucket', '故事零件'],
    ['card', 'move', '--vault', lib, '--path', CARD.relPath, '--family', 'S-03 剧情桥段'],
    ['card', '没这个动作', '--vault', lib],
  ]
  for (const argv of missing) assert.equal(run(argv).code, 2, `参数不全时应退出码 2：${argv.join(' ')}`)
  assert.equal(run(['card', 'edit', '--vault', lib, '--json']).code, 2, '--json 在参数错误时也是 2')

  const absent = '故事零件/人物设定/卡-20261023-无.md'
  for (const argv of [
    ['card', 'edit', '--vault', lib, '--path', absent, '--field', '要点', '--value', 'x'],
    ['card', 'delete', '--vault', lib, '--path', absent],
    ['card', 'restore', '--vault', lib, '--path', absent],
    ['card', 'move', '--vault', lib, '--path', absent, '--bucket', '故事零件', '--family', 'S-03 剧情桥段'],
  ]) {
    assert.equal(run(argv).code, 1, `目标卡不存在时应退出码 1：${argv.join(' ')}`)
  }
  assert.equal(run(['card', 'merge', '--vault', lib, '--from', absent, '--into', CARD.relPath]).code, 1)
})

test('card 系列拒绝库外路径与不像卡的文件名，退出码 1', () => {
  const { lib } = makeCardLib()
  for (const bad of ['../卡-20261023-甲.md', join(lib, CARD.relPath), '故事零件/人物设定/随便.md']) {
    assert.equal(run(['card', 'delete', '--vault', lib, '--path', bad]).code, 1, `越界或非卡的路径应拒绝：${bad}`)
  }
  assert.ok(existsSync(join(lib, CARD.relPath)), '被拒绝的路径不该动到任何卡')
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('check 抓得出「索引里还留着已删卡的行」', () => {
  // delete 只搬文件没清索引，就是这个样子：文件不在活卡区，索引却还指着一个回收站路径。
  const { lib } = makeCardLib()
  assert.equal(run(['card', 'delete', '--vault', lib, '--path', CARD.relPath]).code, 0)
  writeFileSync(
    join(lib, 'INDEX.md'),
    readFileSync(join(lib, 'INDEX.md'), 'utf8') + `| 甲 | 故事零件 | S-02 人物设定 | 原型基底 | x | 长期 | ${TRASH}/${CARD.relPath} |\n`,
    'utf8',
  )
  const r = run(['check', '--vault', lib])
  assert.equal(r.code, 1)
  assert.match(r.stdout, /已删卡/)
  // index rebuild 是修法：重建后这条幽灵行消失，check 回到 0。
  assert.equal(run(['index', 'rebuild', '--vault', lib]).code, 0)
  assert.equal(run(['check', '--vault', lib]).code, 0)
})

test('card --json 输出同一形状：成功与业务失败都带 ok、data、errors', () => {
  const { lib } = makeCardLib()
  const ok = run(['card', 'edit', '--vault', lib, '--path', CARD.relPath, '--field', '要点', '--value', 'json 改的', '--json'])
  assert.equal(ok.code, 0)
  const okPayload = JSON.parse(ok.stdout)
  assert.equal(okPayload.ok, true)
  assert.deepEqual(okPayload.errors, [])
  assert.equal(okPayload.data.action, 'edit')
  assert.equal(okPayload.data.relPath, CARD.relPath)

  const bad = run(['card', 'delete', '--vault', lib, '--path', '故事零件/人物设定/卡-20261023-无.md', '--json'])
  assert.equal(bad.code, 1)
  const badPayload = JSON.parse(bad.stdout)
  assert.equal(badPayload.ok, false)
  assert.ok(badPayload.errors.length)
  assert.deepEqual(badPayload.data, { action: 'delete' })
})

test('--help 列出五个 card 动作与它们的选项', () => {
  const r = run(['--help'])
  assert.equal(r.code, 0)
  for (const word of ['card edit', 'card delete', 'card restore', 'card merge', 'card move', '--field', '--value', '--section', '--from', '--into', '--bucket', '--family']) {
    assert.ok(r.stdout.includes(word), `--help 缺「${word}」`)
  }
})

// —— 批五：流程文件层面的约束（F-07、F-16）。五小节齐全与序号连续归 validate.mjs 管，
// 这里只钉两条机器能钉、且漂了不会有人发现的规则：浏览的日期从哪来、浏览不许写库。
const workflow = (name) => readFileSync(join(base, 'skills', 'material-vault', 'workflows', name), 'utf8')

test('06 浏览：最近 5 张的日期只从文件名的 YYYYMMDD 段取，不读卡正文', () => {
  const text = workflow('06-浏览.md')
  assert.match(text, /YYYYMMDD/, '流程没写清日期段的形状，agent 只能猜')
  assert.match(text, /文件名/, '流程没把日期来源钉在文件名上')
  // 索引列里确实没有采集日期：这是「只能读文件名」的根据，写进流程才算说清为什么。
  const cols = readFileSync(join(base, 'skills', 'material-vault', 'scripts', 'cardFormat.mjs'), 'utf8')
  const indexCols = /export const INDEX_COLUMNS = \[([^\]]*)\]/.exec(cols)[1]
  assert.ok(!indexCols.includes('采集日期'), '索引列里已有采集日期，流程该改为直接读索引列')
  assert.match(text, /不读卡正文|不打开卡/, '流程没写明不读卡正文（F-16 的省上下文要求）')
})

test('06 浏览是只读流程：不出现任何写库子命令', () => {
  const text = workflow('06-浏览.md')
  const writeCommands = [...text.matchAll(/vault\.mjs (write|init|upgrade|index|card|check)/g)].map((m) => m[1])
  assert.deepEqual(writeCommands, [], `只读流程里出现了写库子命令：${writeCommands.join('、')}`)
})

test('05 库定位：只给「新建」与「指向已有」两选，收编交回 07 而不自己发挥', () => {
  const text = workflow('05-库定位.md')
  assert.match(text, /新建/, '缺「新建」这一支')
  assert.match(text, /指向已有/, '缺「指向已有」这一支')
  // 0.5.0 起收编有了自己的流程文件，05 不该再做第三选，也不该自己搬料。
  assert.match(text, /07-收编\.md/, '收编已上线，05 应指向 07 而不是继续声称没有收编')
  assert.match(text, /不搬料|不并行做/, '05 不该自己收编：问策略与试采是 07 的事')
  assert.ok(!/本版没有|0\.5\.0 才上线/.test(text), '0.5.0 已交付收编，05 里不该再留「本版没有收编」的旧话')
})

// —— 收编（F-08、F-29）：钉住三条机器能查、漂了没人发现的规则。
// 「先试采再全量」是这一版的核心承诺，退化成「一口气全采」时用户只会看到一堆废卡。
test('07 收编先问策略，默认试采而不是默认全量', () => {
  const text = workflow('07-收编.md')
  assert.match(text, /全收/, '缺「全收」这一支')
  assert.match(text, /按主题抽/, '缺「按主题抽」这一支')
  assert.match(text, /默认[^\n]{0,20}5/, '默认试采张数没写清，agent 只能自己定 N')
})

test('07 收编在试采确认之前不许写库', () => {
  const text = workflow('07-收编.md')
  // 第 3 步试采明确「先不写库」，第 5 步才写。若这两句丢了，条款就只剩口头承诺。
  assert.match(text, /先不写库|不写库/, '试采不许写库这条没写，试采会直接落盘')
  assert.match(text, /确认后才写库|用户确认后才写库/, '缺「确认后才写库」的闸门')
})

test('07 收编的中途可停与不重不漏写进了流程', () => {
  const text = workflow('07-收编.md')
  assert.match(text, /喊停|中途|停在这一批/, '没写中途能停，F-22 的断点就是空的')
  assert.match(text, /已采|进度/, '没写进度怎么报，用户看不到还剩多少')
})


test('没有一个子命令会调 process.exit：脚本作为模块被 import 时不杀宿主', () => {
  // process.exit 会在 import 时直接终止调用方进程，测试里无法捕获，只能静态查源码。
  const source = readFileSync(join(base, 'skills', 'material-vault', 'scripts', 'vault.mjs'), 'utf8')
  const calls = [...source.matchAll(/process\.exit\s*\(/g)]
  assert.equal(calls.length, 0, 'vault.mjs 又出现 process.exit，会杀掉宿主进程；请改为返回退出码')
})

// —— 查重（F-19）：先收窄再比对。这组钉的是「不收窄就拒绝」与四级收窄的行为边界。
const FIND_CARDS = [
  { rel: '写作方法/技巧/卡-20261024-关系造梗.md', 卡名: '关系造梗', 桶: '写作方法', 类型族: 'S-06 技巧', 子类: '人物塑造', 要点: '梗依托人际关系生成，笑点交互繁殖' },
  { rel: '写作方法/技巧/卡-20261024-三章钩子.md', 卡名: '三章一个钩子', 桶: '写作方法', 类型族: 'S-06 技巧', 子类: '节奏控制', 要点: '每三章必留一个未解之谜' },
  { rel: '现实避坑/现实/卡-20261024-尸表检验.md', 卡名: '尸表检验', 桶: '现实避坑', 类型族: 'S-09 现实', 子类: '职业细节', 要点: '明清验尸停留在尸表检验层面' },
]

function vaultWithCards() {
  const root = tmp()
  assert.equal(run(['init', '--vault', root]).code, 0)
  for (const c of FIND_CARDS) {
    const r = writeCardViaCli(root, {
      relPath: c.rel,
      basic: { 卡名: c.卡名, 桶: c.桶, 类型族: c.类型族, 子类: c.子类, 来源: '测试', 来源等级: '单源', 采集日期: '2026-10-24', 时效状态: '长期', 要点: c.要点 },
      dimension: {},
      body: { 内容: '测试' },
    })
    assert.equal(r.code, 0, '建测试卡失败：' + r.stdout + r.stderr)
  }
  return root
}

test('find 不给任何筛选项时拒绝并退出 2：不许整表翻', () => {
  const root = vaultWithCards()
  const r = run(['find', '--vault', root])
  assert.equal(r.code, 2, '不给筛选项应报参数错误')
  assert.match(r.stdout + r.stderr, /查重至少要给一个筛选项/)
})

test('find 按桶收窄只返回该桶的卡', () => {
  const root = vaultWithCards()
  const r = run(['find', '--vault', root, '--bucket', '写作方法'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /命中 2 张/)
  assert.ok(!r.stdout.includes('尸表检验'), '现实避坑的卡不该出现在写作方法的结果里')
})

test('find 逐级收窄：桶加子类只剩一张', () => {
  const root = vaultWithCards()
  const r = run(['find', '--vault', root, '--bucket', '写作方法', '--sub', '人物塑造'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /命中 1 张/)
  assert.match(r.stdout, /关系造梗/)
})

test('find 关键词比对卡名与要点两列', () => {
  const root = vaultWithCards()
  const byPoint = run(['find', '--vault', root, '--keyword', '未解之谜'])
  assert.equal(byPoint.code, 0)
  assert.match(byPoint.stdout, /三章一个钩子/, '关键词落在要点里也应命中')
  const byName = run(['find', '--vault', root, '--keyword', '尸表'])
  assert.match(byName.stdout, /尸表检验/, '关键词落在卡名里也应命中')
})

test('find 查无结果不是错误：退出 0 并说明可能筛太窄', () => {
  const root = vaultWithCards()
  const r = run(['find', '--vault', root, '--keyword', '库里一定没有的词'])
  assert.equal(r.code, 0, '查无是正常结论，不该报错')
  assert.match(r.stdout, /没有命中/)
  assert.match(r.stdout, /放宽/, '应提示可能筛得太窄，否则用户会以为库里真的没有')
})

test('find 桶名拼错时退出 2，不静默返回 0 结果', () => {
  const root = vaultWithCards()
  const r = run(['find', '--vault', root, '--bucket', '积木'])
  assert.equal(r.code, 2, '拼错桶名若返回 0 行，会被误读成库里没有')
  assert.match(r.stdout + r.stderr, /只认四个桶/)
})

test('find 的 --json 给出 count 与 rows', () => {
  const root = vaultWithCards()
  const r = run(['find', '--vault', root, '--bucket', '写作方法', '--json'])
  assert.equal(r.code, 0)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.data.count, 2)
  assert.equal(payload.data.rows.length, 2)
})

test('find 只读索引不写库：跑完库内容一字不变', () => {
  const root = vaultWithCards()
  const before = readFileSync(join(root, 'INDEX.md'), 'utf8')
  run(['find', '--vault', root, '--keyword', '梗'])
  assert.equal(readFileSync(join(root, 'INDEX.md'), 'utf8'), before, 'find 不该改索引')
})

// —— 分批断点续采（F-22）：进度记在库内，靠指纹认同一份活，靠去重保证不重。
// 这三件事任何一件退化，用户都会在第二次续采时发现自己白采了一遍或漏了一批。
function sourceDir(files) {
  const dir = tmp()
  mkdirSync(join(dir, 'sub'), { recursive: true })
  for (const f of files) {
    const full = join(dir, f)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, '# x', 'utf8')
  }
  return dir
}

function fingerprintOf(src) {
  const r = run(['collect', 'plan', '--source', src])
  assert.equal(r.code, 0, 'collect plan 失败：' + r.stdout + r.stderr)
  const m = /源指纹 ([0-9a-f]{12})/.exec(r.stdout)
  assert.ok(m, 'collect plan 没给出源指纹')
  return m[1]
}

test('collect plan 只数文本文件，并把不采的列出来而不是静默漏掉', () => {
  const src = sourceDir(['a.md', 'sub/b.txt', 'pic.png', 'weird.abc'])
  const r = run(['collect', 'plan', '--source', src])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /共 2 个可采/, '该只有 a.md 与 sub/b.txt')
  assert.match(r.stdout, /pic\.png/, '图片应被列出并说明不采，否则用户以为漏了')
  assert.match(r.stdout, /weird\.abc/, '认不出类型的也应列出')
})

test('collect plan 不碰库：没有库也能清点', () => {
  const src = sourceDir(['a.md'])
  const nowhere = tmp() // 空目录，没有 VAULT.md
  const r = run(['collect', 'plan', '--source', src], nowhere)
  assert.equal(r.code, 0, '清点来源目录不需要库，不该报「未找到库」：' + r.stdout + r.stderr)
})

test('collect mark 累加进度并报剩余，重复提交不重复计数', () => {
  const src = sourceDir(['a1.md', 'a2.md', 'a3.md', 'a4.md'])
  const root = tmp()
  assert.equal(run(['init', '--vault', root]).code, 0)
  const fp = fingerprintOf(src)

  let r = run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a1.md,a2.md'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /已记 2／4/)

  r = run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a3.md'])
  assert.match(r.stdout, /已记 3／4/, '续采应累加')

  // 同一批再记一次：这是用户点错或重跑时最可能发生的事，不该把剩余数算成负的。
  r = run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a1.md,a2.md'])
  assert.match(r.stdout, /已记 3／4/, '重复提交同一批不该重复计数')
})

test('collect mark 采完时报全部采完，进度文件落在库内', () => {
  const src = sourceDir(['a1.md', 'a2.md'])
  const root = tmp()
  run(['init', '--vault', root])
  const fp = fingerprintOf(src)
  const r = run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a1.md,a2.md'])
  assert.match(r.stdout, /已记 2／2/)
  assert.match(r.stdout, /全部采完/)
  // 进度落在库内而非库外：本技能所有写入都不得越出库根。
  const prog = join(root, '.收编进度', fp + '.json')
  assert.ok(existsSync(prog), '进度文件应在 <库根>/.收编进度/ 下')
  const data = JSON.parse(readFileSync(prog, 'utf8'))
  assert.deepEqual(data.done, ['a1.md', 'a2.md'], 'done 应排序后存')
})

test('collect mark 拒绝把不采的文件记进进度', () => {
  const src = sourceDir(['a.md', 'pic.png'])
  const root = tmp()
  run(['init', '--vault', root])
  const fp = fingerprintOf(src)
  const r = run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'pic.png'])
  assert.equal(r.code, 2, '图片不在待采清单里，记进去会让剩余数算错')
})

test('collect mark 缺指纹或空 done 时报参数错误', () => {
  const src = sourceDir(['a.md'])
  const root = tmp()
  run(['init', '--vault', root])
  const fp = fingerprintOf(src)
  assert.equal(run(['collect', 'mark', '--vault', root, '--source', src, '--done', 'a.md']).code, 2, '缺指纹应为 2')
  assert.equal(run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', '']).code, 2, '空 done 应为 2')
})

test('collect 动作名拼错时报参数错误，不静默成功', () => {
  const src = sourceDir(['a.md'])
  const r = run(['collect', 'bogus', '--source', src])
  assert.equal(r.code, 2)
  assert.match(r.stdout + r.stderr, /plan|mark/)
})

test('源指纹对同一目录稳定：尾斜杠不影响', () => {
  const src = sourceDir(['a.md', 'b.md'])
  assert.equal(fingerprintOf(src), fingerprintOf(src + '/'), '同一目录换个写法该认成同一份活')
})

test('源指纹区分不同的目录，且不因目录内文件增删而变', () => {
  const one = sourceDir(['a.md'])
  const two = sourceDir(['b.md'])
  assert.notEqual(fingerprintOf(one), fingerprintOf(two), '不同目录不该共用进度')

  // 关键：指纹只看目录路径，不看文件清单。否则采集途中删一个文件，
  // 旧进度立刻找不回来，整份素材要重采——而删文件是最常发生的事。
  const before = fingerprintOf(one)
  writeFileSync(join(one, 'new.md'), '# x', 'utf8')
  assert.equal(fingerprintOf(one), before, '目录里加了文件，指纹不该变，否则进度会丢')
  rmSync(join(one, 'a.md'), { force: true })
  assert.equal(fingerprintOf(one), before, '目录里删了文件，指纹不该变，否则进度会丢')
})

// —— collect status：续采前先看还剩多少。没有它，用户无法知道自己停在哪。
test('collect status 在没采过时退出 1 并说清还没采过', () => {
  const src = sourceDir(['a1.md', 'a2.md'])
  const root = tmp()
  run(['init', '--vault', root])
  const r = run(['collect', 'status', '--vault', root, '--source', src])
  assert.equal(r.code, 1, '没进度不是错误但也不该报成 0，否则与「有进度」分不开')
  assert.match(r.stdout, /还没采过/)
  assert.match(r.stdout, /2 个/, '应报总待采数')
})

test('collect status 报已记与剩余，并列出待采文件', () => {
  const src = sourceDir(['a1.md', 'a2.md', 'a3.md', 'a4.md'])
  const root = tmp()
  run(['init', '--vault', root])
  const fp = fingerprintOf(src)
  run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a1.md,a2.md'])
  const r = run(['collect', 'status', '--vault', root, '--source', src])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /已记 2／4/)
  assert.match(r.stdout, /剩 2 个/)
  assert.match(r.stdout, /a3\.md/)
  assert.ok(!/^- a1\.md/m.test(r.stdout), '已采过的不该出现在待采清单里')
})

test('collect status 报出进度里记着但来源目录已找不到的文件', () => {
  const src = sourceDir(['a1.md', 'a2.md'])
  const root = tmp()
  run(['init', '--vault', root])
  const fp = fingerprintOf(src)
  run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a1.md,a2.md'])
  rmSync(join(src, 'a2.md'), { force: true })
  const r = run(['collect', 'status', '--vault', root, '--source', src])
  assert.match(r.stdout, /找不到/, '文件没了要如实说，否则剩几个数对不上还没人知道')
})

test('collect status 采完后报全部采完', () => {
  const src = sourceDir(['a1.md'])
  const root = tmp()
  run(['init', '--vault', root])
  const fp = fingerprintOf(src)
  run(['collect', 'mark', '--vault', root, '--source', src, '--fingerprint', fp, '--done', 'a1.md'])
  const r = run(['collect', 'status', '--vault', root, '--source', src])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /全部采完/)
})

test('collect status 缺 --source 时报参数错误', () => {
  const root = tmp()
  run(['init', '--vault', root])
  assert.equal(run(['collect', 'status', '--vault', root]).code, 2)
})

// —— 多格式输入（F-18）：钉住「四种形态各有出路」与「做不到就说做不到」。
// 这条最容易退化成「假装读懂」——模型看到一张图就开始编内容，用户不会察觉。
test('01 采集有四形态分派：文字、图片、链接、语音各走各的', () => {
  const text = workflow('01-采集.md')
  for (const kind of ['文字', '图', '链接', '语音']) {
    assert.ok(text.includes(kind), `第 0 步没写「${kind}」这类形态`)
  }
  assert.match(text, /第 0 步/, '缺第 0 步的素材形态判定')
})

test('01 采集在宿主做不到时直说，不猜内容', () => {
  const text = workflow('01-采集.md')
  assert.match(text, /做不到/, '没写「做不到就直说」这句')
  assert.match(text, /不猜|不臆测|不虚构/, '没写「不猜内容」，模型会自己补')
  // 「拿标题摘要凑卡」是这条最容易走偏的地方：抓不到正文时用摘要交差。
  assert.match(text, /不.*凑一张卡|不用标题和摘要/, '没写不许拿标题摘要凑卡')
})

test('SKILL 的停止条件认多格式：读不了就说，不再笼统写「含未数字化的图片语音」', () => {
  const text = readFileSync(join(base, 'skills', 'material-vault', 'SKILL.md'), 'utf8')
  assert.match(text, /做不到/, '停止条件没写「做不到」，遇到读不了的形态会含糊过去')
  assert.ok(!/含未数字化的图片、语音时，停止并询问用户/.test(text), '0.5.0 起能读图与语音，旧口径该换掉')
})

// —— 示范库（F-11、F-24）。A-05 的验收是「十族有卡、无私有卡（含全部点子卡）、门禁绿」。
// 这些断言不是形式：示范库泄露一张私有卡，就是把作者的原创点子公开出去了。
const DEMO = join(base, 'skills', 'material-vault', 'demo-vault')

function demoCards() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && /^卡-.*\.md$/.test(e.name)) out.push(full)
    }
  }
  walk(DEMO)
  return out
}

function cardField(text, name) {
  const m = new RegExp('^- ' + name + '：(.*)', 'm').exec(text)
  return m ? m[1].trim() : ''
}

test('示范库十族各有一张卡，且不含开书点子族的任何卡', () => {
  const cards = demoCards()
  assert.equal(cards.length, 10, '示范库该是十张卡（十族各一），实际 ' + cards.length)
  const families = cards.map((f) => cardField(readFileSync(f, 'utf8'), '类型族'))
  const distinct = [...new Set(families)].sort()
  const expected = ['S-02', 'S-03', 'S-04', 'S-05', 'S-06', 'S-07', 'S-08', 'S-09', 'S-10', 'S-11']
  assert.deepEqual(distinct.map((f) => f.slice(0, 4)), expected, '十族应恰好是 S-02 至 S-11')
  // 点子族整族不进示范库：那是作者的原创资产，泄露等于送人。
  assert.ok(!families.some((f) => f.startsWith('S-01')), '示范库混进了开书点子，这是最严重的一类泄露')
})

test('示范库每张卡都非私有', () => {
  for (const f of demoCards()) {
    const text = readFileSync(f, 'utf8')
    assert.equal(cardField(text, '私有'), '否', f + ' 的「私有」不是「否」，私有卡不得进示范库')
  }
})

test('示范库自身通过 check', () => {
  const r = run(['check', '--vault', DEMO])
  assert.equal(r.code, 0, '示范库 check 未通过：' + r.stdout + r.stderr)
  assert.match(r.stdout, /库校验通过/)
})

test('示范库的卡是活卡：find 能查到，索引读得到', () => {
  const r = run(['find', '--vault', DEMO, '--bucket', '故事零件', '--json'])
  assert.equal(r.code, 0)
  const payload = JSON.parse(r.stdout)
  assert.ok(payload.data.count >= 5, '故事零件桶该至少有 5 张示范卡（S-02 至 S-06），实际 ' + payload.data.count)
})

test('示范库的卡不含占位符与反引号 .md 路径', () => {
  for (const f of demoCards()) {
    const text = readFileSync(f, 'utf8')
    assert.ok(!/TODO|\{\{/.test(text), f + ' 含占位符')
    const links = [...text.matchAll(/`([^`\s]+\.md)`/g)].map((m) => m[1])
    assert.deepEqual(links, [], f + ' 里有反引号包裹的 .md 路径，validate 会当链接校验：' + links.join('、'))
  }
})

test('示范库带一份说明，讲明这是别人的示范、别往里加东西', () => {
  const text = readFileSync(join(DEMO, 'README.md'), 'utf8')
  assert.match(text, /别人的/, '说明没讲清这是别人的素材')
  assert.match(text, /自己建/, '说明没讲清用户的库要自己建')
  assert.match(text, /会被覆盖/, '说明没拦住用户往示范库里加卡')
})

test('SKILL 与 05 都写了示范库的引导', () => {
  const skill = readFileSync(join(base, 'skills', 'material-vault', 'SKILL.md'), 'utf8')
  assert.match(skill, /demo-vault/, '入口没提示范库在哪')
  assert.match(skill, /别人的/, '入口没讲清示范库是别人的')
  assert.match(skill, /不要往示范库|不往 `demo-vault\/` 里写/, '入口没写「别往示范库写」')
  const loc = workflow('05-库定位.md')
  assert.match(loc, /demo-vault/, '05 没处理「用户把示范库当自己的库」这一情形')
})


test('示范库每张卡的维度行名与注册表该族要求逐行一致', () => {
  // 这条是最容易漏的：卡能写进去、check 也通过，但维度行名与注册表不符——
  // writeCard 只校验基本信息与格式，不校验类型维度行名与族对不对应。
  // 示范库是给新用户照抄的模板，行名错了会被抄一路。
  const reg = readFileSync(join(base, 'skills', 'material-vault', 'references', '类型注册表.md'), 'utf8')
  const fams = new Map()
  for (const line of reg.split('\n')) {
    const row = /^\| (S-\d{2}) \| ([^|]+) \|/.exec(line)
    const seg = /按维度抽取：([^；|]+)/.exec(line)
    if (!row || !seg) continue
    const dims = seg[1].replace(/（[^）]*）/g, '').split(/[、，]/).map((s) => s.trim()).filter(Boolean)
    fams.set(row[1], dims)
  }
  assert.ok(fams.size >= 10, '注册表解析出的族数偏少：' + fams.size)

  for (const f of demoCards()) {
    const text = readFileSync(f, 'utf8')
    const id = (/- 类型族：(S-\d{2})/.exec(text) || [])[1]
    assert.ok(id, f + ' 读不出类型族')
    const want = fams.get(id)
    assert.ok(want, id + ' 在注册表里没有维度要求')
    const sec = /## 类型维度\n([\s\S]*?)\n## /.exec(text)
    assert.ok(sec, f + ' 缺类型维度节')
    const got = [...sec[1].matchAll(/^- ([^：]+)：/gm)].map((m) => m[1].trim())
    assert.deepEqual(got, want, f + ' 的维度行名与注册表 ' + id + ' 不一致')
  }
})


// —— 退休建议（F-20）与已用标记（F-21）。
// 退休线的口径见 PRD 0.6.0 缺口 1：不用「检索命中」（系统不记），改用卡上
// 写在文件内容里的三个证据。这些用例钉住的就是「证据成立才列」。
function makeVault(cards) {
  const root = tmp()
  assert.equal(run(['init', '--vault', root]).code, 0)
  const jf = join(root, '.card.json')
  for (const c of cards) {
    writeFileSync(jf, JSON.stringify({
      relPath: c.rel,
      basic: { 卡名: c.卡名, 桶: '写作方法', 类型族: 'S-07 写作技巧', 子类: '叙事节奏',
        来源: '测试', 来源等级: '单源', 采集日期: c.采集日期, 时效状态: '长期', 要点: '测' },
      dimension: { 底层意图: 'x', 适用条件: 'x', 操作步骤: 'x', 反例: 'x' },
      body: { 内容: 'x', 已用在: c.已用在 ?? '', 补充记录: c.补充记录 ?? '' },
    }), 'utf8')
    const r = run(['write', '--vault', root, '--card', jf])
    assert.equal(r.code, 0, '建卡失败 ' + c.rel + '：' + r.stdout + r.stderr)
  }
  return root
}

const OLD = '2024-01-01'   // 足够老
const NEW = '2026-10-01'   // 刚采

test('retire 只列超期且既没用过也没补过的卡', () => {
  const root = makeVault([
    { rel: '写作方法/写作技巧/卡-20240101-没用过.md', 采集日期: OLD, 卡名: '没用过' },
    { rel: '写作方法/写作技巧/卡-20240101-用过.md', 采集日期: OLD, 卡名: '用过', 已用在: '《长夜》第 3 章' },
    { rel: '写作方法/写作技巧/卡-20240101-补过.md', 采集日期: OLD, 卡名: '补过', 补充记录: '2025-05-01 补了个反例' },
    { rel: '写作方法/写作技巧/卡-20261001-新.md', 采集日期: NEW, 卡名: '新卡' },
  ])
  const r = run(['retire', '--vault', root])
  assert.equal(r.code, 0, '空清单也该退 0，没有该退休的卡不是失败')
  assert.match(r.stdout, /没用过/)
  assert.ok(!r.stdout.includes('- 用过\n'), '用过的卡不该建议退休')
  assert.ok(!/^- 用过$/m.test(r.stdout), '用过的卡不该建议退休')
  assert.ok(!/^- 补过$/m.test(r.stdout), '补过料的卡不该建议退休')
  assert.ok(!/^- 新卡$/m.test(r.stdout), '没超期的不该列')
})

test('retire 把「无」「暂无」这类占位写法当成空的', () => {
  // 老卡上这类占位很常见。若当成「用过」，退休清单会永远空着。
  const root = makeVault([
    { rel: '写作方法/写作技巧/卡-20240101-占位.md', 采集日期: OLD, 卡名: '占位', 已用在: '无', 补充记录: '暂无' },
  ])
  const r = run(['retire', '--vault', root])
  assert.match(r.stdout, /占位/, '占位写法应算空，这张该被列出来')
})

test('retire 只建议不删：跑完卡还在', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20240101-甲.md', 采集日期: OLD, 卡名: '甲' }])
  run(['retire', '--vault', root])
  assert.ok(existsSync(join(root, '写作方法/写作技巧/卡-20240101-甲.md')), 'retire 不得删卡，谁退休由人拍板')
  assert.equal(run(['check', '--vault', root]).code, 0, 'retire 后库应仍然一致')
})

test('retire 的 --months 能调闲置线', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20240101-甲.md', 采集日期: OLD, 卡名: '甲' }])
  assert.match(run(['retire', '--vault', root]).stdout, /^建议退休 1 张/m)
  const loose = run(['retire', '--vault', root, '--months', '1'])
  assert.match(loose.stdout, /^建议退休 1 张/m, '1 个月线时这张当然还在')
  const strict = run(['retire', '--vault', root, '--months', '999'])
  assert.match(strict.stdout, /没有建议退休的卡/, '阈值拉高后就不该再列')
})

test('retire 的 --json 给出 count 与闲置月数', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20240101-甲.md', 采集日期: OLD, 卡名: '甲' }])
  const payload = JSON.parse(run(['retire', '--vault', root, '--json']).stdout)
  assert.equal(payload.data.count, 1)
  assert.equal(typeof payload.data.rows[0].闲置月数, 'number')
})

test('used 记到「《书名》第 N 章」并同步进卡', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20261001-甲.md', 采集日期: NEW, 卡名: '甲' }])
  const r = run(['used', '--vault', root, '--path', '写作方法/写作技巧/卡-20261001-甲.md', '--work', '长夜', '--chapter', '12'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /《长夜》第 12 章/)
  const text = readFileSync(join(root, '写作方法/写作技巧/卡-20261001-甲.md'), 'utf8')
  assert.match(text, /- 已用在：《长夜》第 12 章/)
})

test('used 追加多部作品而不覆盖前一次记录', () => {
  // F-21 的目的是「防同一个梗用两遍」；覆盖会正好抹掉证据，破掉这个目的。
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20261001-甲.md', 采集日期: NEW, 卡名: '甲' }])
  const rel = '写作方法/写作技巧/卡-20261001-甲.md'
  run(['used', '--vault', root, '--path', rel, '--work', '长夜', '--chapter', '12'])
  run(['used', '--vault', root, '--path', rel, '--work', '归墟', '--chapter', '楔子'])
  const text = readFileSync(join(root, rel), 'utf8')
  assert.match(text, /《长夜》第 12 章/)
  assert.match(text, /《归墟》第 楔子 章/)
})

test('used 重复记同一处不写第二遍', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20261001-甲.md', 采集日期: NEW, 卡名: '甲' }])
  const rel = '写作方法/写作技巧/卡-20261001-甲.md'
  assert.equal(run(['used', '--vault', root, '--path', rel, '--work', '长夜', '--chapter', '1']).code, 0)
  const r2 = run(['used', '--vault', root, '--path', rel, '--work', '长夜', '--chapter', '1'])
  assert.equal(r2.code, 0, '重复记不是错误')
  const text = readFileSync(join(root, rel), 'utf8')
  assert.equal((text.match(/《长夜》第 1 章/g) || []).length, 1, '同一处不该出现两次')
})

test('used 缺参数或路径越界时报参数错误', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20261001-甲.md', 采集日期: NEW, 卡名: '甲' }])
  const rel = '写作方法/写作技巧/卡-20261001-甲.md'
  assert.equal(run(['used', '--vault', root, '--path', rel, '--chapter', '1']).code, 2, '缺 work 应为 2')
  assert.equal(run(['used', '--vault', root, '--path', rel, '--work', '长夜']).code, 2, '缺 chapter 应为 2')
  assert.equal(run(['used', '--vault', root, '--work', '长夜', '--chapter', '1']).code, 2, '缺 path 应为 2')
  assert.equal(run(['used', '--vault', root, '--path', '../外面.md', '--work', 'x', '--chapter', '1']).code, 2, '越界应为 2')
})

test('标过已用的卡随即移出退休清单', () => {
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20240101-甲.md', 采集日期: OLD, 卡名: '甲' }])
  const rel = '写作方法/写作技巧/卡-20240101-甲.md'
  assert.match(run(['retire', '--vault', root]).stdout, /^建议退休 1 张/m, '标之前该在清单里')
  run(['used', '--vault', root, '--path', rel, '--work', '长夜', '--chapter', '5'])
  assert.match(run(['retire', '--vault', root]).stdout, /没有建议退休的卡/, '标之后该移出清单')
})

test('采集日期解析不出的卡不进退休清单', () => {
  // 格式不合规该由 check 报，不该混进退休清单里让人误删。
  const root = makeVault([{ rel: '写作方法/写作技巧/卡-20240101-坏日期.md', 采集日期: '去年', 卡名: '坏日期' }])
  const r = run(['retire', '--vault', root])
  assert.ok(!r.stdout.includes('坏日期'), '日期解析不出就不该猜到它超期了')
})


// —— 04 里的退休与已用（F-20、F-21）。钉的是流程层承诺：
// retire 只建议、人逐张点名才删；used 不填占位值。
test('04 卡管理写了 retire 只建议不删、删要逐张点名', () => {
  const text = workflow('04-卡管理.md')
  assert.match(text, /retire/, '04 没接上 retire')
  assert.match(text, /只列|只是建议/, '没写清 retire 只列建议')
  assert.match(text, /逐张确认/, '没写删卡要逐张确认，容易被写成一句循环批量删')
  assert.match(text, /不写一句循环|不写一句/, '没拦住批量删')
})

test('04 卡管理写了 used 记到书名与章节，且拒绝占位值', () => {
  const text = workflow('04-卡管理.md')
  assert.match(text, /used/, '04 没接上 used')
  assert.match(text, /《.*》第 .*章|书名/, '没写清记到书名与章节（Q-05 已决口径）')
  assert.match(text, /占位值/, '没拦住「某书」「未知章」这类占位写法')
  assert.match(text, /追加/, '没写多部作品追加而非覆盖')
})

test('退休线的口径写进了流程：不用「检索命中」，用卡上的证据', () => {
  const text = workflow('04-卡管理.md')
  // Q-04 原判据是「未检索命中」，但系统不记命中，2026-10-24 改为卡上证据。
  assert.ok(!/未被检索命中/.test(text), '流程里不该再写「未检索命中」，系统不记这件事')
  assert.match(text, /很久没动|没动过|用过没|补过料/, '没写清实际用的是什么判据')
})


after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

