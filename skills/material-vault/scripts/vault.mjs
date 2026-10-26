#!/usr/bin/env node
// 库接口（vault）：素材库的四件事——找库、建库、写一张卡、查一个库。
// 字段与取值的事实源是 cardFormat.mjs，本文件只管「怎么读写库」与「校验怎么汇总」。
// 调用方不再需要知道「读卡 → 拼索引行 → 追加索引 → 再校验」这个顺序：writeCard 一次做完。
// 用法：node scripts/vault.mjs <子命令> [选项]，子命令与选项见 --help。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, sep, basename, isAbsolute, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { checkBasic, indexRow, INDEX_COLUMNS, FIELDS, FIELD_NAMES, REQUIRED_FIELDS, BUCKETS, defaultPrivate, objectKey, objectKeyOf } from './cardFormat.mjs'

export { FIELDS, INDEX_COLUMNS, defaultPrivate, checkBasic }
// 格式版本：1 是老库（卡上无「私有」行），2 起「私有」必填。升级见 upgradeVault。
export const SCHEMA_VERSION = 3

// 卡字段改名映射：旧名 → 新名。只在 upgrade 里用一次，认完即删。
// 老库不认这一步的话，旧名会被当成退役字段挪进「历史字段」，值还在但不是真字段。
export const RENAMED_FIELDS = { 桶: '大类', 类型族: '类型', 子类: '细分' }
// 删卡的回收区（F-14）：卡按原相对路径移进来，restore 时原样移回。里面的东西不算活卡。
export const TRASH_DIR = '已删卡片'

// —— 身份证（VAULT.md）：格式版本＋一句话简介
function readVaultMeta(root) {
  const file = join(root, 'VAULT.md')
  if (!existsSync(file)) return { exists: false }
  const text = readFileSync(file, 'utf8')
  const version = /版本：(\d+)/.exec(text)?.[1]
  const intro = /简介：(.+)/.exec(text)?.[1]?.trim()
  return { exists: true, version: version == null ? null : Number(version), intro: intro ?? null }
}

// —— 索引（INDEX.md）：一行一卡
function readIndex(root) {
  const file = join(root, 'INDEX.md')
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells[0] !== '' || cells[cells.length - 1] !== '' || cells.length < INDEX_COLUMNS.length + 2) continue
    if (cells[1] === '卡名') continue // 表头行
    if (cells.every((c) => /^-{0,3}$/.test(c) || c === '')) continue // 分隔行
    const row = {}
    INDEX_COLUMNS.forEach((col, i) => { row[col] = cells[i + 1] ?? '' })
    rows.push(row)
  }
  return rows
}

// 表头与数据行之间不能有空行：GFM 遇到空行就结束表格，数据行会退化成普通文本。
function renderIndex(rows) {
  const head = `# 素材索引\n\n| ${INDEX_COLUMNS.join(' | ')} |\n|${INDEX_COLUMNS.map(() => '---').join('|')}|\n`
  const body = rows.map((r) => `| ${INDEX_COLUMNS.map((c) => r[c] ?? '').join(' | ')} |`).join('\n')
  return `${head}${body}${rows.length ? '\n' : ''}`
}

// 索引按相对路径 upsert：同一张卡重复写入不会产生两行。
// 统一走 writeIndex，与 rebuild 共用同一套排序，两条路径产出的索引逐字相同。
function upsertIndex(root, row) {
  const rows = readIndex(root).filter((r) => r.相对路径 !== row.相对路径)
  rows.push(row)
  writeIndex(root, rows)
}

// 索引是派生视图，行序不该取决于「谁先写的」：一律按相对路径排。
// 这样 write 出来的索引与 rebuild 出来的逐字相同，check 才不会因顺序不同误报。
function writeIndex(root, rows) {
  const sorted = [...rows].sort((a, b) => (a.相对路径 < b.相对路径 ? -1 : a.相对路径 > b.相对路径 ? 1 : 0))
  writeAtomic(join(root, 'INDEX.md'), renderIndex(sorted))
}

// 卡：三节（基本信息 / 类型维度 / 正文）。缺行读出空串，不因格式旧而抛错。
function parseListField(text, section) {
  const fields = {}
  const sec = splitSection(text, section)
  if (sec == null) return fields
  for (const m of sec.matchAll(/^- ([^：]+)：(.*)$/gm)) fields[m[1].trim()] = m[2].trim()
  return fields
}

function splitSection(text, title) {
  const re = new RegExp(`^## ${title}\\s*$`, 'm')
  const start = re.exec(text)?.index
  if (start == null) return null
  return text.slice(start).split(/\n(?=## )/)[0]
}

function readCard(file) {
  const text = readFileSync(file, 'utf8')
  const name = /\/([^/\\]+)$/.exec(file)?.[1] ?? file
  return {
    file: name,
    basic: parseListField(text, '基本信息'),
    dimension: parseListField(text, '类型维度'),
    body: parseListField(text, '正文'),
  }
}

// 卡 → Markdown。节内按契约的字段顺序输出，卡上多出来的字段（如历史字段）跟在末尾不丢。
function renderCard(card) {
  const basic = card.basic ?? {}
  const known = new Set(FIELDS.map((f) => f.名))
  const extra = Object.keys(basic).filter((k) => !known.has(k))
  const section = (title, fields, order) => {
    const lines = order.map((k) => `- ${k}：${fields[k] ?? ''}`)
    for (const k of Object.keys(fields)) if (!order.includes(k)) lines.push(`- ${k}：${fields[k] ?? ''}`)
    return `## ${title}\n\n${lines.join('\n')}\n`
  }
  const dims = Object.entries(card.dimension ?? {}).map(([k, v]) => `- ${k}：${v}`)
  return [
    `# ${basic.卡名 ?? '素材卡'}\n`,
    section('基本信息', basic, [...FIELDS.map((f) => f.名), ...extra]),
    `## 类型维度\n\n${dims.join('\n')}\n`,
    section('正文', card.body ?? {}, ['内容', '原文摘录或事实要点', '借鉴意图', '已用在', '关联卡', '补充记录']),
  ].join('\n')
}

// 写盘先落临时文件再改名：中断留不下半截卡。
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

// —— 接口一：写一张卡。合并 → 补默认值 → 校验 → 落卡 → 修索引，一次做完。
// 校验不通过时不写任何文件，把问题交回调用方。
// 已存在的卡按「盘上的值打底、本次传入的覆盖」合并：升级器写进「历史字段」的老值、
// 以及调用方这次没提及的字段，都不会因为重写而蒸发。
// 卡的相对路径必须是「两层目录 + 一个文件名」：`<大类>/<类型>/卡-<YYYYMMDD>-<短名>.md`。
//
// 为什么卡死在两层：库里同时存在两条遍历——`find` 走 INDEX、`overview` 走 `listCards`，
// 而 `listCards` 只下钻两层（`if (depth > 2) return`）。路径再深一层，两条路就看见
// 不同的库：同一个库、同一时刻，`find` 报「命中 1 张」而 `overview` 报「库是空的」。
// 这种自相矛盾比卡丢了更难查——卡丢了人会去找，数字打架人只会以为记错了。
export function cardPathProblem(rel) {
  const parts = String(rel ?? '').split(/[\\/]+/).filter(Boolean)
  if (parts.length !== 3) {
    return `卡的相对路径必须是「<大类>/<类型>/卡-<日期>-<短名>.md」——两层目录加一个文件名；给的是 ${parts.length} 段：${rel}`
  }
  if (!BUCKETS.includes(parts[0])) {
    return `路径第一层必须是四个大类之一（${BUCKETS.join('、')}），给的是「${parts[0]}」`
  }
  return ''
}

export function writeCard(root, card, relPath) {
  const rel = relPath ?? card?.relPath ?? ''
  const file = rel ? join(root, rel) : ''
  const existing = file && existsSync(file) ? readCard(file) : null

  const provided = card?.basic ?? {}
  const basic = { ...(existing?.basic ?? {}) }
  for (const [k, v] of Object.entries(provided)) basic[k] = v
  if (!basic.私有) basic.私有 = defaultPrivate(basic.类型)

  const issues = checkBasic(basic)
  if (!rel) issues.push('缺相对路径：卡放在 <大类>/<类型>/卡-<YYYYMMDD>-<短名>.md')
  else {
    const pathProblem = cardPathProblem(rel)
    if (pathProblem) issues.push(pathProblem)
  }
  if (issues.length) return { ok: false, issues, relPath: rel }

  const next = {
    basic,
    dimension: { ...(existing?.dimension ?? {}), ...(card?.dimension ?? {}) },
    body: { ...(existing?.body ?? {}), ...(card?.body ?? {}) },
  }
  writeAtomic(file, renderCard(next))
  upsertIndex(root, indexRow(next, rel))
  return { ok: true, issues: [], relPath: rel }
}

// —— 接口二：查一个库。身份证、索引、卡三方对账。
// 索引被当作派生视图来查：由每张卡重算该有的行，与索引里的行逐列比。
// 只查「在不在」不够——卡改了要点而索引没跟，那种漂移恰恰最难靠人眼发现。
export function checkVault(root) {
  const issues = []
  const meta = readVaultMeta(root)
  if (!meta.exists) issues.push('缺 VAULT.md 身份证')
  else if (meta.version !== SCHEMA_VERSION) issues.push(`身份证版本 ${meta.version} ≠ 当前 ${SCHEMA_VERSION}，须先升级`)

  // 缺 INDEX.md 是错，空索引不是错：init 刚建出来的库就该一张卡也没有（F-09）。
  if (!existsSync(join(root, 'INDEX.md'))) issues.push('缺 INDEX.md')
  const rows = readIndex(root)
  const byPath = new Map(rows.map((r) => [r.相对路径, r]))

  for (const row of rows) {
    // 已删卡片/ 里的卡不是活卡：索引里还留着它的行，说明 delete 只搬了文件没清索引。
    if (isTrashed(row.相对路径)) issues.push(`索引里仍有已删卡的行：${row.相对路径}，说明删卡没做干净，跑一次 index rebuild`)
    else if (!existsSync(join(root, row.相对路径))) issues.push(`索引行指向不存在的卡：${row.相对路径}`)
    // 索引里躺着的卡也要校路径层级：入口拒掉只管将来，老库里已经深了一层的得被喊出来，
    // 否则它 find 看得见、overview 看不见，库自己前后矛盾。
    else {
      const pathProblem = cardPathProblem(row.相对路径)
      if (pathProblem) issues.push(`索引行路径层级不对：${pathProblem}`)
    }
  }

  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    for (const i of checkBasic(card.basic)) issues.push(`${rel}：${i}`)

    const row = byPath.get(rel)
    if (!row) {
      issues.push(`卡未进索引：${rel}`)
      continue
    }
    // 逐列比对：索引里的每一列都应等于「由这张卡重算出来的那一列」。
    const want = indexRow(card, rel)
    for (const col of INDEX_COLUMNS) {
      const got = row[col] ?? ''
      if (got !== want[col]) issues.push(`索引与卡不一致：${rel} 的「${col}」索引写「${got}」，卡上是「${want[col]}」`)
    }
  }
  return issues
}

// 库里的卡：<大类>/<类型>/卡-*.md。只认这个形状，其它文件不是卡。
// 已删卡片/ 是删卡的回收站（F-14），里面的东西不是活卡，不扫。
function listCards(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 2 || !existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === TRASH_DIR) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/^卡-.+\.md$/.test(entry.name)) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root, 0)
  return out
}


// —— 退休建议（F-20 / Q-04 已决口径）：只列不删，谁退休由人拍板。
// Q-04 原文的判据是「连续 12 个月未被检索命中」，但检索是入口里的对话动作、
// 不落盘，系统里没有「命中」这件事可查（见 PRD 0.6.0 缺口 1）。改用卡上已有的、
// 写在文件内容里的证据，不用文件 mtime——git 检出、拷贝、同步都会把 mtime 刷成
// 当前时间，老卡会全看起来「刚动过」，退休线永远不触发。
//
// 三个证据同时成立才建议退休：采集日期超过 12 个月、已用在 为空、补充记录 为空。
// 它判的是「一直没人动」，不是「质量差」——后者机器判不了，只能人看。
export const RETIRE_MONTHS = 12

// 从「采集日期」算月数。解析不出就返回 null（当它不到期），
// 宁可漏列也不误列：格式不合规该由 check 报，不该混进退休清单。
function monthsSince(dateText, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText ?? '').trim())
  if (!m) return null
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(then.getTime())) return null
  return (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth())
}

// 已用在 / 补充记录 是否有实质内容。空白、单个破折号、「无」「暂无」「待补」都算空：
// 老卡上这类占位写法很常见，当成「用过」会让退休清单永远空着。
function hasContent(value) {
  const v = String(value ?? '').trim()
  if (!v) return false
  return !/^(?:[-—–\s]|无|暂无|待补)$/.test(v)
}

export function retireSuggest(root, { months = RETIRE_MONTHS, now = new Date() } = {}) {
  const limit = Number.isFinite(Number(months)) ? Number(months) : RETIRE_MONTHS
  const rows = []
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    const age = monthsSince(card.basic.采集日期, now)
    if (age === null || age < limit) continue
    if (hasContent(card.body.已用在) || hasContent(card.body.补充记录)) continue
    rows.push({
      卡名: card.basic.卡名 ?? '',
      类型: card.basic.类型 ?? '',
      采集日期: card.basic.采集日期 ?? '',
      闲置月数: age,
      相对路径: rel,
    })
  }
  // 闲置最久的排最前：人拍板时先看最该退休的那几张。
  rows.sort((a, b) => b.闲置月数 - a.闲置月数 || a.相对路径.localeCompare(b.相对路径))
  return { limit, rows }
}

