// 项目自有测试：类型注册表是唯一事实源，本测试拦"注册表演进、下游漏改"的漂移。
// 解析依据：注册表「动作」列的固定段式（按维度抽取：…；子类：…；产卡入 …）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(base, p), 'utf8')

const registryText = read('skills/material-vault/references/类型注册表.md')
const tierText = read('skills/material-vault/references/权威源分级.md')
const judgeText = read('skills/material-vault/references/入库判据.md')
const skillText = read('skills/material-vault/SKILL.md')
const evalText = read('evals/cases/material-vault.md')
const readmeText = read('README.md')
const agentsText = read('AGENTS.md')

const BUCKETS = ['故事零件', '写作方法', '作品案例', '现实避坑']
const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五']

// —— 解析注册表族表：编号｜策略名（桶·族）｜动作（段式）｜不适用时
function parseRegistry() {
  const rows = []
  for (const m of registryText.matchAll(/^\| (S-\d{2}) \| ([^|]+) \| [^|]* \| ([^|]*) \| ([^|]*) \|/gm)) {
    const [, id, nameCell, actionCell, fallbackCell] = m
    const nm = nameCell.trim()
    const dot = nm.indexOf('·')
    const bucket = nm.slice(0, dot)
    const family = nm.slice(dot + 1)
    const segs = {}
    for (const seg of actionCell.split('；')) {
      const s = seg.trim()
      for (const key of ['按维度抽取：', '子类：', '产卡入']) {
        if (s.startsWith(key)) segs[key] = s.slice(key.length).trim()
      }
    }
    rows.push({ id, bucket, family, segs, fallback: fallbackCell })
  }
  return rows
}

const families = parseRegistry()
const familyIds = families.map((f) => f.id)

test('注册表族表可解析：每行三段齐、桶合法、编号从 01 连续', () => {
  assert.ok(families.length >= 10, `族表只解析到 ${families.length} 行，解析器或注册表格式坏了`)
  families.forEach((f) => {
    assert.ok(BUCKETS.includes(f.bucket), `${f.id} 桶名「${f.bucket}」不在四桶之内`)
    for (const key of ['按维度抽取：', '子类：', '产卡入']) {
      assert.ok(f.segs[key], `${f.id} 动作列缺「${key}」段`)
    }
    const expectPath = `素材库/${f.bucket}/${f.family}/`
    assert.equal(f.segs['产卡入'], expectPath, `${f.id} 产卡入路径与「桶/族」推导不一致`)
  })
  assert.deepEqual(familyIds, familyIds.map((_, i) => `S-${String(i + 1).padStart(2, '0')}`), 'S 编号须从 01 起连续')
})

test('注册表改道引用只指向存在的族', () => {
  for (const f of families) {
    for (const ref of f.fallback.matchAll(/S-\d{2}/g)) {
      assert.ok(familyIds.includes(ref[0]), `${f.id}「不适用时」引用了不存在的 ${ref[0]}`)
    }
  }
})

test('权威源分级编号接续注册表，无碰撞', () => {
  const tierIds = [...tierText.matchAll(/^\| (S-\d{2}) \|/gm)].map((m) => m[1])
  const tierNums = tierIds.map((id) => Number(id.slice(2)))
  tierNums.sort((a, b) => a - b)
  const maxFamily = familyIds.length
  tierNums.forEach((n, i) => assert.equal(n, maxFamily + i + 1, `权威源分级编号须从 S-${String(maxFamily + 1).padStart(2, '0')} 起连续接续`))
  const overlap = tierIds.filter((id) => familyIds.includes(id))
  assert.deepEqual(overlap, [], `编号碰撞：${overlap.join('、')}`)
})

test('判据 J-02 上界＝注册表最大编号', () => {
  const j02 = /^\| J-02 \|.*$/m.exec(judgeText)?.[0] ?? ''
  const bound = new RegExp(`S-01 至 S-(\\d{2})`).exec(j02)?.[1]
  assert.equal(bound, String(familyIds.length).padStart(2, '0'), 'J-02 的编号上界与注册表族数不一致')
})

