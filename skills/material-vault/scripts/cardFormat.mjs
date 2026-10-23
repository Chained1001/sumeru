// 卡格式契约（cardFormat）：「什么算合法的一张卡」的唯一事实源。
// 基本信息字段、索引列、三个枚举的取值都只写在这里；assets/素材卡版式.md 是它的投影，
// 二者由 test/cardFormat.test.mjs 钉住。加减字段只改本文件，同次改版式与那条测试。
// 正文节与类型维度节不在此约束：字段随类型族与素材变化，透传即可。
export const FIELDS = [
  { 名: '卡名', 必填: true },
  { 名: '桶', 必填: true },
  { 名: '类型族', 必填: true },
  { 名: '子类', 必填: true },
  { 名: '来源', 必填: true },
  // 用户口述的素材没有出处链接，判据只要求采集员「尽力补」，故此字段可选。
  { 名: '出处链接', 必填: false },
  { 名: '来源等级', 必填: true },
  { 名: '采集日期', 必填: true },
  { 名: '时效状态', 必填: true },
  // 0.4.0 批一引入，批三随升级器转必填（PRD 的 D-10）。转必填＝把 false 改成 true。
  { 名: '私有', 必填: false },
  { 名: '要点', 必填: true, 限长: 40 },
]

// 由 FIELDS 推导，不另记一份：多一份清单就多一处可漂移。
export const REQUIRED_FIELDS = FIELDS.filter((f) => f.必填).map((f) => f.名)
export const FIELD_NAMES = FIELDS.map((f) => f.名)

// 索引一行一卡。列名与卡的字段名不完全相同，映射见 indexRow。
export const INDEX_COLUMNS = ['卡名', '桶', '类型族', '子类', '要点', '时效', '相对路径']

export const BUCKETS = ['故事零件', '写作方法', '作品案例', '现实避坑']
export const TIME_STATES = ['现行', '已过时', '待观察', '长期']
export const SOURCE_LEVELS = ['证实', '单源', '线索', '存疑']
export const PRIVATE_VALUES = ['是', '否']

// 私有默认值：故事零件·开书点子（S-01）默认「是」，其余族默认「否」。
// 按类型族编号前缀判，不建「族 → 默认值」表：多一行表就多一处可漂移。
export function defaultPrivate(类型族) {
  return /^S-01(?!\d)/.test(String(类型族 ?? '').trim()) ? '是' : '否'
}

// 卡 → 索引行。相对路径由调用方给（路径由写入方决定，契约不猜文件名）。
export function indexRow(card, relPath) {
  const basic = card?.basic ?? {}
  const row = {}
  for (const col of INDEX_COLUMNS) {
    if (col === '相对路径') row[col] = relPath ?? ''
    else if (col === '时效') row[col] = basic.时效状态 ?? ''
    else row[col] = basic[col] ?? ''
  }
  return row
}

// 机器可判的判据：缺必填字段、要点超限、三个枚举取值非法（含私有）。
// 语义判据（切分、相关性、原文与推断分层）不在此处，靠人核。
export function checkBasic(basic) {
  const issues = []
  const b = basic ?? {}
  for (const f of FIELDS) {
    if (f.必填 && !b[f.名]) issues.push(`缺必填字段「${f.名}」`)
  }
  for (const f of FIELDS) {
    if (!f.限长 || !b[f.名]) continue
    const n = [...b[f.名]].length
    if (n > f.限长) issues.push(`${f.名} ${n} 字，超 ${f.限长}（J-03）`)
  }
  if (b.时效状态 && !TIME_STATES.includes(b.时效状态)) issues.push(`时效状态「${b.时效状态}」不合法（J-06）`)
  if (b.来源等级 && !SOURCE_LEVELS.includes(b.来源等级)) issues.push(`来源等级「${b.来源等级}」不合法（J-09）`)
  if (b.私有 && !PRIVATE_VALUES.includes(b.私有)) issues.push(`私有「${b.私有}」不合法（J-13）`)
  if (b.桶 && !BUCKETS.includes(b.桶)) issues.push(`桶「${b.桶}」不合法`)
  return issues
}