// —— 已用标记（F-21 / Q-05 已决口径）：记到「《书名》第 N 章」。
// 做成追加而不是覆盖：一张卡可能被用进多部作品，覆盖会抹掉前一次的记录，
// 而 F-21 的目的恰恰是「防同一个梗用两遍」——抹掉记录就正好破了它。
export function markUsed(root, { path: relPath, work, chapter } = {}) {
  const checked = cardRel(relPath)
  if (!checked.ok) return { ok: false, issues: [checked.error] }
  const rel = checked.rel

  const title = String(work ?? '').trim().replace(/^《|》$/g, '')
  if (!title) return { ok: false, issues: ['缺 --work：用在哪个作品，如 长夜（书名号可省）'] }
  // 章节允许非数字：「番外」「楔子」也是章，只要求非空。
  const chap = String(chapter ?? '').trim()
  if (!chap) return { ok: false, issues: ['缺 --chapter：第几章，如 12 或 楔子'] }

  const file = join(root, rel)
  if (!existsSync(file)) return { ok: false, issues: ['卡不存在：' + rel] }

  const card = readCard(file)
  const entry = '《' + title + '》第 ' + chap + ' 章'
  const before = String(card.body.已用在 ?? '').trim()
  const already = before.split('；').map((s) => s.trim()).filter(Boolean)
  if (already.includes(entry)) {
    // 重复记同一处不是错误，但不必写第二遍。
    return { ok: true, issues: [], relPath: rel, added: false, usedIn: before, entry }
  }
  const usedIn = already.length ? already.join('；') + '；' + entry : entry

  // 走 cardEdit 而不是自己拼文件：改正文节的一行、同步索引它已经做了，
  // 这里再写一遍就是第二份实现，迟早漂移。
  const edited = cardEdit(root, { path: rel, field: '已用在', value: usedIn, section: SECTION_BODY })
  if (!edited.ok) return { ok: false, issues: edited.issues }
  return { ok: true, issues: [], relPath: rel, added: true, usedIn, entry }
}

// —— 复审清单（F-23）：列出时效敏感、且采集后久未核对的卡。
//
// 「多久算超期」此前全库没有定义，2026-10-24 定为按细分分档：
// 网络热梗 3 个月、时事热点 6 个月、其余时效敏感细分 12 个月。
// 热梗生命周期短，一个梗三个月就凉是常态；时事稍长；故不取一个数了事。
//
// 只对时效敏感的卡算：时效状态为「长期」的卡没有保鲜问题，
// 把它们列进来只会淹没真正该看的那些。
export const REVIEW_MONTHS = { 网络热梗: 3, 时事热点: 6, 默认: 12 }

// 按细分取复审周期。细分名可能带后缀说明，用包含匹配。
function reviewMonthsFor(细分) {
  const s = String(细分 ?? '')
  if (s.includes('网络热梗')) return { months: REVIEW_MONTHS.网络热梗, kind: '网络热梗' }
  if (s.includes('时事热点')) return { months: REVIEW_MONTHS.时事热点, kind: '时事热点' }
  return { months: REVIEW_MONTHS.默认, kind: '时效敏感' }
}

export function reviewSuggest(root, { now = new Date() } = {}) {
  const rows = []
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    const state = String(card.basic.时效状态 ?? '').trim()
    // 「长期」没有保鲜问题；空或取值不合法的交给 check 报，不混进复审清单。
    if (!state || state === '长期') continue
    const age = monthsSince(card.basic.采集日期, now)
    if (age === null) continue
    const { months, kind } = reviewMonthsFor(card.basic.细分)
    if (age < months) continue
    rows.push({
      卡名: card.basic.卡名 ?? '',
      细分: card.basic.细分 ?? '',
      时效状态: state,
      采集日期: card.basic.采集日期 ?? '',
      超期月数: age - months,
      复审周期: months,
      分档: kind,
      相对路径: rel,
    })
  }
  // 超期最久的排最前。
  rows.sort((a, b) => b.超期月数 - a.超期月数 || a.相对路径.localeCompare(b.相对路径))
  return { cycles: REVIEW_MONTHS, rows }
}

// —— 链接待核（F-23 的后半句「链接已失效」）：本技能离线可用、零依赖，
// 不能真的去探测链接。故只做「有出处链接、且卡已老」的提示，请人自己点一下，
// 不在输出里说「已失效」——那是我们没验证过的话。
export function linkChecks(root, { months = REVIEW_MONTHS.默认, now = new Date() } = {}) {
  const rows = []
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    const link = String(card.basic.出处链接 ?? '').trim()
    if (!link) continue
    const age = monthsSince(card.basic.采集日期, now)
    if (age === null || age < months) continue
    rows.push({ 卡名: card.basic.卡名 ?? '', 采集日期: card.basic.采集日期 ?? '', 闲置月数: age, 出处链接: link, 相对路径: rel })
  }
  rows.sort((a, b) => b.闲置月数 - a.闲置月数 || a.相对路径.localeCompare(b.相对路径))
  return { months, rows }
}

// —— 库况（F-28）：一眼看各类型卡数、最近收卡时间、待补与待复审数量，
// 并指出偏薄的类型。
//
// 「待补」不是新概念：F-10 的 upgrade 把机器补不出的必填字段填成「待补」，
// 这里的「待补」就是数这种占位值还留在卡上的字段。原先 F-28 只说「待补」
// 没给定义，容易被理解成别的意思（比如「还没想好写什么的卡」）。
//
// 「偏薄」的口径：该类型卡数少于薄线（默认 5）。注册表把十一个类型分得很细，
// 每类型至少五张才够检索时挑得出东西；低于这个数只是提示，不是错误。
export const THIN_THRESHOLD = 5

export function vaultOverview(root, { thin = THIN_THRESHOLD, now = new Date() } = {}) {
  const limit = Number.isFinite(Number(thin)) ? Number(thin) : THIN_THRESHOLD
  const cards = []
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    cards.push({ rel, basic: card.basic })
  }

  // 各类型卡数。按注册表顺序排，不按卡数排：类型号是稳定的参照，
  // 每次看都是同一顺序，才看得出哪一个类型在长、哪一个类型停了。
  const byFamily = new Map()
  const byBucket = new Map()
  for (const { basic } of cards) {
    const fam = String(basic.类型 ?? '').trim() || '（未填）'
    const bucket = String(basic.大类 ?? '').trim() || '（未填）'
    byFamily.set(fam, (byFamily.get(fam) ?? 0) + 1)
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1)
  }

  // 待补：卡上任何必填字段的值还是「待补」。
  const pending = []
  for (const { rel, basic } of cards) {
    for (const name of REQUIRED_FIELDS) {
      if (String(basic[name] ?? '').trim() === '待补') pending.push({ 卡名: basic.卡名 ?? '', field: name, 相对路径: rel })
    }
  }

  // 最近收卡：取「采集日期」最大的那天。日期解析不出的不参与。
  let latest = null
  for (const { basic } of cards) {
    const d = String(basic.采集日期 ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (!latest || d > latest) latest = d
  }

  const review = reviewSuggest(root, { now })
  const thinFamilies = [...byFamily.entries()]
    .filter(([, n]) => n < limit)
    .map(([family, n]) => ({ 类型: family, 卡数: n }))
    .sort((a, b) => a.卡数 - b.卡数 || a.类型.localeCompare(b.类型))

  return {
    total: cards.length,
    byBucket: [...byBucket.entries()].map(([大类, n]) => ({ 大类, 卡数: n })),
    byFamily: [...byFamily.entries()].map(([类型, n]) => ({ 类型, 卡数: n })),
    latest,
    pending,
    review: review.rows.length,
    thin: limit,
    thinFamilies,
  }
}

// —— 项目视图（F-26）：给一个书名，列出「已用在」含这本书的卡。
//
// 不新增任何记录结构：0.6.0 的 used 已经把「《书名》第 12 章」写进了卡的
// 「已用在」行，直接用那一行筛。另建一份引用记录能多记「查过但没用在书里」
// 的卡，但那就多一份要维护的状态、也多一处可漂移。
//
// 书名的匹配去书名号、去空白后按「包含」比：用户说「长夜」要能命中
// 「《长夜》第 3 章」，说「长夜第二部」也该能命中「《长夜第二部》第 1 章」。
export function projectView(root, { work } = {}) {
  const title = String(work ?? '').trim().replace(/^《|》$/g, '')
  if (!title) return { ok: false, issues: ['缺 --work：要看哪本书用过的卡，如 长夜（书名号可省）'], rows: [] }

  const rows = []
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    const usedIn = String(card.body.已用在 ?? '').trim()
    if (!usedIn) continue
    // 「已用在」里可能记着多部作品，用「；」隔开；逐条看哪几条属于这本书。
    const hits = usedIn
      .split('；')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((entry) => entry.replace(/^《|》$/g, '').includes(title))
    if (hits.length === 0) continue
    rows.push({
      卡名: card.basic.卡名 ?? '',
      大类: card.basic.大类 ?? '',
      类型: card.basic.类型 ?? '',
      细分: card.basic.细分 ?? '',
      要点: card.basic.要点 ?? '',
      用在哪: hits.join('；'),
      相对路径: rel,
    })
  }

  // 按大类再按类型排：看「这本书用过的卡都集中在哪类素材」时，顺序稳定比命中顺序有用。
  rows.sort((a, b) => a.大类.localeCompare(b.大类) || a.类型.localeCompare(b.类型) || a.相对路径.localeCompare(b.相对路径))

  const byBucket = new Map()
  for (const r of rows) byBucket.set(r.大类, (byBucket.get(r.大类) ?? 0) + 1)

  return {
    ok: true,
    issues: [],
    work: title,
    rows,
    byBucket: [...byBucket.entries()].map(([大类, n]) => ({ 大类, 卡数: n })),
  }
}

// —— 引用包（F-27）：把选中的卡打包成一份 Markdown，喂给写作助手。
//
// 这是本技能第一个**导出**功能，于是 F-17 那条「私有为是即不分发」
// 到这一版才第一次有了可执行的地方：凡是导出的产物，私有卡一律不进。
// 过滤必须发生在这里、且不依赖调用方记得传参——默认就排除，没有开关。
//
// 输出写在当前目录而不是库内：引用包是写书时的消耗品，写进库会跟着库
// 被拷来拷去、越攒越肥；而库要能拷进写书项目，不该装这种一次性产物。
export function packCards(root, { paths, work, date = new Date() } = {}) {
  const list = Array.isArray(paths) ? paths : splitValues(paths)
  if (list.length === 0) {
    return { ok: false, issues: ['缺 --paths：要打包哪些卡，给相对路径（逗号分隔）'], cards: [], excluded: [] }
  }

  const cards = []
  const excluded = []
  const missing = []
  for (const raw of list) {
    const checked = cardRel(raw)
    if (!checked.ok) return { ok: false, issues: [checked.error], cards: [], excluded: [] }
    const rel = checked.rel
    const file = join(root, rel)
    if (!existsSync(file)) { missing.push(rel); continue }
    const card = readCard(file)
    // F-17：私有的卡不进任何导出产物。悄悄跳过不行——得让人知道少了什么，
    // 否则他会以为引用包是完整的。
    if (String(card.basic.私有 ?? '').trim() === '是') {
      excluded.push({ 卡名: card.basic.卡名 ?? '', 相对路径: rel, 原因: '私有：是（F-17 规定不外流）' })
      continue
    }
    cards.push({ rel, basic: card.basic, dimension: card.dimension, body: card.body })
  }

  if (missing.length) {
    return { ok: false, issues: missing.map((m) => `卡不存在：${m}`), cards: [], excluded: [] }
  }
  if (cards.length === 0) {
    // 全是私有卡时不产出空文件：那会让人以为导成功了，而其实一张都没进去。
    return { ok: false, issues: ['给的全都是私有卡，没有可打包的内容（F-17：私有卡一律不外流）'], cards: [], excluded }
  }

  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const title = work ? `引用包：${work}` : '引用包'

  const out = []
  out.push(`# ${title}`)
  out.push('')
  out.push(`打包于 ${stamp}，共 ${cards.length} 张卡。`)
  out.push('')
  out.push('> 这份文件是给写作助手看的素材清单，由 Sumeru 素材库导出。')
  out.push('> 每张卡给类型、要点、内容与借鉴意图；「私有」为「是」的卡不会出现在这里。')

  for (const c of cards) {
    out.push('')
    out.push(`## ${c.basic.卡名 ?? '（无卡名）'}`)
    out.push('')
    out.push(`- 类型：${c.basic.类型 ?? ''} / ${c.basic.细分 ?? ''}`)
    out.push(`- 要点：${c.basic.要点 ?? ''}`)
    out.push(`- 时效：${c.basic.时效状态 ?? ''}；来源等级：${c.basic.来源等级 ?? ''}`)
    if (c.basic.来源) out.push(`- 来源：${c.basic.来源}`)
    if (c.basic.出处链接) out.push(`- 出处：${c.basic.出处链接}`)
    // 正文只取「内容」「原文摘录或事实要点」「借鉴意图」三行：
    // 「关联卡」「补充记录」是库内维护用的，喂给写作助手只会变成噪音；
    // 「已用在」是作者自己的账，也不该跟着素材一起流出去。
    const sections = [
      ['内容', c.body.内容],
      ['原文摘录或事实要点', c.body.原文摘录或事实要点],
      ['借鉴意图', c.body.借鉴意图],
    ]
    for (const [label, value] of sections) {
      const v = String(value ?? '').trim()
      if (!v) continue
      out.push('')
      out.push(`${label}：`)
      out.push('')
      out.push(v)
    }
  }

  return { ok: true, issues: [], cards, excluded, content: out.join('\n') + '\n', stamp, title }
}