test('采集员任务书声明的编号范围落在本桶族内', () => {
  for (const bucket of BUCKETS) {
    const path = `skills/material-vault/agents/${bucket}采集.md`
    assert.ok(existsSync(join(base, path)), `缺 ${path}（派工约定按桶名取件）`)
    const rangeLine = /^\| 类型族编号 \|.*$/m.exec(read(path))?.[0] ?? ''
    assert.ok(rangeLine, `${path} 缺「类型族编号」声明行`)
    const own = families.filter((f) => f.bucket === bucket).map((f) => f.id)
    for (const ref of rangeLine.matchAll(/S-\d{2}/g)) {
      assert.ok(own.includes(ref[0]), `${path} 编号范围声明含 ${ref[0]}，不属本桶（${bucket}：${own.join('、')}）；改道提示可跨桶，但范围声明不行`)
    }
  }
})

test('SKILL 入口第一问只写四桶，不复制子类清单', () => {
  const q1 = /1\. 第一问[^\n]*/.exec(skillText)?.[0] ?? ''
  for (const b of BUCKETS) assert.ok(q1.includes(b), `第一问缺桶名「${b}」`)
  for (const canary of ['开书点子', '反面教材', '金句语料']) {
    assert.ok(!q1.includes(canary), `第一问又复制了子类清单（含「${canary}」）——菜单归注册表与索引，此处删`)
  }
})

test('eval 用例的落卡路径＝注册表 S-02 的产卡路径', () => {
  const s02 = families.find((f) => f.id === 'S-02')
  const c02 = /^\| C-02 \|[^\n]*/m.exec(evalText)?.[0] ?? ''
  const pathInEval = /素材库\/[^／/]+\/[^／/]+\//.exec(c02)?.[0]
  assert.equal(pathInEval, s02.segs['产卡入'], '用例 C-02 路径与注册表产卡路径漂移')
})

test('README 与 AGENTS 的族数口径＝注册表族数', () => {
  const cn = CN_NUM[families.length]
  for (const [name, text] of [['README', readmeText], ['AGENTS', agentsText]]) {
    assert.ok(text.includes(`${cn}个类型族`), `${name} 未写「${cn}个类型族」——与注册表（${families.length} 族）漂移`)
  }
})

test('判据编号从 J-01 起连续，无跳号', () => {
  // 跳号意味着中间那条被删了，而引用它的流程文件不会报错，只会静默指向一个不存在的判据。
  const ids = [...judgeText.matchAll(/^\| (J-\d{2}) \|/gm)].map((m) => m[1])
  assert.ok(ids.length > 0, '判据表为空')
  ids.forEach((id, i) => assert.equal(id, 'J-' + String(i + 1).padStart(2, '0'), '判据编号须从 J-01 起连续，第 ' + (i + 1) + ' 条是 ' + id))
})

test('判据引用的 E-xx 都在依据区有定义', () => {
  // J-13 曾引用 E-06 而依据区只有到 E-04：文档照读不报错，查证时才卡住。
  const defined = new Set([...judgeText.matchAll(/^- (E-\d{2})：/gm)].map((m) => m[1]))
  const cited = new Set([...judgeText.matchAll(/\| (E-\d{2}) \|/gm)].map((m) => m[1]))
  for (const id of cited) assert.ok(defined.has(id), '判据引用了 ' + id + '，依据区没有定义')
})

test('摘录与对话类素材的公开尺度写进了判据与版式', () => {
  // Q-01 的决断：摘录上限 120 字、对话类不留可辨认原话。两处都要有，缺一处采集员就读不到。
  assert.match(judgeText, /J-14[^\n]*不超过 120 字/, '判据缺 J-14（摘录上限）')
  assert.match(judgeText, /J-15[^\n]*可辨认/, '判据缺 J-15（对话类不留原话）')
  const 版式 = read('skills/material-vault/assets/素材卡版式.md')
  assert.match(版式, /120 字/, '版式没标摘录上限，采集员按版式产卡时读不到')
  assert.match(版式, /J-1[45]/, '版式没指向 J-14／J-15')
})

