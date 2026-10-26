// 卡格式契约（cardFormat）：「什么算合法的一张卡」的唯一事实源。
// 基本信息字段、索引列、三个枚举的取值都只写在这里；assets/素材卡版式.md 是它的投影，
// 二者由 test/cardFormat.test.mjs 钉住。加减字段只改本文件，同次改版式与那条测试。
// 正文节与类型维度节不在此约束：字段随类型与素材变化，透传即可。
export const FIELDS = [
  { 名: '卡名', 必填: true },
  { 名: '大类', 必填: true },
  { 名: '类型', 必填: true },
  { 名: '细分', 必填: true },
  { 名: '来源', 必填: true },
  // 用户口述的素材没有出处链接，判据只要求采集员「尽力补」，故此字段可选。
  { 名: '出处链接', 必填: false },
  { 名: '来源等级', 必填: true },
  { 名: '采集日期', 必填: true },
  { 名: '时效状态', 必填: true },
  // 0.4.0 批一引入，批三随升级器转必填：老库跑过 upgrade 之后才不会有缺这行的卡。
  { 名: '私有', 必填: true },
  // 0.8.0 引入，可选：一张卡针对的是哪个对象（某个角色、某部作品、某个桥段）。
  // 有了它才能机器判定「这两张卡是不是同一个对象」，而 F-30 的补卡规则全靠这个判断。
  // 可选是为了不逼已有库升级：缺这行时由卡名推（见 objectKey）。
  { 名: '对象标识', 必填: false },
  // 0.9.0 引入，可选：这条素材出自哪部作品（F-32）。
  //
  // 与「对象标识」不是一回事，别混：对象标识认的是「这张卡讲谁」——一张人设卡讲
  // 某个角色，对象标识写那个角色；而同一个角色往往出现在多部作品里。出自作品认的是
  // 「这条料从哪来」——「幻界战线」的三十张卡分属人设、桥段、设定等好几个类型，
  // 对象标识各不相同，但都出自同一部作品。收一部作品的全部维度时，只有这个字段能把
  // 它们串起来，回答「幻界战线我收过什么」。
  //
  // 可选，不逼已有库升级：留空即「不特别属于某部作品」（原创点子、现实见闻都如此）。
  { 名: '出自作品', 必填: false },
  { 名: '要点', 必填: true, 限长: 40 },
]

// 由 FIELDS 推导，不另记一份：多一份清单就多一处可漂移。
export const REQUIRED_FIELDS = FIELDS.filter((f) => f.必填).map((f) => f.名)
export const FIELD_NAMES = FIELDS.map((f) => f.名)

// 索引一行一卡。列名与卡的字段名不完全相同，映射见 indexRow。
export const INDEX_COLUMNS = ['卡名', '大类', '类型', '细分', '要点', '时效', '相对路径']

export const BUCKETS = ['故事零件', '写作方法', '作品案例', '现实避坑']
export const TIME_STATES = ['现行', '已过时', '待观察', '长期']
export const SOURCE_LEVELS = ['证实', '单源', '线索', '存疑']
export const PRIVATE_VALUES = ['是', '否']

// 私有默认值：故事零件·开书点子（S-01）默认「是」，其余类型默认「否」。
// 按类型编号前缀判，不建「类型 → 默认值」表：多一行表就多一处可漂移。
export function defaultPrivate(类型) {
  return /^S-01(?!\d)/.test(String(类型 ?? '').trim()) ? '是' : '否'
}

// 对象标识的归一化。F-30 要机器判断「这两张卡是不是同一个对象」，
// 但人写同一个名字会有很多写法：「五条悟」「五条 悟」「五条悟（咒术回战）」
// 「《长夜》」「长夜」。不归一化就只能逐字比对，那些写法全会被当成不同对象，
// 于是补卡规则形同虚设——而它正是最容易失守的地方。
//
// 归一化只做四件保守的事，不做模糊匹配：
//   1. 去首尾空白，内部空白也去掉（「五条 悟」→「五条悟」）
//   2. 全角转半角（数字、字母、括号、空格）
//   3. 剥掉括号注释（「五条悟（咒术回战）」→「五条悟」）
//   4. 剥掉书名号（「《长夜》」→「长夜」）
// 最后统一小写（英文角色名大小写不该算两个对象）。
//
// 刻意不做拼音/编辑距离的模糊匹配：那会把「长相思」与「长相守」判成同一个对象，
// 而误判的代价是两张该分开的卡被并成一张，比漏判更难挽回。
export function objectKey(value) {
  let s = String(value ?? '')
  // 全角 → 半角：全角空格、全角括号、全角字母数字、全角书名号都有对应写法。
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  s = s.replace(/\u3000/g, ' ')
  // 剥括号注释：半角与全角括号都剥（全角已在上一步转成半角）。
  s = s.replace(/[（(][^）)]*[）)]/g, '')
  // 剥书名号：《》与〈〉
  s = s.replace(/[《》〈〉]/g, '')
  // 去掉所有空白
  s = s.replace(/\s+/g, '')
  return s.toLowerCase()
}

// 一张卡的「对象键」：优先用卡上写的「对象标识」，没写则由卡名推。
// 由卡名推是刻意的：老库没有这个字段，逼用户先跑 upgrade 只为补一个可选字段，
// 代价大于收益；而卡名通常已经带着对象名。
export function objectKeyOf(basic) {
  const explicit = String(basic?.对象标识 ?? '').trim()
  if (explicit) return objectKey(explicit)
  return objectKey(basic?.卡名)
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
  if (b.大类 && !BUCKETS.includes(b.大类)) issues.push(`大类「${b.大类}」不合法`)
  return issues
}