// —— 补卡不建新卡（F-30 批二）：一条命令完成「没新内容就跳过、有新内容就补进旧卡」。
//
// 为什么不靠流程自觉：J-05 要求采集前先查重，但查重是人的动作——采集员
// 生成了卡、写进了库，事后没人会回头逐行比对。这里把判断做成命令：
// 调用方给「这次要记的内容」，它自己决定是跳过、补卡，还是建新卡。
//
// 三种结果都不是错误（退出码都是 0），但要说清是哪一种：
//   skipped —— 已有这张卡，且这次的内容它已经有了
//   appended —— 已有这张卡，把新内容追加进「补充记录」
// 把 JSON.parse 的报错翻译成能定位的话。
//
// 为什么值得单独做：产卡时最高频的两个错是「中文字段里要引用书名，敲了 ASCII 双引号」
// 与「文件带 BOM」。原生报错只说 position 372，人得自己数到第 372 个字符才找得到；
// 而 BOM 更隐蔽——它让报错指到第 1 行第 1 列，看起来完全不像 BOM 的问题。
export function jsonProblem(text, err, label) {
  const msg = String(err?.message ?? err)
  const lc = /line (\d+) column (\d+)/.exec(msg)
  const pos = /position (\d+)/.exec(msg)
  let line = null
  let col = null
  if (lc) {
    line = Number(lc[1])
    col = Number(lc[2])
  } else if (pos) {
    const n = Number(pos[1])
    const before = text.slice(0, n)
    line = before.split('\n').length
    col = n - before.lastIndexOf('\n')
  }

  const bom = text.charCodeAt(0) === 0xfeff
  const out = [`${label}：不是合法 JSON`]
  if (bom) {
    out.push('  文件开头有 BOM（U+FEFF），JSON.parse 不认。用无 BOM 的 UTF-8 重写即可。')
    out.push('  PowerShell 的 Set-Content -Encoding utf8 会带 BOM；改用 [System.IO.File]::WriteAllText + UTF8Encoding($false)。')
  } else {
    out.push(`  ${msg}`)
  }
  if (line != null) {
    out.push(`  第 ${line} 行${col != null ? ` 第 ${col} 列` : ''}`)
    const raw = String(text.split('\n')[line - 1] ?? '')
    out.push(`  > ${raw.length > 140 ? raw.slice(0, 140) + '…' : raw}`)
    if (col != null && col <= 140) out.push(`  ${' '.repeat(2 + Math.max(0, col - 1))}^`)
  } else {
    // V8 有一部分报错（如 `Unexpected token '}'`）根本不带 position。
    // 这时退化成按行编号列出——卡 JSON 通常几十行，人一眼就能扫到坏在哪。
    const all = text.split('\n')
    out.push(`  没有位置信息，按行编号列出（共 ${all.length} 行，最多显示 40 行）：`)
    for (const [i, raw] of all.slice(0, 40).entries()) {
      out.push(`  第 ${i + 1} 行：${raw.length > 140 ? raw.slice(0, 140) + '…' : raw}`)
    }
    if (all.length > 40) out.push(`  …还有 ${all.length - 40} 行未显示`)
  }
  return out.join('\n')
}

//   created —— 库里还没有这张卡，按正常路径建一张
// 只有参数不合法才是退出码 2。
export function addMaterial(root, { card, date = new Date() } = {}) {
  // 读卡文件：读不到要说人话。裸 readFileSync 会把 ENOENT 栈直接抛给用户，
  // 看到的是 node:fs 的调用栈而不是「文件不存在」。
  // 顺带兑现 USAGE 里写的「- 表示从标准输入读」——原写法 readFileSync('-')
  // 只会去找一个名叫 `-` 的文件。
  let input
  let text = ''
  if (typeof card === 'string') {
    try {
      text = card === '-' ? readFileSync(0, 'utf8') : readFileSync(card, 'utf8')
      input = JSON.parse(text)
    } catch (e) {
      const why =
        e.code === 'ENOENT'
          ? `找不到文件：${card}`
          : e instanceof SyntaxError
            ? jsonProblem(text, e, card)
            : `读不了文件：${card}`
      return { ok: false, issues: [why], action: null, code: 'E_ARGS' }
    }
  } else {
    input = card
  }
  if (!input || typeof input !== 'object') return { ok: false, issues: ['缺 --card：本次要记的卡内容（JSON 文件）'], action: null, code: 'E_ARGS' }

  const key = objectKeyOf(input.basic)
  if (!key) return { ok: false, issues: ['这张卡既没有「对象标识」也没有「卡名」，认不出是哪个对象'], action: null, code: 'E_ARGS' }

  // 按对象键在库里找已有的卡，**只在同一类型内找**。
  //
  // 跨类型不算重复（F-30 原话：同一个人跨类型不算重复，人物设定卡和作品切片卡
  // 是两回事，用关联卡互指）。若不分类型，「五条悟」有了人物设定卡之后，
  // 想给他建一张作品切片卡就会被判成「已有」而跳过——那会把该建的卡挡在门外，
  // 而且挡得毫无提示。只认活卡，不看已删卡片/。
  const family = String(input.basic?.类型 ?? '').trim()
  const existing = []
  for (const rel of listCards(root)) {
    const c = readCard(join(root, rel))
    if (objectKeyOf(c.basic) !== key) continue
    // 同类型才算重复。类型名为空时（老卡或非法卡）也按同类型处理，宁可多拦一次。
    if (family && String(c.basic.类型 ?? '').trim() && String(c.basic.类型 ?? '').trim() !== family) continue
    existing.push({ rel, card: c })
  }

  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const incoming = String(input.补充内容 ?? '').trim()

  if (existing.length === 0) {
    // 同类型里没有，但别的类型可能有同一个对象。跨类型各自成卡（F-30），并且要互指——
    // 「关联卡」这一行得有人填，否则同一个角色在库里散成几张互不相识的卡，
    // 写书时问「五条悟的料」只拿到其中一张。
    const elsewhere = []
    for (const rel of listCards(root)) {
      const c = readCard(join(root, rel))
      if (objectKeyOf(c.basic) !== key) continue
      elsewhere.push({ rel, 类型: c.basic.类型 ?? '' })
    }
    // 没卡就正常建一张。补卡路径不负责猜路径与字段，交给 writeCard。
    //
    // 但「补充内容」得写进去：建卡那一刻算出来的 incoming 如果不用，用户第一次
    // 补卡带的内容就凭空消失——结果只说「已建新卡」，卡上却没有那段话。
    // 这比子串误判更隐蔽：误判至少卡已经存在、能再补一次；这条是内容从没落过盘。
    const built = { ...input }
    if (incoming) {
      const body = { ...(built.body ?? {}) }
      const prev = String(body.补充记录 ?? '').trim()
      const line = /^\d{4}-\d{2}-\d{2}\s+\S/.test(incoming) ? incoming : `${stamp} ${incoming}`
      body.补充记录 = prev ? prev + '\n' + line : line
      built.body = body
    }
    const written = writeCard(root, built)
    if (!written.ok) return { ok: false, issues: written.issues, action: 'created' }

    // 跨类型互指：A-10 明确要求「跨类型各自成卡并互指关联」。这里不是猜——
    // 新旧两张卡的路径都是确定的，把对方的路径写进各自的「关联卡」行。
    // 只在两张卡的类型确实不同时做；同类型已被上面的查重挡住，走不到这里。
    const linked = []
    if (elsewhere.length) {
      const mine = (input.body?.关联卡 ?? '').trim()
      const theirs = elsewhere.map((e) => e.rel).join('；')
      const merged = mine ? (mine.includes(theirs) ? mine : mine + '；' + theirs) : theirs
      const selfEdit = cardEdit(root, { path: written.relPath, field: '关联卡', value: merged, section: SECTION_BODY })
      if (selfEdit.ok) linked.push({ rel: written.relPath, 关联卡: merged })
      // 反过来也要写：只填一边，从旧卡查不到新卡，互指就成了单向。
      for (const e of elsewhere) {
        const oldCard = readCard(join(root, e.rel))
        const oldRel = String(oldCard.body.关联卡 ?? '').trim()
        const oldMerged = oldRel ? (oldRel.includes(written.relPath) ? oldRel : oldRel + '；' + written.relPath) : written.relPath
        const backEdit = cardEdit(root, { path: e.rel, field: '关联卡', value: oldMerged, section: SECTION_BODY })
        if (backEdit.ok) linked.push({ rel: e.rel, 关联卡: oldMerged })
      }
    }

    return {
      ok: true,
      issues: [],
      action: 'created',
      relPath: written.relPath,
      // 跨类型已有卡时把它们的路径交回去，并已把路径写进各自的「关联卡」。
      relatedElsewhere: elsewhere,
      linked,
    }
  }

  // 已有卡：先看这次的内容是不是它已经有了。
  // 判「已有」不只看补充记录：内容可能本来就在正文里，那也算有。
  //
  // 判定尺度是「整条相等」，不是「子串包含」。
  // 子串会把意思相反的新信息吞掉：旧正文写「他并不是天才，全靠苦练」，
  // 新补「天才」是它的子串，于是判成「已有」而静默丢弃——丢掉的那条恰好是
  // 与旧文相反的说法，正是最该记进去的。这类误判无从察觉：结果只显示「这张卡
  // 上已经有这段内容了」，人不会去核对一张据说没变的卡。
  //
  // 宁可多追加一条近似重复，也不吞掉一条真新增：前者在卡上看得见，事后合并
  // 得掉；后者看不见，会一直缺着。尺度与 J-26 同向——不确定时选能留下痕迹的那边。
  const target = existing[0]
  const bodySections = Object.values(target.card.body ?? {}).map((v) => String(v ?? '').trim())
  // 补充行形如「2026-10-24 补了什么」。剥前缀时要**反复剥到剥不动**，只剥一层不够：
  // 若补充内容本身以日期开头（「2026-10-24 那天他与宿傩交手」），卡上那行是
  // 「2026-10-24 2026-10-24 那天…」。只剥一层得到「2026-10-24 那天…」，与补的
  // 「2026-10-24 那天…」不等，于是判为新增又写一遍——同一段内容在卡里躺两行。
  const stripStamp = (line) => {
    let s = line.trim()
    for (;;) {
      const next = s.replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
      if (next === s) return s
      s = next
    }
  }
  const alreadyThere = bodySections.some((text) => {
    if (!text) return false
    // 整节就是这条内容，或其中某一行与它逐字相同（补充记录是逐行记的）。
    if (text === incoming) return true
    return text.split('\n').some((line) => stripStamp(line) === stripStamp(incoming))
  })
  if (incoming && alreadyThere) {
    return {
      ok: true,
      issues: [],
      action: 'skipped',
      relPath: target.rel,
      卡名: target.card.basic.卡名 ?? '',
      reason: '这张卡上已经有这段内容了',
      duplicates: existing.map((e) => e.rel),
    }
  }

  // 没给新增内容，只是来问「有没有这张卡」——告知有，不写任何东西。
  if (!incoming) {
    return {
      ok: true,
      issues: [],
      action: 'skipped',
      relPath: target.rel,
      卡名: target.card.basic.卡名 ?? '',
      reason: '这张卡已在库里，本次没带新内容',
      duplicates: existing.map((e) => e.rel),
    }
  }

  // 有新内容：追加一行「日期 补了什么」，不建第二张卡。
  // 补充记录是逐行记的，新的接在末尾（版式约定：一行一条，按时间顺序）。
  //
  // 内容本身已带日期时（「2026-01-01 旧事」）不再加今天的日期：版式要的是
  // 「一行一条、日期在前」，前面已经有一个日期就满足了。硬加会写成
  // 「2026-10-24 2026-01-01 旧事」——读者分不清哪个是采集日、哪个是事件日，
  // 而且这行也再认不出是「旧事」那条了。
  const before = String(target.card.body.补充记录 ?? '').trim()
  const entry = /^\d{4}-\d{2}-\d{2}\s+\S/.test(incoming) ? incoming : `${stamp} ${incoming}`
  const after = before ? before + '\n' + entry : entry
  const edited = cardEdit(root, { path: target.rel, field: '补充记录', value: after, section: SECTION_BODY })
  if (!edited.ok) return { ok: false, issues: edited.issues, action: 'appended' }
  return {
    ok: true,
    issues: [],
    action: 'appended',
    relPath: target.rel,
    卡名: target.card.basic.卡名 ?? '',
    entry,
    duplicates: existing.map((e) => e.rel),
  }
}

// —— 查全库同对象双卡（F-30 批三）：只列不改，删不删由人逐张点名。
//
// 这一条是 J-05 的机器替身。J-05 原来的验证方式写的是「人工核对：索引无
// 同对象双卡」——全库唯一一条靠人眼在索引里找双卡的硬判据。采集时最容易
// 失守的恰恰是它：卡一张张建出来，没人会回头逐行比对「这两张是不是同一个人」。
//
// 分组键是「类型 + 对象键」，不是对象键单用：跨类型各自成卡（F-30），
// 同一个人在人物设定与作品切片里各有一张是对的，不是重复。
export function dupesReport(root) {
  const groups = new Map()
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    const key = objectKeyOf(card.basic)
    if (!key) continue
    const family = String(card.basic.类型 ?? '').trim()
    const gk = family + '\u0000' + key
    if (!groups.has(gk)) groups.set(gk, { 类型: family, 对象键: key, 卡: [] })
    groups.get(gk).卡.push({
      卡名: card.basic.卡名 ?? '',
      采集日期: card.basic.采集日期 ?? '',
      对象标识: card.basic.对象标识 ?? '',
      相对路径: rel,
    })
  }

  const rows = []
  for (const g of groups.values()) {
    if (g.卡.length < 2) continue
    // 同组内按采集日期排：先收的那张通常该留下，后来的内容并进去。
    g.卡.sort((a, b) => a.采集日期.localeCompare(b.采集日期) || a.相对路径.localeCompare(b.相对路径))
    rows.push({
      类型: g.类型,
      卡数: g.卡.length,
      卡: g.卡,
      建议留下: g.卡[0].相对路径,
      建议并入: g.卡.slice(1).map((c) => c.相对路径),
    })
  }
  rows.sort((a, b) => b.卡数 - a.卡数 || a.类型.localeCompare(b.类型))
  return { ok: true, issues: [], rows, total: rows.reduce((n, r) => n + r.卡数, 0) }
}
// —— 相对路径的把关：卡管理全部动作都按「库内的相对路径」定位，越界一律拒绝。
// 理由与技术文档「写入库根之外的路径一律拒绝」一致：卡管理会移动与删除文件，
// 路径越界在这里的代价是删掉库外的东西。
function isTrashed(rel) {
  return rel === TRASH_DIR || rel.startsWith(`${TRASH_DIR}/`)
}