test('判据 J-26：证实有两条路，转载不凑数', () => {
  // 这条挡两个错：(1) 循环印证——诺奖、重大事故的中文报道常是同一篇通稿的转载，
  // 逐项列全来源域看着像多源，其实是一个证据；(2) 反过来把「拿到原始发布方」
  // 也判成单源——诺奖官方接口是唯一原始发布方，它自己就够记证实。
  // 第二条是跑 02 基线时撞出来的：初版只写「两源须不同主体」，照字面读会让官方接口降级。
  const j26 = /^\| J-26 \|.*$/m.exec(judgeText)?.[0] ?? ''
  assert.ok(j26, '判据缺 J-26')
  assert.match(j26, /原始发布方/, 'J-26 没写「拿到原始发布方本身」这条路')
  assert.match(j26, /独立/, 'J-26 没写「互相独立的主体」这条路')
  assert.match(j26, /转载/, 'J-26 没写转载怎么算')
  assert.match(j26, /口述/, 'J-26 没写口述能不能凑成证实')
  assert.match(j26, /数据库|二次加工/, 'J-26 没把数据库二次加工排除在独立源之外')
})

test('判据 J-27：抓取成败看内容在不在手里，不看请求成不成功', () => {
  const j27 = /^\| J-27 \|.*$/m.exec(judgeText)?.[0] ?? ''
  assert.ok(j27, '判据缺 J-27（抓取成败判定）')
  assert.match(j27, /200/, 'J-27 没点名 HTTP 200 不能单独当依据')
  assert.match(j27, /逐字引/, 'J-27 没给出可操作的判断方法')
})

test('J-26、J-27 在依据区都有 E 号', () => {
  for (const id of ['E-17', 'E-18']) {
    assert.ok(new RegExp('^- ' + id + '：', 'm').test(judgeText), '依据区缺 ' + id)
  }
})

test('调研员任务书区分「完全无网」与「单通道坏掉」', () => {
  // 跑 02 基线时撞出来的：WebSearch 报 no API key，WebFetch 却全程能用。
  // 旧停止条件写「检索连续失败 3 次即停」，照字面读应当停，但真停下来就采不到料了。
  // 两者混成一条，会让调研员要么违规继续、要么明明能查却空手而归。
  const agent = read('skills/material-vault/agents/调研采集.md')
  assert.match(agent, /完全无联网/, '没写「完全无网」这个停止条件')
  assert.match(agent, /单一通道/, '没区分「单通道坏掉」')
  assert.match(agent, /不停止/, '没写明单通道坏掉时不停止')
  assert.match(agent, /不能装作检索过/, '允许继续，但要求如实说明没检索过')
})

test('调研员失败回退写了官方页面读不出正文时改走机器可读端点', () => {
  // 基线实况：nobelprize.org 的 HTML 页 HTTP 200 但正文被截断只剩标题，
  // 真正拿到事实的是官方 JSON 接口。这正是 J-27 的应用场景。
  const agent = read('skills/material-vault/agents/调研采集.md')
  assert.match(agent, /J-27/, '失败回退没引用 J-27')
  assert.match(agent, /数据接口|机器可读/, '没写改走官方数据接口这条路')
})
test('S-12 指向 J-26，不自己另定义一遍双源', () => {
  // 定义只住一处：口径归判据，策略表只引用。
  const s12 = /^\| S-12 \|.*$/m.exec(tierText)?.[0] ?? ''
  assert.ok(s12, '权威源分级缺 S-12')
  assert.match(s12, /J-26/, 'S-12 没指向 J-26')
})

test('调研员任务书写了「不同主体」与「循环印证」', () => {
  // 调研员是唯一联网的口，它读不到就等于规则不存在。
  const agent = read('skills/material-vault/agents/调研采集.md')
  assert.match(agent, /不同主体/, '调研员任务书没写「不同主体」')
  assert.match(agent, /同一个错误/, '调研员任务书没写循环印证这个反模式')
  assert.match(agent, /J-26/, '调研员任务书没引用 J-26')
})

test('01 采集写了抓不到正文的判定方法', () => {
  const wf = read('skills/material-vault/workflows/01-采集.md')
  assert.match(wf, /J-27/, '01 没引用 J-27')
  assert.match(wf, /逐字引/, '01 没给「能不能逐字引出来」这个判断方法')
  assert.match(wf, /200/, '01 没点名 HTTP 200 不能单独当依据')
})

