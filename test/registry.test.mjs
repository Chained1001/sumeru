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

test('来源等级定义只住判据一处', () => {
  assert.ok(/来源等级取值口径/.test(judgeText), '判据缺来源等级口径行（唯一定义处）')
  assert.ok(!/＝关键事实双源一致/.test(tierText), '权威源分级又自己定义了一遍来源等级——改为指向 J-09')
})