function safeRelPath(rel) {
  const text = String(rel ?? '').trim()
  if (!text) return { ok: false, error: '缺路径：要操作的卡在库内的相对路径，形如 故事零件/人物设定/卡-<YYYYMMDD>-<短名>.md' }
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text)) return { ok: false, error: `路径只收库内相对路径，不收绝对路径：${text}` }
  const parts = text.split(/[/\\]+/).filter((p) => p && p !== '.')
  if (parts.includes('..')) return { ok: false, error: `路径不得含 ..（会写出库根之外）：${text}` }
  if (parts.length < 2) return { ok: false, error: `路径须为 <大类>/<类型>/<卡文件名>：${text}` }
  return { ok: true, rel: parts.join('/') }
}

// 卡管理只认活卡的形状（与 listCards 同一口径）：文件名不是 卡-*.md 的一律拒绝。
// 放宽的代价是 delete 能把任意文件搬进回收站，而它根本不在索引里，事后没人想得起来找。
const CARD_FILE = /^卡-.+\.md$/

function cardRel(rel) {
  const checked = safeRelPath(rel)
  if (!checked.ok) return checked
  if (!CARD_FILE.test(checked.rel.split('/').at(-1))) {
    return { ok: false, error: `「${checked.rel}」不像素材卡：卡文件名以「卡-」开头、以 .md 结尾` }
  }
  return checked
}

// —— 接口六：改卡上的一行（F-14 的「改」）。大类与类型不走这里，走 cardMove。
// 认三个节：基本信息（默认）、类型维度（--section 类型维度）、正文。
// 字段不存在时不新建：拼错字段名若静默新增，卡上会多出一行谁也不知道的字段。
const SECTION_BASIC = '基本信息'
const SECTION_DIMENSION = '类型维度'
const SECTION_BODY = '正文'
const CARD_SECTIONS = [SECTION_BASIC, SECTION_DIMENSION, SECTION_BODY]
// 这两行决定文件放在哪个目录，改了而不挪文件，文件位置与字段就不符（F-14 把挪类型单列一条）。
const LOCATION_FIELDS = ['大类', '类型']

export function cardEdit(root, { path: relPath, field, value, section = SECTION_BASIC } = {}) {
  const checked = cardRel(relPath)
  if (!checked.ok) return { ok: false, issues: [checked.error] }
  const rel = checked.rel
  const sectionName = section || SECTION_BASIC
  if (!CARD_SECTIONS.includes(sectionName)) {
    return { ok: false, issues: [`--section 只认「${CARD_SECTIONS.join('」「')}」：${sectionName}`] }
  }
  const name = String(field ?? '').trim()
  if (!name) return { ok: false, issues: ['缺 --field：要改哪一行，如 要点'] }
  if (LOCATION_FIELDS.includes(name) && sectionName === SECTION_BASIC) {
    return { ok: false, issues: [`「${name}」决定文件放在哪个目录，不走 card edit；改用 card move --bucket <大类> --family <类型>`] }
  }
  if (value === undefined) return { ok: false, issues: ['缺 --value：这一行改成什么'] }

  const file = join(root, rel)
  if (!existsSync(file)) return { ok: false, issues: [`卡不存在：${rel}`] }

  const card = readCard(file)
  const bucketName = sectionName === SECTION_BASIC ? 'basic' : sectionName === SECTION_DIMENSION ? 'dimension' : 'body'
  const target = card[bucketName] ?? {}
  if (!(name in target)) {
    return { ok: false, issues: [`卡的「${sectionName}」里没有「${name}」这一行，不新建：先确认字段名，或用 write 整卡重写`] }
  }

  // 走 writeCard 而不是自己渲染：校验、补默认值、落卡、修索引都在那一处，改卡不该另起一条写路径（D-02）。
  const result = writeCard(root, { basic: bucketName === 'basic' ? { [name]: value } : {}, dimension: bucketName === 'dimension' ? { [name]: value } : {}, body: bucketName === 'body' ? { [name]: value } : {} }, rel)
  if (!result.ok) return { ok: false, issues: result.issues }
  return { ok: true, issues: [], relPath: rel, field: name, value }
}

// —— 接口七：删卡（F-14 的「删」）。卡连同相对路径移进 已删卡片/，索引行同步删掉。
// 不真删文件：删错了还能 restore 回来（A-07 要的就是这条路）。
export function cardDelete(root, { path: relPath } = {}) {
  const checked = cardRel(relPath)
  if (!checked.ok) return { ok: false, issues: [checked.error] }
  const rel = checked.rel
  if (isTrashed(rel)) return { ok: false, issues: [`这张卡已经在 ${TRASH_DIR}/ 里了：${rel}`] }
  const file = join(root, rel)
  if (!existsSync(file)) return { ok: false, issues: [`卡不存在：${rel}`] }

  const target = join(root, TRASH_DIR, rel)
  if (existsSync(target)) {
    // 同一相对路径下已有回收件：多半是删过一张又建了同名卡，谁盖谁都是丢数据。
    return { ok: false, issues: [`${TRASH_DIR}/ 里已有同路径的卡，不覆盖：${TRASH_DIR}/${rel}；先改名或手工处理那一张`] }
  }
  moveFile(file, target)
  dropIndexRows(root, [rel])
  return { ok: true, issues: [], relPath: rel, trashPath: `${TRASH_DIR}/${rel}` }
}

// —— 接口八：找回落进 已删卡片/ 的卡（F-14 / A-07）。
// 原位置被人占了就拒绝：restore 的语义是「回到原处」，盖掉新卡是另一种操作。
export function cardRestore(root, { path: relPath } = {}) {
  const checked = cardRel(relPath)
  if (!checked.ok) return { ok: false, issues: [checked.error] }
  const incoming = checked.rel
  const rel = isTrashed(incoming) ? incoming.slice(TRASH_DIR.length + 1) : incoming
  const file = join(root, TRASH_DIR, rel)
  if (!existsSync(file)) return { ok: false, issues: [`${TRASH_DIR}/ 里没有这张卡：${TRASH_DIR}/${rel}`] }

  const target = join(root, rel)
  if (existsSync(target)) return { ok: false, issues: [`原位置已被占用，不覆盖：${rel}。先处理占用它的那张卡，或改名后再 restore`] }

  moveFile(file, target)
  // 卡本身没改，索引行照卡重算即可；卡坏了则不补索引，交回问题由人修。
  const indexed = indexCard(root, rel)
  if (!indexed.ok) return { ok: false, issues: indexed.issues, relPath: rel }
  return { ok: true, issues: [], relPath: rel }
}

// —— 接口九：合并两张卡（F-14 的「并进那张」）。
// 被并入卡的两行内容并进目标卡：两边都有值时用「；」连，不丢任何一边。
// 原卡按 delete 的方式进 已删卡片/，索引只剩目标卡一行。
const MERGE_FIELDS = ['补充记录', '关联卡']

export function cardMerge(root, { from, into } = {}) {
  const fromChecked = cardRel(from)
  if (!fromChecked.ok) return { ok: false, issues: [`--from ${fromChecked.error}`] }
  const intoChecked = cardRel(into)
  if (!intoChecked.ok) return { ok: false, issues: [`--into ${intoChecked.error}`] }
  const fromRel = fromChecked.rel
  const intoRel = intoChecked.rel
  if (fromRel === intoRel) return { ok: false, issues: [`--from 与 --into 是同一张卡：${fromRel}`] }
  if (isTrashed(fromRel) || isTrashed(intoRel)) return { ok: false, issues: [`合并的两张卡都必须是活卡，不认 ${TRASH_DIR}/ 里的：${isTrashed(fromRel) ? fromRel : intoRel}`] }
  if (!existsSync(join(root, fromRel))) return { ok: false, issues: [`被并入的卡不存在：${fromRel}`] }
  if (!existsSync(join(root, intoRel))) return { ok: false, issues: [`目标卡不存在：${intoRel}`] }
  // 先查回收站占位再动目标卡：否则并了一半才发现放不进回收站，目标卡已经改了。
  if (existsSync(join(root, TRASH_DIR, fromRel))) {
    return { ok: false, issues: [`${TRASH_DIR}/ 里已有同路径的卡，不覆盖：${TRASH_DIR}/${fromRel}；先改名或手工处理那一张`] }
  }

  const source = readCard(join(root, fromRel))
  const merged = {}
  for (const key of MERGE_FIELDS) {
    const a = (source.body?.[key] ?? '').trim()
    const b = (readCard(join(root, intoRel)).body?.[key] ?? '').trim()
    if (!a) continue
    merged[key] = b ? (b.includes(a) ? b : `${b}；${a}`) : a
  }
  const written = Object.keys(merged).length
    ? writeCard(root, { body: merged }, intoRel)
    : { ok: true, issues: [] }
  if (!written.ok) return { ok: false, issues: written.issues }

  const trashed = cardDelete(root, { path: fromRel })
  if (!trashed.ok) return { ok: false, issues: trashed.issues, relPath: intoRel }
  return { ok: true, issues: [], relPath: intoRel, from: fromRel, mergedFields: Object.keys(merged) }
}

// —— 接口十：挪类型（F-14 的「挪」）。改「大类」「类型」两行，文件移到新目录，文件名不变。
// 新路径已存在时拒绝：挪过去盖掉另一张卡，等于一次删卡还没进回收站。
export function cardMove(root, { path: relPath, bucket, family } = {}) {
  const checked = cardRel(relPath)
  if (!checked.ok) return { ok: false, issues: [checked.error] }
  const rel = checked.rel
  const nextBucket = String(bucket ?? '').trim()
  const nextFamily = String(family ?? '').trim()
  if (!nextBucket) return { ok: false, issues: ['缺 --bucket：挪到哪个大类（故事零件、写作方法、作品案例、现实避坑）'] }
  if (!nextFamily) return { ok: false, issues: ['缺 --family：挪到哪个类型，如 S-03 剧情桥段'] }
  // 注册表只固定编号前缀，类型名可生长（细分开放）；但「编号 名字」的段式是注册表的一贯写法，缺名字会与注册表行对不上。
  const familyMatch = /^(S-\d{2})\s+(\S.*)$/.exec(nextFamily)
  if (!familyMatch) {
    return { ok: false, issues: [`--family 要写成注册表的段式「S-NN 类型名」，如 S-03 剧情桥段：${nextFamily}`] }
  }
  // 目录名只取类型名，不带编号：注册表的产卡路径是 素材库/<大类>/<类型名>/，编号是卡上「类型」那一行的前缀。
  const familyDir = familyMatch[2].trim()
  if (/[/\\]|\.\./.test(familyDir)) return { ok: false, issues: [`类型名不能含路径分隔符或 ..：${nextFamily}`] }
  if (isTrashed(rel)) return { ok: false, issues: [`${TRASH_DIR}/ 里的卡不参与挪类型：${rel}`] }
  if (!BUCKETS.includes(nextBucket)) return { ok: false, issues: [`大类「${nextBucket}」不合法，只能是：${BUCKETS.join('、')}`] }

  const file = join(root, rel)
  if (!existsSync(file)) return { ok: false, issues: [`卡不存在：${rel}`] }

  // 目录由「大类/类型名」派生，与注册表「产卡入 素材库/<大类>/<类型>/」同一口径。
  const nextRel = `${nextBucket}/${familyDir}/${basename(rel)}`
  if (nextRel === rel) {
    // 同一个位置：只把两行对齐，不假装挪过；已经对得上就一个字节都不写。
    const current = readCard(file).basic
    if (current.大类 === nextBucket && current.类型 === nextFamily) {
      return { ok: true, issues: [], relPath: rel, unchanged: true }
    }
    const aligned = writeCard(root, { basic: { 大类: nextBucket, 类型: nextFamily } }, rel)
    if (!aligned.ok) return { ok: false, issues: aligned.issues }
    return { ok: true, issues: [], relPath: rel, unchanged: true }
  }
  if (existsSync(join(root, nextRel))) return { ok: false, issues: [`新路径已存在，不覆盖：${nextRel}`] }
  // 搬之前先按新两行校验一遍：卡本身坏了就不该动它的位置，否则库校验会多出一条说不清的错。
  const before = readCard(file)
  const nextBasic = { ...before.basic, 大类: nextBucket, 类型: nextFamily }
  const issues = checkBasic(nextBasic)
  if (issues.length) return { ok: false, issues }

  // 先搬文件再写两行：写卡走 writeCard，它按盘上内容合并，落盘位置就是新路径。
  // 反过来先写后搬，一旦搬失败，卡上写着新大类而文件还在旧目录，最容易被误当成已挪好。
  moveFile(file, join(root, nextRel))
  const written = writeCard(root, { basic: { 大类: nextBucket, 类型: nextFamily } }, nextRel)
  if (!written.ok) return { ok: false, issues: written.issues, relPath: nextRel }
  // 新行由 writeCard 的 upsert 写进索引，旧路径那一行得单独删掉，否则索引里留着断链行。
  dropIndexRows(root, [rel])
  return { ok: true, issues: [], relPath: nextRel, from: rel }
}

// —— 卡管理的两个文件动作：移动（跨目录）与清索引行。
// 移动用 rename，跨盘（EXDEV）时退回「复制内容＋删原件」，两边都先建目录。
function moveFile(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    writeAtomic(to, readFileSync(from, 'utf8'))
    rmSync(from, { force: true })
  }
}

// 删索引行只删指定的，不重算全库：一张坏卡不该拦住一次删卡（与 rebuildIndex 的取舍一致）。
function dropIndexRows(root, rels) {
  const drop = new Set(rels)
  writeIndex(root, readIndex(root).filter((r) => !drop.has(r.相对路径)))
}