test('S-12 写明了两条记「证实」的路，不只剩「双源」一条', () => {
  // 跑 02 基线时发现：只写「双源须不同主体」会让官方接口这条最硬的源降级。
  const s12 = /^\| S-12 \|.*$/m.exec(tierText)?.[0] ?? ''
  assert.ok(s12, '缺 S-12')
  assert.match(s12, /原始发布方/, 'S-12 没写「拿到原始发布方」这条路')
  assert.match(s12, /独立/, 'S-12 没写「两个互相独立的主体」这条路')
})
test('来源等级定义只住判据一处', () => {
  assert.ok(/来源等级取值口径/.test(judgeText), '判据缺来源等级口径行（唯一定义处）')
  assert.ok(!/＝关键事实双源一致/.test(tierText), '权威源分级又自己定义了一遍来源等级——改为指向 J-09')
})

test('判据 J-28：收集作品时卡上要写「出自作品」，且与对象标识分清', () => {
  // F-32 的地基。若 J-28 被悄悄删掉，「出自作品」就成了没人要求的字段，
  // 下次有人嫌它多余就会顺手删——那正是「按作品收集」失效的开始。
  const judge = read('skills/material-vault/references/入库判据.md')
  const j28 = /^\| J-28 \|.*$/m.exec(judge)?.[0] ?? ''
  assert.ok(j28, '判据缺 J-28')
  assert.match(j28, /出自作品/, 'J-28 没写要填「出自作品」')
  assert.match(j28, /对象标识/, 'J-28 没写清与「对象标识」的区别')
  assert.match(j28, /from-work/, 'J-28 没给核对方法')
})

test('按作品收集策略文件存在，七维清单齐全，且与注册表的族号对得上', () => {
  // 策略是查表，表里写的族号若与注册表漂移，用户点名的作品会收错族。
  const policy = read('skills/material-vault/references/按作品收集策略.md')
  const registry = read('skills/material-vault/references/类型注册表.md')

  for (const dim of ['人设', '世界设定', '剧情桥段', '金句', '意象氛围', '起名', '作品切片']) {
    assert.ok(policy.includes(dim), `策略缺「${dim}」这一维`)
  }
  // 策略里出现的每个 S-xx 都必须真实存在。注意 S- 号段跨两个文件：
  // S-01..S-11 在类型注册表（类型族），S-12..S-17 在权威源分级（取源策略）。
  // 只查注册表会把合法的 S-16（地域政策）误判成编造。
  const tier = read('skills/material-vault/references/权威源分级.md')
  const cited = [...policy.matchAll(/S-(\d\d)/g)].map((m) => m[1])
  assert.ok(cited.length >= 7, `策略只提到 ${cited.length} 个族，七维至少七个`)
  for (const n of new Set(cited)) {
    const re = new RegExp(`^\\| S-${n} \\|`, 'm')
    assert.ok(re.test(registry) || re.test(tier), `策略引用了不存在的 S-${n}`)
  }
})

test('策略写明「先结构后文字」与「默认先试采三张」', () => {
  // 这两条是用户 2026-10-25 明确要的默认行为，删掉就退回「问一堆问题」。
  const policy = read('skills/material-vault/references/按作品收集策略.md')
  assert.match(policy, /先结构后文字/, '策略缺「先结构后文字」的顺序')
  assert.match(policy, /试采三张/, '策略缺「默认先试采三张」')
})

test('策略的来源等级口径与 J-09 一致，并交代了别名怎么办', () => {
  // 试采时发现两处策略自身的错，各留一条防线：
  // 1) 初版写「二手 → 线索」，与 J-09「二次加工 → 单源」冲突，会把百科材料降得过低。
  // 2) 《幻界战线》与《血界战线》是同一部，而 --from-work 不认别名，不交代就会查不全。
  const policy = read('skills/material-vault/references/按作品收集策略.md')
  assert.match(policy, /单源/, '策略没写百科/wiki 记单源')
  assert.match(policy, /二次加工/, '策略没与 J-09 的「二次加工」口径对齐')
  assert.match(policy, /别名|译名/, '策略没交代一部作品多个译名时怎么办')
  assert.match(policy, /固定用一个名字|统一/, '策略没给出「固定用一个名字」的做法')
})

