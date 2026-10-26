// 卡格式契约测试：字段表、枚举、私有默认值，以及「版式是契约的投影」这条一致性。
// 防的漂移：contract 加了字段而 素材卡版式.md 没跟，或版式自由发挥了契约里没有的字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BUCKETS, FIELD_NAMES, FIELDS, INDEX_COLUMNS, PRIVATE_VALUES,
  REQUIRED_FIELDS, SOURCE_LEVELS, TIME_STATES, checkBasic, defaultPrivate, indexRow,
  objectKey, objectKeyOf,
} from '../skills/material-vault/scripts/cardFormat.mjs'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = join(base, 'skills', 'material-vault')
const 版式 = readFileSync(join(skillDir, 'assets', '素材卡版式.md'), 'utf8')

// 版式「### 基本信息」节下的 - 字段：行
function templateFields(section) {
  const start = 版式.indexOf(`### ${section}`)
  assert.ok(start >= 0, `版式缺「### ${section}」节，测试的取法已失效`)
  const rest = 版式.slice(start).split(/\n### /)[0]
  return [...rest.matchAll(/^- ([^：]+)：/gm)].map((m) => m[1].trim())
}

test('字段表与版式的基本信息节逐项一致，顺序也一致', () => {
  assert.deepEqual(templateFields('基本信息'), FIELD_NAMES, '契约与版式的字段不一致：改一处须同次改另一处')
})

test('必填字段是字段表的子集，且每个字段都显式声明了必填与否', () => {
  for (const f of FIELDS) assert.equal(typeof f.必填, 'boolean', `${f.名} 未声明必填`)
  assert.deepEqual(REQUIRED_FIELDS, FIELDS.filter((f) => f.必填).map((f) => f.名))
  assert.ok(REQUIRED_FIELDS.every((n) => FIELD_NAMES.includes(n)));
})

test('可选字段只有三个：出处链接、对象标识与出自作品', () => {
  // 出处链接可选：用户口述的素材没有链接，判据只要求「尽力补」。
  // 对象标识可选：0.8.0 才引入，逼老库为补一个可选字段先跑 upgrade 不划算；
  // 缺这行时由卡名推（见 objectKeyOf）。
  // 出自作品可选：0.9.0 才引入，同理；留空即「不特别属于某部作品」，
  // 原创点子与现实见闻本来就没有出处作品，不能逼它们填。
  const optional = FIELD_NAMES.filter((n) => !REQUIRED_FIELDS.includes(n))
  assert.deepEqual(optional, ['出处链接', '对象标识', '出自作品'])
})

test('objectKey 把同一对象的写法归一，但不误并相近词', () => {
  // 这组断言是 F-30 的地基：判重靠它，「五条悟」与「五条 悟」必须算同一个对象，
  // 否则补卡规则形同虚设；而「长相思」与「长相守」必须算两个，否则会把该分开的卡并掉。
  const same = [
    ['五条悟', '五条 悟'],
    ['五条悟', '五条悟（咒术回战）'],
    ['五条悟', '  五条悟  '],
    ['长夜', '《长夜》'],
    ['Gojo Satoru', 'gojo satoru'],
    ['ＧＯＪＯ', 'gojo'],
  ]
  for (const [a, b] of same) assert.equal(objectKey(a), objectKey(b), `「${a}」与「${b}」应算同一对象`)
  const diff = [
    ['长相思', '长相守'],
    ['五条悟', '五条'],
    ['长夜', '长夜行'],
  ]
  for (const [a, b] of diff) assert.notEqual(objectKey(a), objectKey(b), `「${a}」与「${b}」不能算同一对象`)
})

test('objectKeyOf 优先用对象标识，缺省时由卡名推', () => {
  assert.equal(objectKeyOf({ 卡名: '随便什么', 对象标识: '五条悟' }), objectKey('五条悟'))
  assert.equal(objectKeyOf({ 卡名: '《长夜》里的主角' }), objectKey('《长夜》里的主角'), '缺字段时用卡名')
  assert.equal(objectKeyOf({}), '')
  assert.equal(objectKeyOf(null), '')
})

test('私有默认值：S-01 为是，其余为否', () => {
  assert.equal(defaultPrivate('S-01 开书点子'), '是')
  assert.equal(defaultPrivate('S-01'), '是')
  assert.equal(defaultPrivate('S-02 人物设定'), '否')
  assert.equal(defaultPrivate('S-010'), '否', 'S-010 不是 S-01，前缀判断不得误伤')
  assert.equal(defaultPrivate(undefined), '否')
})

test('三个枚举的取值与判据、注册表的口径一致', () => {
  assert.deepEqual(BUCKETS, ['故事零件', '写作方法', '作品案例', '现实避坑'])
  assert.deepEqual(TIME_STATES, ['现行', '已过时', '待观察', '长期'])
  assert.deepEqual(SOURCE_LEVELS, ['证实', '单源', '线索', '存疑'])
  assert.deepEqual(PRIVATE_VALUES, ['是', '否'])
})

test('索引列＝卡字段的子集，只有相对路径是索引独有', () => {
  const notInFields = INDEX_COLUMNS.filter((c) => !FIELD_NAMES.includes(c) && c !== '时效')
  assert.deepEqual(notInFields, ['相对路径'], '索引出现契约里没有的列')
})

test('indexRow 把卡的字段映射成索引行，时效取自时效状态', () => {
  const row = indexRow({ basic: { 卡名: '甲', 大类: '故事零件', 类型: 'S-02', 细分: '原型基底', 要点: '乙', 时效状态: '长期' } }, '故事零件/人物设定/卡-1-甲.md')
  assert.deepEqual(row, {
    卡名: '甲', 大类: '故事零件', 类型: 'S-02', 细分: '原型基底',
    要点: '乙', 时效: '长期', 相对路径: '故事零件/人物设定/卡-1-甲.md',
  })
})

test('checkBasic 抓得出缺必填、要点超限、非法枚举', () => {
  const good = { 卡名: '甲', 大类: '故事零件', 类型: 'S-02', 细分: '原型基底', 来源: '口述', 来源等级: '单源', 采集日期: '2026-10-23', 时效状态: '长期', 私有: '否', 要点: '乙' }
  assert.deepEqual(checkBasic(good), [], '合法卡不应报错（出处链接与私有可缺）')

  const issues = checkBasic({ ...good, 要点: '这'.repeat(41), 时效状态: '新鲜', 来源等级: '可靠', 私有: '大概' })
  assert.ok(issues.some((i) => i.includes('超 40')), '未抓要点超限')
  assert.ok(issues.some((i) => i.includes('时效状态')), '未抓非法时效')
  assert.ok(issues.some((i) => i.includes('来源等级')), '未抓非法来源等级')
  assert.ok(issues.some((i) => i.includes('私有')), '未抓非法私有取值（J-13）')
})

test('要点限长按字符计，非按 UTF-16 码元', () => {
  const good = { 卡名: '甲', 大类: '故事零件', 类型: 'S-02', 细分: 'x', 来源: 'y', 来源等级: '单源', 采集日期: '2026-10-23', 时效状态: '长期', 私有: '否' }
  assert.deepEqual(checkBasic({ ...good, 要点: '𝄞'.repeat(40) }), [], '40 个星形字符应恰好通过')
  assert.ok(checkBasic({ ...good, 要点: '𝄞'.repeat(41) }).some((i) => i.includes('超 40')))
})

test('技能入口的输出表提到索引列，与契约不矛盾', () => {
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  const line = /素材索引[^\n]*/.exec(skill)?.[0] ?? ''
  for (const col of INDEX_COLUMNS) assert.ok(line.includes(col), `SKILL.md 的素材索引行缺列「${col}」`)
  // 原来是防「把类型族写成类型」的短名。改名后「类型」成了正名，那个守卫失去意义；\n  // 换成现在有用的：索引行不许再出现旧字段名，专治半途而废的改名。\n  assert.ok(!/桶|类型族|子类/.test(line), 'SKILL.md 的素材索引行还在用旧字段名（桶／类型族／子类）')
})