// —— 接口三：重建索引（F-09 / F-14 的前置）。索引本是派生视图，删了也能重算出来。
// 卡坏了不拦整次重建：好的照收，坏的单独报，免得一张坏卡让整个库失去可用的索引。
function rebuildIndex(root, { dryRun = false } = {}) {
  const rows = []
  const skipped = []
  for (const rel of listCards(root)) {
    const card = readCard(join(root, rel))
    const issues = checkBasic(card.basic)
    if (issues.length) {
      skipped.push({ rel, issues })
      continue
    }
    rows.push(indexRow(card, rel))
  }
  if (!dryRun) writeIndex(root, rows)
  return { rows, skipped, dryRun }
}

// —— 收编进度（F-22）：大文件夹分几次采时，把「采到哪了」记在库内，下次接着采。
// 为什么进度文件放库内（<库根>/.收编进度/<源指纹>.json）而不是 辅助内容/：
// 本技能的所有写入都受「不写库根之外」约束，进度丢到库外就绕过了那条线；
// 而且库被拷进写书项目时，进度跟着走才不会在另一台机器上从头再来。
// 为什么用「源指纹」命名而不是用户给的目录名：同一批素材从不同路径指过来
// （相对路径、绝对路径、软链）应当认成同一份进度，靠路径字符串做不到。
export const PROGRESS_DIR = '.收编进度'

// 源指纹：目录绝对路径的最后一段 + 文件清单的哈希。只看路径不够——同一个
// 路径下内容换了，进度就不该复用；只看内容也不够——两份内容相同的目录是两件活。
// 源指纹：来源目录的绝对路径的哈希，不含文件清单。
// 为什么不含文件清单：清单一变（用户删了一个文件、改了名）指纹就变，旧进度
// 立刻找不回来，整份素材得重采——而删文件恰恰是采集过程中最常发生的事。
// 只取路径也够区分：不同目录的绝对路径必然不同，同目录换个写法（尾斜杠、
// 相对路径）经 resolve 归一后一致。
// 代价是挪动或改名来源目录会丢进度；这比「删个文件就重采」少见，也更容易
// 向用户解释——而且 collect status 会报出找不到的文件，不会静默出错。
function sourceFingerprint(sourceDir) {
  const files = listSourceFiles(sourceDir)
  const abs = resolve(sourceDir)
  // 大小写归一：Windows 上 C:\a 与 c:\a 是同一个目录。
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12)
  return { fingerprint, files, abs }
}

// 待采清单：只收可读的文本文件。图片与音视频不在此处理（交回入口走多格式判定），
// 但**列进来是有意的**——否则用户会以为它们被静默漏掉了。
const TEXT_EXT = /\.(?:md|markdown|txt|text)$/i
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|mp3|wav|m4a|aac|flac|mp4|mov|avi|mkv|pdf|docx?|xlsx?|pptx?)$/i

function listSourceFiles(sourceDir) {
  const out = []
  const walk = (dir, depth) => {
    // 深目录很少见，深过 8 层多半是误指了一个根目录（比如整个用户目录）。
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // 隐藏目录一律跳过：.git、.收编进度 这类不是素材。
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) out.push(relative(sourceDir, full).split(sep).join('/'))
    }
  }
  walk(sourceDir, 0)
  return out.sort()
}

export function planCollection(sourceDir) {
  const checked = sourceFingerprint(sourceDir)
  const texts = checked.files.filter((f) => TEXT_EXT.test(f))
  const media = checked.files.filter((f) => MEDIA_EXT.test(f))
  const other = checked.files.filter((f) => !TEXT_EXT.test(f) && !MEDIA_EXT.test(f))
  return {
    fingerprint: checked.fingerprint,
    source: checked.abs,
    total: texts.length,
    texts,
    // 认不出扩展名的也归到这里，交给使用者判断，不替他们丢。
    others: [...media, ...other],
  }
}

function progressPath(root, fingerprint) {
  return join(root, PROGRESS_DIR, `${fingerprint}.json`)
}

export function readProgress(root, fingerprint) {
  const file = progressPath(root, fingerprint)
  if (!existsSync(file)) return { exists: false, done: [], source: '', updatedAt: '' }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return {
      exists: true,
      done: Array.isArray(data.done) ? data.done : [],
      source: data.source ?? '',
      updatedAt: data.updatedAt ?? '',
    }
  } catch {
    // 进度文件坏了不该让整件事卡死：当作没采过，重采一遍比报错更合算。
    return { exists: false, done: [], source: '', updatedAt: '', corrupt: true }
  }
}

function writeProgress(root, fingerprint, { done, source }) {
  const dir = join(root, PROGRESS_DIR)
  mkdirSync(dir, { recursive: true })
  const data = {
    fingerprint,
    source,
    done: [...new Set(done)].sort(),
    updatedAt: new Date().toISOString(),
  }
  writeAtomic(progressPath(root, fingerprint), `${JSON.stringify(data, null, 2)}\n`)
}

// 采集进度：把本批采完的相对路径并进进度文件。已采过的文件不会重采——
// 这正是 F-22 的「不重」；下次从 plan 里减去 done 就是「不漏」。
export function markProgress(root, { source, fingerprint, done } = {}) {
  if (!fingerprint) return { ok: false, issues: ['缺 --fingerprint：先用 collect plan 查出这批素材的指纹'] }
  if (!Array.isArray(done) || done.length === 0) return { ok: false, issues: ['缺 --done：本批采完了哪些文件（相对源目录的路径，逗号分隔）'] }
  const plan = planCollection(source)
  const names = new Set(plan.texts)
  const unknown = done.filter((d) => !names.has(d))
  if (unknown.length) {
    return { ok: false, issues: [`这些路径不在待采清单里：${unknown.join('、')}——进度只记可采的文本文件，别把图片或别的路径写进来`] }
  }
  const before = readProgress(root, fingerprint)
  const merged = [...before.done, ...done]
  writeProgress(root, fingerprint, { done: merged, source })
  const remaining = plan.texts.filter((t) => !merged.includes(t))
  return { ok: true, issues: [], done: [...new Set(merged)].sort(), remaining, total: plan.total }
}

function indexCard(root, rel) {
  if (!existsSync(join(root, rel))) return { ok: false, issues: [`卡不存在：${rel}`] }
  const card = readCard(join(root, rel))
  const issues = checkBasic(card.basic)
  if (issues.length) return { ok: false, issues }
  upsertIndex(root, indexRow(card, rel))
  return { ok: true, issues: [] }
}

// —— 查重（F-19）：先按大类、类型、细分、关键词四级收窄索引，命中才打开卡比对要点。
// 库上千张卡时整表翻一遍既慢又看不出「像不像」，收窄后再比对才有意义。
// 一个筛选项都不给时直接拒绝：那等于整表翻，而整表翻正是 F-19 要消掉的做法。
// 关键词比对索引里的「要点」与「卡名」两列，够用来判断「库里有没有这个对象」；
// 要判「内容是否重复」还得打开卡读正文，那一步交给调用方（流程文件里是采集流程第 4 步）。
const FIND_FILTERS = ['bucket', 'family', 'sub', 'keyword', 'object', 'fromWork']

function matchesText(haystack, needle) {
  return String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase())
}