test('判据 J-29：榜单四元信息齐备，且把「数据事实」与「推断」分开', () => {
  // F-33 的地基。这条判据若被删，榜单卡会退化成「一堆没有出处的名次」。
  const judge = read('skills/material-vault/references/入库判据.md')
  const j29 = /^\| J-29 \|.*$/m.exec(judge)?.[0] ?? ''
  assert.ok(j29, '判据缺 J-29')
  for (const k of ['榜名', '时点', '排序口径', '过滤条件']) {
    assert.match(j29, new RegExp(k), `J-29 没写「${k}」`)
  }
  assert.match(j29, /推断/, 'J-29 没要求把推断标出来')
  assert.match(j29, /J-26/, 'J-29 没接上 J-26 的「原始发布方」口径')
})

test('榜单取数策略写了三层选源优先级与人数门槛', () => {
  const policy = read('skills/material-vault/references/榜单取数策略.md')
  assert.match(policy, /平台自带加权/, '缺「平台自带加权榜」这层')
  assert.match(policy, /分类排行榜/, '缺「分类排行榜」这层')
  assert.match(policy, /标签页按评分排序/, '缺「标签页按评分排序」这层')
  assert.match(policy, /1000/, '缺默认人数门槛')
  // 三层必须是有序的，不是并列罗列。
  // 只在「选源优先级」这一节内比较顺序：文档开头「榜名」那行举例里也含「分类排行榜」，
  // 用全局 indexOf 会被那处举例提前命中，误判成顺序颠倒。
  const sec = policy.slice(policy.indexOf('## 选源优先级'))
  const a = sec.indexOf('平台自带加权')
  const b = sec.indexOf('分类排行榜')
  const c = sec.indexOf('标签页按评分排序')
  assert.ok(a >= 0 && b >= 0 && c >= 0, '「选源优先级」一节里三层不齐')
  assert.ok(a < b && b < c, '三层选源没有按优先级排序')
})

test('榜单策略记了通道能力边界：能用的与不能用的分开', () => {
  // 这张表是实测出来的，删了就得重新趟一遍死路。
  const policy = read('skills/material-vault/references/榜单取数策略.md')
  assert.match(policy, /能用的/, '缺「能用的」通道表')
  assert.match(policy, /不能用的/, '缺「不能用的」通道表')
  assert.match(policy, /起点|晋江|番茄/, '没记「平台榜需登录」这条')
  assert.match(policy, /top250/i, '没记豆瓣 Top250 这条可用通道')
})

test('榜单策略说清了去重的三种形态与一个例外', () => {
  const policy = read('skills/material-vault/references/榜单取数策略.md')
  assert.match(policy, /多版本/, '缺「同作品多版本」')
  assert.match(policy, /多卷/, '缺「同作品多卷」')
  assert.match(policy, /前篇/, '缺「前篇/后篇不合并」这个例外')
})

test('03 检索区分「筛得太窄」与「库里确实没有」，不一律建议采集', () => {
  // find 在无命中时自己会说「库里可能确实没有，也可能筛得太窄」（vault.mjs）。
  // 而 03 的停止条件原先只写「建议先采集」——库里有卡、只是筛窄了的时候，
  // 照那句读会把用户赶去白建卡。两支必须分开写。
  const wf = read('skills/material-vault/workflows/03-检索.md')
  const stop = wf.slice(wf.indexOf('## 停止条件'))
  assert.match(stop, /太窄|放宽/, '停止条件没提「筛得太窄」这一支')
  assert.match(stop, /确实没有|确实没/, '停止条件没提「库里确实没有」这一支')
  // 两支要给出不同的去处：放宽筛选 vs 去采集。只写「建议先采集」不够。
  assert.match(stop, /放宽/, '没给出「放宽筛选」这个动作')
  assert.match(stop, /采集/, '没给出「去采集」这个动作')
})