// 大类与类型可以给多个值：「主角进诏狱」这类需求天然横跨历史细节、桥段、
// 意象、避雷（F-25），逼用户一个一个类型去查，等于把「一句话查多类型」推回给他。
// 把「甲,乙」拆成数组。全角逗号也认——中文输入法下很自然会打出「，」。
function splitValues(value) {
  if (value === undefined || value === null) return []
  return String(value)
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function findCards(root, { bucket, family, sub, keyword, object, fromWork } = {}) {
  const filters = { bucket, family, sub, keyword, object, fromWork }
  const buckets = splitValues(bucket)
  const families = splitValues(family)

  // 判「给没给筛选项」要看拆分后的结果，不能只看原字符串非空：
  // `--bucket " , "` 的 trim 结果非空，但拆完一个值都没有，那样会当成
  // 「给了大类筛」而实际上一个大类都没筛，结果就是整表翻——这正是要防的。
  const effective = FIND_FILTERS.filter((k) => {
    if (filters[k] === undefined) return false
    if (k === 'bucket') return buckets.length > 0
    if (k === 'family') return families.length > 0
    return String(filters[k]).trim() !== ''
  })
  if (effective.length === 0) {
    return {
      ok: false,
      // 选项名要用命令行写法（fromWork → --from-work），否则提示里给的参数拼不出来。
      issues: [`查重至少要给一个筛选项（${FIND_FILTERS.map((k) => `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`).join('、')}）：不给就成整表翻，库大了翻不动`],
      rows: [],
    }
  }
  const used = effective

  // 大类名与类型名先验：拼错时返回 0 行会被误读成「库里没有」，其实只是名字写错了。
  // 多值时逐个验，错误信息要指出是哪一个写错了。
  for (const b of buckets) {
    if (!BUCKETS.includes(b)) return { ok: false, issues: [`--bucket 只认四个大类：${BUCKETS.join('、')}；给的是「${b}」`], rows: [] }
  }

  // --object 与 --from-work 都得读卡：索引里既没有「对象标识」也没有「出自作品」列
  // （加进去会让老索引的行被 readIndex 静默跳过，代价太大）。故这两条筛法读卡。
  // 其余筛法仍只读索引；两者叠加时先按索引收窄，再读剩下的那几张卡。
  const key = objectKey(object)
  const work = objectKey(fromWork)
  if (key || work) {
    const rows = []
    for (const rel of listCards(root)) {
      const card = readCard(join(root, rel))
      // 两条「读卡」筛法各判各的，同时给就是「与」。
      // --from-work 用 objectKey 归一化：「幻界战线」「《幻界战线》」「幻界 战线」算同一部。
      if (key && objectKeyOf(card.basic) !== key) continue
      if (work && objectKey(card.basic.出自作品) !== work) continue
      // 其余筛选项也要满足：--bucket 故事零件 --object 五条悟 是两个条件的「与」。
      if (buckets.length && !buckets.includes(card.basic.大类)) continue
      if (families.length && !families.some((f) => matchesText(card.basic.类型, f))) continue
      if (sub && !matchesText(card.basic.细分, sub)) continue
      if (keyword && !(matchesText(card.basic.要点, keyword) || matchesText(card.basic.卡名, keyword))) continue
      rows.push({
        卡名: card.basic.卡名 ?? '',
        大类: card.basic.大类 ?? '',
        类型: card.basic.类型 ?? '',
        细分: card.basic.细分 ?? '',
        要点: card.basic.要点 ?? '',
        时效: card.basic.时效状态 ?? '',
        相对路径: rel,
        对象标识: card.basic.对象标识 ?? '',
        出自作品: card.basic.出自作品 ?? '',
      })
    }
    return { ok: true, issues: [], rows, narrowed: used, buckets, families, object: key, fromWork: work }
  }

  let rows = readIndex(root)
  // 逐级收窄：大类 → 类型 → 细分 → 关键词。每级都在上一级的结果里筛，不重读索引。
  // 大类与类型的多值是「或」的关系（命中任一个就算），同级内不叠加。
  if (buckets.length) rows = rows.filter((r) => buckets.includes(r.大类))
  if (families.length) rows = rows.filter((r) => families.some((f) => matchesText(r.类型, f)))
  if (sub) rows = rows.filter((r) => matchesText(r.细分, sub))
  if (keyword) rows = rows.filter((r) => matchesText(r.要点, keyword) || matchesText(r.卡名, keyword))

  return { ok: true, issues: [], rows, narrowed: used, buckets, families }
}

// —— 接口五：把老库升到当前格式（F-10）。跨多个版本一次做完。
// 只补不丢：机器补得出的字段补上，补不出的填「待补」并列进清单；
// 卡上已不在契约里的字段挪进「历史字段」行，不直接抹掉。
// 关键：内容没变就一个字节都不写。A-06 要求重跑升级后 mtime 与内容均不变，
// 无条件 writeAtomic 会让每次重跑都刷新 mtime，升级就不再幂等。
export function upgradeVault(root, { dryRun = false } = {}) {
  const meta = readVaultMeta(root)
  if (!meta.exists) return { ok: false, issues: ['缺 VAULT.md 身份证，无法判断从哪版升'], changed: [], pending: [] }
  const from = meta.version ?? 0
  const changed = []
  const pending = []

  for (const rel of listCards(root)) {
    const file = join(root, rel)
    const card = readCard(file)
    const before = readFileSync(file, 'utf8')

    const basic = { ...card.basic }
    const filled = []

    // 0.11.0 给三个字段改了名。这一步必须在「补必填」与「退役字段」之前：
    // 否则旧名会被当成「契约里已没有的字段」挪进「历史字段」——值还在，
    // 但它不再是真字段，卡上所有必填校验都会说缺。
    for (const [旧名, 新名] of Object.entries(RENAMED_FIELDS)) {
      if (basic[旧名] === undefined) continue
      if (basic[新名] === undefined) basic[新名] = basic[旧名]
      delete basic[旧名]
      filled.push(`${旧名}→${新名}`)
    }
    for (const f of FIELDS) {
      if (basic[f.名] !== undefined && basic[f.名] !== '') continue
      if (f.名 === '私有') {
        // 私有有默认值可算，不必记「待补」。
        basic.私有 = defaultPrivate(basic.类型)
        filled.push(`私有=${basic.私有}`)
      } else if (f.必填) {
        // 必填但机器猜不出来的，填「待补」并让用户知道要回来补什么。
        basic[f.名] = '待补'
        filled.push(`${f.名}=待补`)
        pending.push({ rel, field: f.名 })
      }
    }

    // 契约里已没有的字段挪进「历史字段」，值留着：删字段不等于删数据。
    const known = new Set(FIELD_NAMES)
    const retired = Object.keys(basic).filter((k) => !known.has(k) && k !== '历史字段')
    if (retired.length) {
      const old = retired.map((k) => `${k}=${basic[k]}`).join('，')
      basic.历史字段 = basic.历史字段 ? `${basic.历史字段}，${old}` : old
      for (const k of retired) delete basic[k]
      filled.push(`历史字段+${retired.join('、')}`)
    }

    if (filled.length === 0) continue

    const next = { basic, dimension: card.dimension, body: card.body }
    const after = renderCard(next)
    // 内容相同就不写：字段可能被补成它本来就等价的空值，那种情况不该刷新 mtime。
    if (after === before) continue

    changed.push({ rel, filled })
    if (!dryRun) {
      writeAtomic(file, after)
      upsertIndex(root, indexRow(next, rel))
    }
  }

  const needVersion = from !== SCHEMA_VERSION
  if (!dryRun && (changed.length || needVersion)) {
    writeAtomic(join(root, 'VAULT.md'), renderMeta(meta.intro ?? '灵感素材库'))
    if (changed.length) rebuildIndex(root)
  }
  return { ok: pending.length === 0, from, to: SCHEMA_VERSION, changed, pending, dryRun, needVersion }
}

// 身份证正文只有两行有用信息，重构一份比字符串替换稳。
function renderMeta(intro) {
  return `# 素材库身份证\n\n版本：${SCHEMA_VERSION}\n简介：${intro}\n`
}

// —— 库定位（F-06）：给了 --vault 直用；否则从当前目录逐级向上找含 VAULT.md 的目录；
// 都没有则回报「未找到」，不自动建库——建库是 init 的事，定位只管找。
export function detectVault({ vault, cwd = process.cwd() } = {}) {
  if (vault) return { kind: '指定', root: vault }
  let dir = cwd
  for (;;) {
    if (existsSync(join(dir, 'VAULT.md'))) return { kind: '就近', root: dir }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return { kind: '未找到', root: null }
}

// —— 建库（F-09）：一次写齐身份证、索引表头与四个大类目录。
export function initVault(root, { intro = '灵感素材库' } = {}) {
  if (existsSync(join(root, 'VAULT.md'))) {
    return { ok: false, issues: [`该目录已是素材库（已有 VAULT.md）：${root}`] }
  }
  writeAtomic(join(root, 'VAULT.md'), `# 素材库身份证\n\n版本：${SCHEMA_VERSION}\n简介：${intro}\n`)
  writeAtomic(join(root, 'INDEX.md'), renderIndex([]))
  for (const bucket of BUCKETS) mkdirSync(join(root, bucket), { recursive: true })
  return { ok: true, issues: [] }
}

// —— CLI。io 由调用方给，返回退出码而不杀进程：测试可直接调它拿输出与码，不必起子进程。
// 退出码：0 成功、1 业务失败、2 参数错误、3 环境缺失（与 docs/技术/技术文档.md 一致）。
const USAGE = `用法：node scripts/vault.mjs <子命令> [选项]

子命令
  detect            找当前该用哪个库（F-06）
  init              建库：写身份证、索引表头与四个大类目录（F-09）
  check             校验库：身份证、索引、卡三方对账（逐列比）
  index rebuild     从卡重算整个索引；坏卡跳过并单独报
  upgrade           把老库升到当前格式：补缺失字段，已删字段挪进「历史字段」
  index add         只把一张卡补进索引，不重扫全库
  write             按 JSON 写一张卡，顺带修好索引
  card edit         改卡上的一行，索引同步（大类与类型改用 card move）
  card delete       把卡移进 已删卡片/，并存原相对路径，可从那里找回
  card restore      把 已删卡片/ 里的卡移回原路径并补回索引；原位置被占则拒绝
  card merge        把 --from 的补充记录与关联卡并进 --into，原卡进 已删卡片/
  card move         改大类与类型两行并移到新目录；新路径已存在则拒绝
  find              查重：按大类、类型、细分、关键词收窄索引，命中才比对（F-19）
  collect plan      清点来源目录：列出可采的文本文件与不采的其他文件，给源指纹（F-22）
  collect mark      把本批采完的文件记进进度，并报还剩多少（F-22）
  collect status    查这份素材采到哪了、还剩哪些（F-22）
  retire            列出建议退休的卡：超期未用、未补过料（F-20）；只列不删
  used              给卡记一笔用在哪个作品第几章（F-21）
  review            列出该复审的卡：热梗 3 个月、时事 6 个月、其余时效敏感 12 个月（F-23）
  overview          库况：各类型卡数、最近收卡、待补与待复审数量（F-28）
  project           项目视图：列出某本书用过的卡（F-26）
  pack              把选中的卡打包成一份引用文件，私有卡一律不进（F-27）
  add               补卡不建新卡：已有就跳过或补进旧卡，没有才建（F-30）
  dupes             查全库同对象双卡，只列不改（F-30）
  cardpoints        按 references/触发卡点表.md 对照本库：每条卡点有几张卡、缺口是哪几条

选项
  --vault <路径>    库根；不给则按 detect 的三层判定
  --intro <一行>    init 时写进身份证的简介
  --card <路径>     write 与 add 的卡内容 JSON 文件，- 表示从标准输入读
  --path <相对路径> index add 要补进索引的卡；card 动作要操作的卡
  --field <字段名>  card edit 要改的行名，如 要点
  --value <新值>    card edit 改成什么
  --section <节名>  card edit 改哪一节：基本信息（默认）、类型维度、正文
  --from <相对路径> card merge 被并入的卡
  --into <相对路径> card merge 的目标卡
  --bucket <大类>     card move 挪到哪个大类；find 按大类收窄（可逗号分隔多个，如 故事零件,写作方法）
  --family <类型> card move 挪到哪个类型；find 按类型收窄（可逗号分隔多个，如 S-02,S-03）
  --sub <细分>      find 按细分收窄（含即命中）
  --keyword <文本>  find 按关键词收窄，比对卡名与要点（含即命中）
  --object <对象名> find 按对象标识收窄：认得出「同一对象」的卡（F-30），如 --object 五条悟
  --from-work <作品名> find 按「出自作品」收窄：一部作品的卡分散在多个类型，用这条一次全取（F-32），如 --from-work 幻界战线
  --source <目录>   collect 的素材来源目录
  --fingerprint <值> collect mark 的源指纹，由 collect plan 给出
  --done <路径列表> collect mark 本批采完了哪些（相对源目录，逗号分隔）
  --paths <路径列表> pack 打哪些卡（相对路径，逗号分隔）
  --out <文件路径>  pack 写到哪，默认当前目录 引用包-YYYY-MM-DD.md
  --thin <张数>     overview 的偏薄线，默认 5
  --months <月数>   retire 的闲置线，默认 12
  --work <书名>     used 用在哪个作品；project 看哪本书用过的卡
  --chapter <章>    used 第几章
  --dry-run         index rebuild 与 upgrade 只报清单，不落盘
  --json            输出单个 JSON 对象
  --help, -h        显示本说明`

// 参数一律长名，短名只留 -h：短名一多，隔几个月就没人记得住哪个字母是什么。
const FLAGS_WITH_VALUE = new Set(['--vault', '--intro', '--card', '--path', '--field', '--value', '--section', '--from', '--into', '--bucket', '--family', '--sub', '--keyword', '--source', '--fingerprint', '--done', '--months', '--work', '--chapter', '--thin', '--paths', '--out', '--object', '--from-work'])
const KNOWN_COMMANDS = new Set(['detect', 'init', 'check', 'write', 'index', 'upgrade', 'card', 'find', 'collect', 'retire', 'used', 'review', 'overview', 'project', 'pack', 'add', 'dupes', 'cardpoints'])
// 每个 card 动作的必填参数，形如 [选项名, 用法里的写法]。缺参数是参数错误（2），
// 不该等撞上「未找到库」或「卡不存在」才报——那样调用方无从区分自己拼错了什么。
export const CARD_ACTION_FLAGS = {
  edit: [['path', '--path <卡的相对路径>'], ['field', '--field <字段名>'], ['value', '--value <新值>']],
  delete: [['path', '--path <卡的相对路径>']],
  restore: [['path', '--path <卡的相对路径>']],
  merge: [['from', '--from <被并入的卡>'], ['into', '--into <目标卡>']],
  move: [['path', '--path <卡的相对路径>'], ['bucket', '--bucket <大类>'], ['family', '--family <类型>']],
}

export function parseCliArgs(argv) {
  const options = { cmd: '', action: '', json: false, help: false, dryRun: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值。\n${USAGE}`)
      options[arg.slice(2)] = value
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`未知参数 ${arg}。\n${USAGE}`)
    else positional.push(arg)
  }
  // 子命令最多两段（index rebuild）：第一段是命令，第二段是它的动作。
  if (positional.length > 2) throw new Error(`多余的参数 ${positional.slice(2).join(' ')}。\n${USAGE}`)
  options.cmd = positional[0] ?? ''
  options.action = positional[1] ?? ''
  return options
}

export function runCli(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`))
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`))
  const cwd = io.cwd ?? process.cwd()
  // --json 要在解析失败时也认得出，故先从裸 argv 里探一次。
  const wantsJson = argv.includes('--json')
  const emit = (payload, text) => (wantsJson ? out(JSON.stringify(payload, null, 2)) : out(text))

  let options
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    emit({ ok: false, error: error.message, data: {} }, error.message)
    return 2
  }
  if (options.help || !options.cmd) {
    out(USAGE)
    return options.help ? 0 : 2
  }

  // 子命令名先验，再碰任何库状态：否则未知子命令会先撞上「未找到库」，
  // 把参数错误（2）报成业务失败（1），调用方无从区分自己拼错了命令。
  if (!KNOWN_COMMANDS.has(options.cmd)) {
    err(`未知子命令 ${options.cmd}。\n${USAGE}`)
    return 2
  }

  // collect 的动作名同样先验：action 拼错时，plan 与 mark 两条分支都不进，
  // 会一路走到「未找到库」或静默成功，两种都不好查。
  if (options.cmd === 'collect' && !['plan', 'mark', 'status'].includes(options.action)) {
    const message = `collect 需要动作：plan（清点来源）、mark（记进度）或 status（看还剩多少）；给的是「${options.action}」`
    emit({ ok: false, error: message, data: { action: options.action } }, message)
    return 2
  }

  // card 的动作名与必填参数也在碰库之前验完：没给库的机器上，
  // 「card 缺 --path」该报参数错误（2），不该先报「未找到库」（1）。
  if (options.cmd === 'card') {
    const required = CARD_ACTION_FLAGS[options.action]
    if (!required) {
      const message = `card 需要动作：${Object.keys(CARD_ACTION_FLAGS).join('、')}。\n${USAGE}`
      emit({ ok: false, error: message, data: { action: options.action } }, message)
      return 2
    }
    // --value 允许空串（清空可选字段如「出处链接」），其余参数空串与缺省同罚。
    const missing = required.filter(([key]) => options[key] === undefined || (key !== 'value' && options[key] === ''))
    if (missing.length) {
      const message = `card ${options.action} 需要 ${missing.map(([, flag]) => flag).join('、')}。\n${USAGE}`
      emit({ ok: false, error: message, data: { action: options.action } }, message)
      return 2
    }
  }

  const resolved = detectVault({ vault: options.vault, cwd })

  if (options.cmd === 'detect') {
    if (resolved.kind === '未找到') {
      emit({ ok: false, error: '未找到库', data: { kind: '未找到' } }, '未找到库：当前目录及其上级都没有 VAULT.md，可用 init 新建')
      return 1
    }
    emit({ ok: true, data: { kind: resolved.kind, root: resolved.root } }, `${resolved.kind}：${resolved.root}`)
    return 0
  }

  if (options.cmd === 'init') {
    const root = options.vault ?? resolved.root ?? join(cwd, '素材库')
    const result = initVault(root, { intro: options.intro })
    if (!result.ok) {
      emit({ ok: false, error: result.issues.join('；'), data: { root } }, result.issues.join('\n'))
      return 1
    }
    emit({ ok: true, data: { root } }, `已建库：${root}`)
    return 0
  }

  // collect plan 只读来源目录、不碰库，故放在「未找到库」拦截之前：
  // 先清点再建库是正常顺序，不该因为库还没建就报「未找到库」。
  if (options.cmd === 'collect' && options.action === 'plan') {
    if (!options.source) {
      emit({ ok: false, error: 'collect plan 需要 --source <目录>', data: {} }, 'collect plan 需要 --source <目录>')
      return 2
    }
    if (!existsSync(options.source) || !statSync(options.source).isDirectory()) {
      emit({ ok: false, error: `来源目录不存在或不是目录：${options.source}`, data: {} }, `来源目录不存在或不是目录：${options.source}`)
      return 1
    }
    const plan = planCollection(options.source)
    const head = `共 ${plan.total} 个可采的文本文件${plan.others.length ? `，另有 ${plan.others.length} 个不采（图片、音视频、认不出类型）` : ''}｜源指纹 ${plan.fingerprint}`
    const list = plan.texts.slice(0, 20).map((f, i) => `${i + 1}. ${f}`).join('\n')
    const more = plan.total > 20 ? `\n… 还有 ${plan.total - 20} 个未列出` : ''
    const others = plan.others.length ? `\n\n不采的文件（要收请先转成文字）：\n${plan.others.map((f) => `- ${f}`).join('\n')}` : ''
    emit(
      { ok: true, errors: [], data: { fingerprint: plan.fingerprint, total: plan.total, texts: plan.texts, others: plan.others } },
      [head, list].filter(Boolean).join('\n') + more + others,
    )
    return 0
  }

  if (resolved.kind === '未找到') {
    emit({ ok: false, error: '未找到库', data: {} }, '未找到库：当前目录及其上级都没有 VAULT.md，可用 init 新建或加 --vault 指定')
    return 1
  }
  const root = resolved.root

  if (options.cmd === 'index') {
    if (options.action === 'rebuild') {
      const { rows, skipped, dryRun } = rebuildIndex(root, { dryRun: options.dryRun })
      const skippedText = skipped.length
        ? `\n跳过 ${skipped.length} 张坏卡（未入索引，请先修）：\n${skipped.map((s) => `- ${s.rel}：${s.issues.join('；')}`).join('\n')}`
        : ''
      const verb = dryRun ? '将重建' : '已重建'
      emit(
        { ok: skipped.length === 0, errors: skipped.map((s) => ({ file: s.rel, message: s.issues.join('；') })), data: { root, cards: rows.length, dryRun } },
        `${verb}索引，${rows.length} 行${skippedText}`,
      )
      // 有坏卡时退出码 1：索引虽已重建，但库还不是干净的，不能让它悄悄过去。
      return skipped.length ? 1 : 0
    }
    if (options.action === 'add') {
      // 用 --path 而不是 --card：write 的 --card 指 JSON 文件，这里指卡的相对路径，
      // 同名不同义会让调用方写错，宁可变一个名字。
      if (!options.path) {
        err(`index add 需要 --path <卡的相对路径>。\n${USAGE}`)
        return 2
      }
      const result = indexCard(root, options.path)
      if (!result.ok) {
        emit({ ok: false, errors: result.issues.map((m) => ({ message: m })), data: {} }, `未补进索引：\n${result.issues.map((i) => `- ${i}`).join('\n')}`)
        return 1
      }
      emit({ ok: true, errors: [], data: { relPath: options.path } }, `已补进索引：${options.path}`)
      return 0
    }
    err(`index 需要动作：rebuild 或 add。\n${USAGE}`)
    return 2
  }

  if (options.cmd === 'upgrade') {
    const result = upgradeVault(root, { dryRun: options.dryRun })
    if (result.issues?.length) {
      emit({ ok: false, errors: result.issues.map((m) => ({ message: m })), data: {} }, result.issues.join('\n'))
      return 1
    }
    const head = result.dryRun
      ? `将升级 ${result.changed.length} 张卡（版本 ${result.from} → ${result.to}），未落盘`
      : result.changed.length
        ? `已升级 ${result.changed.length} 张卡（版本 ${result.from} → ${result.to}）`
        : `没有要升级的卡（版本 ${result.from}）`
    const list = result.changed.map((c) => `- ${c.rel}：${c.filled.join('；')}`).join('\n')
    const pending = result.pending.length
      ? `\n\n以下字段机器补不出，已填「待补」，请回来补：\n${result.pending.map((p) => `- ${p.rel}：${p.field}`).join('\n')}`
      : ''
    emit(
      { ok: result.pending.length === 0, errors: result.pending.map((p) => ({ file: p.rel, message: `${p.field}=待补` })), data: { from: result.from, to: result.to, changed: result.changed.length, dryRun: result.dryRun } },
      [head, list].filter(Boolean).join('\n') + pending,
    )
    // 有待补字段时退出码 1：升级完成了，但库还没干净，不能让调用方以为全好了。
    return result.pending.length ? 1 : 0
  }

  if (options.cmd === 'collect' && options.action === 'mark') {
    if (!options.source) {
      emit({ ok: false, error: 'collect mark 需要 --source <目录>', data: {} }, 'collect mark 需要 --source <目录>')
      return 2
    }
    if (!existsSync(options.source) || !statSync(options.source).isDirectory()) {
      emit({ ok: false, error: `来源目录不存在或不是目录：${options.source}`, data: {} }, `来源目录不存在或不是目录：${options.source}`)
      return 1
    }
    // --done 传进来的是逗号分隔的相对路径。空串视为参数错误：
    // 「这批一个都没采」不该被记成一次进度，那会把剩余数算错。
    const done = String(options.done ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const result = markProgress(root, { source: options.source, fingerprint: options.fingerprint, done })
    if (!result.ok) {
      emit({ ok: false, error: result.issues.join('；'), data: {} }, result.issues.join('\n'))
      return 2
    }
    const head = `已记 ${result.done.length}／${result.total}，剩 ${result.remaining.length} 个待采`
    const next = result.remaining.length
      ? `\n下次从这些接着采：\n${result.remaining.slice(0, 10).map((f) => `- ${f}`).join('\n')}${result.remaining.length > 10 ? `\n… 还有 ${result.remaining.length - 10} 个` : ''}`
      : '\n全部采完了，跑一次 check 复核库。'
    emit({ ok: true, errors: [], data: { done: result.done.length, remaining: result.remaining, total: result.total } }, head + next)
    return 0
  }

  if (options.cmd === 'collect' && options.action === 'status') {
    if (!options.source) {
      emit({ ok: false, error: 'collect status 需要 --source <目录>', data: {} }, 'collect status 需要 --source <目录>')
      return 2
    }
    if (!existsSync(options.source) || !statSync(options.source).isDirectory()) {
      emit({ ok: false, error: `来源目录不存在或不是目录：${options.source}`, data: {} }, `来源目录不存在或不是目录：${options.source}`)
      return 1
    }
    const plan = planCollection(options.source)
    const prog = readProgress(root, plan.fingerprint)
    if (!prog.exists) {
      // 没进度不是错误，是「这份素材没采过」。返回 0 但 ok:false 会让调用方
      // 不好分辨，故用退出码 1 + 一句明确的「没采过」，与「查到了」区分开。
      const message = `这份素材还没采过（共 ${plan.total} 个待采文件，源指纹 ${plan.fingerprint}）`
      emit({ ok: false, error: message, data: { fingerprint: plan.fingerprint, total: plan.total, started: false } }, message)
      return 1
    }
    const remaining = plan.texts.filter((f) => !prog.done.includes(f))
    // 进度里记的文件若已不在来源目录（被删或改名），要点出来，否则剩余数会对不上。
    const vanished = prog.done.filter((f) => !plan.texts.includes(f))
    const head = `已记 ${prog.done.length}／${plan.total}，剩 ${remaining.length} 个${prog.updatedAt ? `（上次更新 ${prog.updatedAt.slice(0, 10)}）` : ''}`
    const list = remaining.length ? `\n待采：\n${remaining.slice(0, 20).map((f) => `- ${f}`).join('\n')}${remaining.length > 20 ? `\n… 还有 ${remaining.length - 20} 个` : ''}` : '\n全部采完了。'
    const gone = vanished.length ? `\n\n注意：进度里记着 ${vanished.length} 个文件，但来源目录里已找不到（被删或改名）：\n${vanished.map((f) => `- ${f}`).join('\n')}` : ''
    emit(
      { ok: true, errors: [], data: { fingerprint: plan.fingerprint, total: plan.total, started: true, done: prog.done, remaining, vanished } },
      head + list + gone,
    )
    return 0
  }

  if (options.cmd === 'dupes') {
    const dp = dupesReport(root)
    if (dp.rows.length === 0) {
      // 没有双卡是正常结论，退 0。
      emit({ ok: true, errors: [], data: { groups: 0, total: 0, rows: [] } }, '没有同对象双卡：每个类型里同一个对象都只有一张卡。')
      return 0
    }
    const out = []
    out.push('发现 ' + dp.rows.length + ' 组同对象双卡，共 ' + dp.total + ' 张（只列不改，删不删由你逐步确认）')
    out.push('')
    for (const g of dp.rows) {
      out.push('【' + g.类型 + '】' + g.卡数 + ' 张')
      for (const c of g.卡) out.push('- ' + c.卡名 + '（收于 ' + c.采集日期 + '）' + c.相对路径)
      out.push('  建议留下：' + g.建议留下)
      out.push('  合并命令：card merge --from <多余的> --into ' + g.建议留下)
      out.push('')
    }
    out.push('合并只搬「补充记录」与「关联卡」，原卡进 已删卡片/ 可找回。')
    out.push('两张卡的内容不一样时，先逐张看过再决定并哪张——机器只按采集日期判，判不出哪张写得更好。')
    emit({ ok: true, errors: [], data: { groups: dp.rows.length, total: dp.total, rows: dp.rows } }, out.join('\n'))
    return 0
  }

  if (options.cmd === 'add') {
    if (!options.card) {
      emit({ ok: false, error: '缺 --card：本次要记的卡内容（JSON 文件）', data: {} }, '缺 --card：本次要记的卡内容（JSON 文件）')
      return 2
    }
    const ad = addMaterial(root, { card: options.card })
    if (!ad.ok) {
      emit({ ok: false, error: ad.issues.join('；'), data: { action: ad.action } }, ad.issues.join('\n'))
      // 参数问题（缺 --card、读不了文件、JSON 不合法、认不出对象）退 2；
      // 卡内容本身不合格（如缺必填字段）是业务失败，退 1——与 write 一致。
      // 原先一律退 2：同一份坏卡，add 说「参数错」、write 说「业务失败」，
      // 两条命令对同一个事实给两个退出码，调用方无法统一判断。
      return ad.code === 'E_ARGS' ? 2 : 1
    }
    // 三种结果都不是失败，但要说清是哪一种——用户得知道卡有没有多出来。
    const out = []
    if (ad.action === 'created') {
      out.push('库里还没有这个对象，已建新卡：' + ad.relPath)
    } else if (ad.action === 'skipped') {
      out.push('已有这张卡，本次没建新卡：' + ad.relPath)
      out.push('（' + ad.reason + '）')
    } else {
      out.push('已有这张卡，新内容补进去了：' + ad.relPath)
      out.push('补充记录：' + ad.entry)
    }
    if (ad.duplicates && ad.duplicates.length > 1) {
      out.push('')
      out.push('注意：这个类型里已经有 ' + ad.duplicates.length + ' 张同对象的卡，本次只动第一张：')
      for (const d of ad.duplicates) out.push('- ' + d)
      out.push('合并它们：card merge --from <多余的那张> --into <要留下的那张>')
    }
    if (ad.relatedElsewhere && ad.relatedElsewhere.length) {
      // 跨类型各自成卡（F-30），但两张卡得互指，否则同一个对象在库里散成互不相识的几张。
      out.push('')
      out.push('这个对象在别的类型里已有卡（跨类型不算重复）：')
      for (const e of ad.relatedElsewhere) out.push('- ' + e.类型 + '：' + e.rel)
      if (ad.linked && ad.linked.length) {
        out.push('已把两边的路径写进各自的「关联卡」行，写书时问这个对象能一次拿全。')
      } else {
        // 写关联卡失败不该让建卡失败，但也不能装作写成功了。
        out.push('「关联卡」没写成功，请手动把路径填进两张卡，否则从任一张都查不到另一张。')
      }
    }
    emit(
      { ok: true, errors: [], data: { action: ad.action, relPath: ad.relPath, 卡名: ad.卡名, entry: ad.entry, duplicates: ad.duplicates ?? [], relatedElsewhere: ad.relatedElsewhere ?? [], linked: ad.linked ?? [] } },
      out.join('\n'),
    )
    return 0
  }

  if (options.cmd === 'pack') {
    const pk = packCards(root, { paths: options.paths, work: options.work })
    if (!pk.ok) {
      emit({ ok: false, error: pk.issues.join('；'), data: { excluded: pk.excluded } }, pk.issues.join('\n'))
      return 2
    }
    // 输出目录取当前工作目录：引用包是消耗品，不该写进库（见 packCards 的注释）。
    // 用 runCli 里的局部 cwd（第 1170 行算出），不是 options.cwd——后者根本不存在。
    const target = options.out ? resolve(cwd, options.out) : join(cwd, `引用包-${pk.stamp}.md`)
    writeFileSync(target, pk.content, 'utf8')
    const out = []
    out.push(`已打包 ${pk.cards.length} 张卡 → ${target}`)
    if (pk.excluded.length) {
      // 被排除的卡必须报出来：不说的话用户会以为引用包是完整的。
      out.push('')
      out.push(`另有 ${pk.excluded.length} 张没进包（私有卡不外流，F-17）：`)
      for (const e of pk.excluded) out.push(`- ${e.卡名}：${e.原因}`)
    }
    emit(
      { ok: true, errors: [], data: { out: target, count: pk.cards.length, included: pk.cards.map((c) => c.rel), excluded: pk.excluded } },
      out.join('\n'),
    )
    return 0
  }

  if (options.cmd === 'project') {
    const pv = projectView(root, { work: options.work })
    if (!pv.ok) {
      emit({ ok: false, error: pv.issues.join('；'), data: {} }, pv.issues.join('\n'))
      return 2
    }
    if (pv.rows.length === 0) {
      // 空清单是正常结论：这本书还没用过任何卡。退出 0，不是失败。
      emit(
        { ok: true, errors: [], data: { work: pv.work, count: 0, rows: [], byBucket: [] } },
        '《' + pv.work + '》还没用过任何卡。\n\n要让一本书用上卡，采集或检索时用 used 记一笔：\n  node scripts/vault.mjs used --path <相对路径> --work ' + pv.work + ' --chapter <章>',
      )
      return 0
    }
    const out = []
    out.push('《' + pv.work + '》用过 ' + pv.rows.length + ' 张卡（按大类：' + pv.byBucket.map((b) => b.大类 + ' ' + b.卡数).join('，') + '）')
    out.push('')
    for (const r of pv.rows) {
      out.push('- ' + r.卡名)
      out.push('  ' + r.类型 + ' / ' + r.细分 + '；' + r.用在哪)
      out.push('  要点：' + r.要点)
      out.push('  ' + r.相对路径)
    }
    emit({ ok: true, errors: [], data: { work: pv.work, count: pv.rows.length, rows: pv.rows, byBucket: pv.byBucket } }, out.join('\n'))
    return 0
  }

  if (options.cmd === 'overview') {
    const o = vaultOverview(root, { thin: options.thin })
    if (o.total === 0) {
      emit({ ok: true, errors: [], data: o }, '库是空的，还没有任何卡。先按 01 采集一张，或按 07 收编一个文件夹。')
      return 0
    }
    const out = []
    out.push('共 ' + o.total + ' 张卡' + (o.latest ? '，最近收卡 ' + o.latest : ''))
    out.push('')
    out.push('按大类：' + o.byBucket.map((b) => b.大类 + ' ' + b.卡数).join('，'))
    out.push('')
    out.push('按类型：')
    for (const f of o.byFamily) out.push('- ' + f.类型 + '：' + f.卡数 + ' 张')
    out.push('')
    // 待补与待复审分开报：前者要回来补字段，后者要回去核内容，两件事。
    out.push('待补 ' + o.pending.length + ' 处（升级时机器补不出、填了「待补」的字段）')
    if (o.pending.length) {
      out.push(o.pending.slice(0, 10).map((p) => '- ' + p.卡名 + ' 的「' + p.field + '」\n  ' + p.相对路径).join('\n'))
      if (o.pending.length > 10) out.push('- 另有 ' + (o.pending.length - 10) + ' 处，跑 review 可看全部')
    }
    out.push('')
    out.push('待复审 ' + o.review + ' 张（跑 review 看清单）')
    if (o.thinFamilies.length) {
      out.push('')
      out.push('偏薄的类型（少于 ' + o.thin + ' 张，可以的话收一点）：')
      for (const f of o.thinFamilies) out.push('- ' + f.类型 + '：' + f.卡数 + ' 张')
    }
    emit({ ok: true, errors: [], data: o }, out.join('\n'))
    return 0
  }

  if (options.cmd === 'review') {
    const re = reviewSuggest(root)
    const links = linkChecks(root)
    const parts = []
    if (re.rows.length === 0) {
      parts.push('没有超期未复审的卡（周期：热梗 ' + re.cycles.网络热梗 + ' 个月、时事 ' + re.cycles.时事热点 + ' 个月、其余时效敏感 ' + re.cycles.默认 + ' 个月）')
    } else {
      parts.push('该复审 ' + re.rows.length + ' 张（热梗 ' + re.cycles.网络热梗 + ' 个月、时事 ' + re.cycles.时事热点 + ' 个月、其余时效敏感 ' + re.cycles.默认 + ' 个月）')
      parts.push(re.rows.map((r) => '- ' + r.卡名 + '\n  ' + r.分档 + '；时效「' + r.时效状态 + '」，采集于 ' + r.采集日期 + '，超期 ' + r.超期月数 + ' 个月\n  ' + r.相对路径).join('\n'))
    }
    if (links.rows.length) {
      parts.push('')
      // 不说「失效」：本技能离线可用、零依赖，没去探测过任何链接，不能声称验证了。
      parts.push('另 ' + links.rows.length + ' 张带出处链接的卡已超过 ' + links.months + ' 个月未核对，链接还能不能打开得你自己点一下：')
      parts.push(links.rows.map((r) => '- ' + r.卡名 + '（' + r.采集日期 + '）\n  ' + r.出处链接).join('\n'))
    }
    // 没有该复审的卡时不必解释复审怎么做——那句话只在真有清单时才有用。
    if (re.rows.length > 0) {
      parts.push('')
      parts.push('复审的意思是：看一眼内容还准不准，把「时效状态」改成现状（现行／已过时／待观察），要改的按 04 走 card edit。')
    }
    emit(
      { ok: true, errors: [], data: { cycles: re.cycles, overdue: re.rows, links: links.rows } },
      parts.join('\n').replace(/\n\n\n/g, '\n\n'),
    )
    return 0
  }

  if (options.cmd === 'retire') {
    const result = retireSuggest(root, { months: options.months })
    if (result.rows.length === 0) {
      // 空清单是正常结论，退出 0：没有该退休的卡不是失败。
      emit(
        { ok: true, errors: [], data: { limit: result.limit, count: 0, rows: [] } },
        '没有建议退休的卡（判据：采集日期超过 ' + result.limit + ' 个月，且「已用在」与「补充记录」都为空）',
      )
      return 0
    }
    const head = '建议退休 ' + result.rows.length + ' 张（判据：采集超过 ' + result.limit + ' 个月，且「已用在」与「补充记录」都为空）'
    const list = result.rows
      .map((r) => '- ' + r.卡名 + '\n  ' + r.类型 + '；采集于 ' + r.采集日期 + '，闲置 ' + r.闲置月数 + ' 个月\n  ' + r.相对路径)
      .join('\n')
    const tail = '\n\n这只是建议，删不删你定：要删用 card delete --path <相对路径>，要留就不必动它。'
    emit(
      { ok: true, errors: [], data: { limit: result.limit, count: result.rows.length, rows: result.rows } },
      head + '\n' + list + tail,
    )
    return 0
  }

  if (options.cmd === 'used') {
    const result = markUsed(root, { path: options.path, work: options.work, chapter: options.chapter })
    if (!result.ok) {
      emit({ ok: false, error: result.issues.join('；'), data: {} }, result.issues.join('\n'))
      return 2
    }
    const msg = result.added
      ? '已记：' + result.entry + '\n卡的「已用在」现在是：' + result.usedIn
      : '这一处已经记过了：' + result.entry + '\n卡的「已用在」：' + result.usedIn
    emit(
      { ok: true, errors: [], data: { relPath: result.relPath, added: result.added, entry: result.entry, usedIn: result.usedIn } },
      msg,
    )
    return 0
  }

  if (options.cmd === 'find') {
    const result = findCards(root, { bucket: options.bucket, family: options.family, sub: options.sub, keyword: options.keyword, object: options.object, fromWork: options['from-work'] })
    if (!result.ok) {
      emit({ ok: false, error: result.issues.join('；'), data: {} }, result.issues.join('\n'))
      return 2
    }
    // 多类型命中时按类型分组：平铺成一长串看不出「哪一个类型有料、哪一个类型空着」，
    // 而后者正是「一句话查多类型」要回答的东西。只查一类型时分组表头是噪音，退回归。
    // 判据用「给了多个类型」而不是「结果里有多个类型」：只给一个大类时结果里本来就
    // 会有好几个类型，那时分组只是把本来清楚的东西再切碎一遍。
    const multiFamily = (result.families ?? []).length > 1
    const byFamily = new Map()
    for (const r of result.rows) {
      const key = `${r.大类} / ${r.类型}`
      if (!byFamily.has(key)) byFamily.set(key, [])
      byFamily.get(key).push(r)
    }
    const head = result.rows.length
      ? `命中 ${result.rows.length} 张（收窄条件：${result.narrowed.join('、')}）`
      : `没有命中（收窄条件：${result.narrowed.join('、')}）——库里可能确实没有，也可能筛得太窄，可放宽再试`
    // 请求了但没有卡的类型，也要报出来。
    //
    // find 收到了类型名，所以它知道哪个类型问过、哪个是空的；而「空着的那类型要如实
    // 说没查到」原先只能靠调用方自己记住问过哪些类型。记账责任放在这边更稳——
    // 调用方漏记一次，读的人就会以为「压根没查这个类型」，而且没有任何提示。
    const emptyFamilies = multiFamily
      ? (result.families ?? []).filter((f) => !result.rows.some((r) => matchesText(r.类型, f)))
      : []
    const list = [...byFamily.entries()]
      .map(([group, items]) => {
        const lines = items.map((r) => `- ${r.卡名}\n  细分：${r.细分}；要点：${r.要点}\n  ${r.相对路径}`)
        return multiFamily ? `【${group}】${items.length} 张\n${lines.join('\n')}` : lines.join('\n')
      })
      .join('\n\n')
    const emptyList = emptyFamilies.map((f) => `【${f}】0 张\n库里没有这一类型的卡`).join('\n\n')
    // 查重结果为空不是失败：库里没有这张卡是正常结论，退出码仍是 0。
    emit(
      { ok: true, errors: [], data: { count: result.rows.length, narrowed: result.narrowed, rows: result.rows, buckets: result.buckets, families: result.families, emptyFamilies, object: result.object, groups: [...byFamily.keys()] } },
      [head, list, emptyList].filter(Boolean).join('\n\n'),
    )
    return 0
  }

  if (options.cmd === 'cardpoints') {
    // 卡点表是技能自带的，不在库里：它是路由与缺口账，不是库的内容（D-38）。
    // 所以它读库、但不改库——这个命令与 find 一样是只读的。
    const tablePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', '触发卡点表.md')
    if (!existsSync(tablePath)) {
      emit({ ok: false, error: '缺 references/触发卡点表.md，无从计算缺口', data: {} }, '缺 references/触发卡点表.md，无从计算缺口')
      return 3
    }
    const rows = []
    for (const line of readFileSync(tablePath, 'utf8').split(/\r?\n/)) {
      if (!/^\| \d+ \|/.test(line)) continue
      const c = line.split('|').map((s) => s.trim())
      if (c.length < 7) continue
      rows.push({ n: Number(c[1]), 卡点: c[2], 类: c[3].replace(/\*\*/g, '').trim(), 类型: c[4], 细分: c[5], 证据: c[7] })
    }
    const index = readIndex(root)
    const covered = []
    const gaps = []
    const uncal = []
    for (const r of rows) {
      // 必须按「类型＋细分」两层数。只按类型数会把同类型下不相干的卡点也算成有料：
      // #16 节奏失衡 与 #17 视角混乱 同属 S-07，库里只有叙事节奏的卡时，
      // 按类型数会把 #17 也报成 1，等于告诉用户「视角问题库里有料」——用户白跑一趟。
      const wanted = r.类型.split('／').map((s) => s.trim()).filter(Boolean)
      const subs = r.细分.split('、').map((s) => s.trim()).filter(Boolean)
      const hit = index.filter(
        (row) => wanted.some((w) => matchesText(row.类型, w)) && subs.some((s) => matchesText(row.细分, s)),
      )
      // 未校准的条目照常计数，但单列：它们不是「库里有没料」，是「这条本身还没验过」。
      if (String(r.证据).startsWith('未校准')) uncal.push({ ...r, count: hit.length })
      else (hit.length ? covered : gaps).push({ ...r, count: hit.length })
    }
    const head = `卡点覆盖：${covered.length} 条有料，缺口 ${gaps.length} 条，未校准 ${uncal.length} 条（库内 ${index.length} 张卡）`
    // C 类要标出来：库里有料不等于这个问题能靠库回答。#9 卡文即使库里有技巧卡，
    // 也回答不了「作者当时怎么了」——不标，读的人会把「1 张」当成「能解决」。
    const line = (x) => `- #${x.n} ${x.卡点} → ${x.类型}（${x.count} 张${x.类 === 'C' ? ' · C 类：只能靠作者自述，卡给的是料不是答案' : ''}）`
    const body = [
      covered.length ? `有料：\n${covered.map(line).join('\n')}` : '',
      gaps.length ? `缺口：\n${gaps.map(line).join('\n')}` : '',
      uncal.length ? `未校准（这几条还没被样本验过，不计入缺口结论）：\n${uncal.map(line).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    emit(
      { ok: true, errors: [], data: { covered: covered.length, gaps: gaps.length, uncalibrated: uncal.length, cards: index.length, items: [...covered, ...gaps, ...uncal] } },
      [head, body].filter(Boolean).join('\n\n'),
    )
    return 0
  }

  if (options.cmd === 'check') {
    const issues = checkVault(root)
    if (issues.length) {
      emit({ ok: false, errors: issues.map((m) => ({ message: m })), data: { root } }, `库校验发现 ${issues.length} 处问题：\n${issues.map((i) => `- ${i}`).join('\n')}`)
      return 1
    }
    emit({ ok: true, errors: [], data: { root, cards: readIndex(root).length } }, `库校验通过（${readIndex(root).length} 张卡，格式版本 ${SCHEMA_VERSION}）`)
    return 0
  }

  if (options.cmd === 'write') {
    if (!options.card) {
      err(`write 需要 --card <JSON 路径>（- 表示从标准输入读）。\n${USAGE}`)
      return 2
    }
    if (!existsSync(root)) {
      err(`库根不存在：${root}`)
      return 3
    }
    let payload
    let cardText = ''
    try {
      cardText = options.card === '-' ? readFileSync(0, 'utf8') : readFileSync(options.card, 'utf8')
      payload = JSON.parse(cardText)
    } catch (error) {
      err(error instanceof SyntaxError ? jsonProblem(cardText, error, options.card) : `读不出卡内容：${error.message}`)
      return 2
    }
    const result = writeCard(root, payload, payload.relPath)
    if (!result.ok) {
      emit({ ok: false, errors: result.issues.map((m) => ({ message: m })), data: {} }, `卡未写入，${result.issues.length} 处问题：\n${result.issues.map((i) => `- ${i}`).join('\n')}`)
      return 1
    }
    emit({ ok: true, errors: [], data: { relPath: result.relPath } }, `已写入：${result.relPath}`)
    return 0
  }

  if (options.cmd === 'card') {
    const action = options.action
    const run = {
      edit: () => cardEdit(root, { path: options.path, field: options.field, value: options.value, section: options.section }),
      delete: () => cardDelete(root, { path: options.path }),
      restore: () => cardRestore(root, { path: options.path }),
      merge: () => cardMerge(root, { from: options.from, into: options.into }),
      move: () => cardMove(root, { path: options.path, bucket: options.bucket, family: options.family }),
    }[action]
    const result = run()
    if (!result.ok) {
      emit({ ok: false, errors: result.issues.map((m) => ({ message: m })), data: { action, ...(result.relPath ? { relPath: result.relPath } : {}) } }, `card ${action} 未完成：\n${result.issues.map((i) => `- ${i}`).join('\n')}`)
      return 1
    }
    const data = { action, ...result }
    delete data.ok
    delete data.issues
    const text = {
      edit: `已改 ${result.relPath} 的「${result.field}」：${result.value}`,
      delete: `已删 ${result.relPath}，移进 ${result.trashPath}（可用 card restore 找回）`,
      restore: `已找回 ${result.relPath}`,
      merge: `已把 ${result.from} 并进 ${result.relPath}${result.mergedFields?.length ? `（并入 ${result.mergedFields.join('、')}）` : '（被并入卡没有补充记录与关联卡，只收原卡）'}`,
      move: result.unchanged ? `大类与类型已是目标值，文件未移动：${result.relPath}` : `已挪到 ${result.relPath}（原 ${result.from}）`,
    }[action]
    emit({ ok: true, errors: [], data }, text)
    return 0
  }

  err(`未知子命令 ${options.cmd}。\n${USAGE}`)
  return 2
}

function main() {
  process.exitCode = runCli(process.argv.slice(2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
