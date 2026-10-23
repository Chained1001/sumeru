#!/usr/bin/env node
// 库接口（vault）：素材库的四件事——找库、建库、写一张卡、查一个库。
// 字段与取值的事实源是 cardFormat.mjs，本文件只管「怎么读写库」与「校验怎么汇总」。
// 调用方不再需要知道「读卡 → 拼索引行 → 追加索引 → 再校验」这个顺序：writeCard 一次做完。
// 用法：node scripts/vault.mjs <子命令> [选项]，子命令与选项见 --help。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, relative, sep, basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkBasic, indexRow, INDEX_COLUMNS, FIELDS, FIELD_NAMES, BUCKETS, defaultPrivate } from './cardFormat.mjs'

export { FIELDS, INDEX_COLUMNS, defaultPrivate, checkBasic }
// 格式版本：1 是老库（卡上无「私有」行），2 起「私有」必填。升级见 upgradeVault。
export const SCHEMA_VERSION = 2
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
export function writeCard(root, card, relPath) {
  const rel = relPath ?? card?.relPath ?? ''
  const file = rel ? join(root, rel) : ''
  const existing = file && existsSync(file) ? readCard(file) : null

  const provided = card?.basic ?? {}
  const basic = { ...(existing?.basic ?? {}) }
  for (const [k, v] of Object.entries(provided)) basic[k] = v
  if (!basic.私有) basic.私有 = defaultPrivate(basic.类型族)

  const issues = checkBasic(basic)
  if (!rel) issues.push('缺相对路径：卡放在 <桶>/<类型族>/卡-<YYYYMMDD>-<短名>.md')
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

// 库里的卡：<桶>/<类型族>/卡-*.md。只认这个形状，其它文件不是卡。
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
  if (parts.length < 2) return { ok: false, error: `路径须为 <桶>/<类型族>/<卡文件名>：${text}` }
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

// —— 接口六：改卡上的一行（F-14 的「改」）。桶与类型族不走这里，走 cardMove。
// 认三个节：基本信息（默认）、类型维度（--section 类型维度）、正文。
// 字段不存在时不新建：拼错字段名若静默新增，卡上会多出一行谁也不知道的字段。
const SECTION_BASIC = '基本信息'
const SECTION_DIMENSION = '类型维度'
const SECTION_BODY = '正文'
const CARD_SECTIONS = [SECTION_BASIC, SECTION_DIMENSION, SECTION_BODY]
// 这两行决定文件放在哪个目录，改了而不挪文件，文件位置与字段就不符（F-14 把挪类型单列一条）。
const LOCATION_FIELDS = ['桶', '类型族']

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
    return { ok: false, issues: [`「${name}」决定文件放在哪个目录，不走 card edit；改用 card move --bucket <桶> --family <类型族>`] }
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

// —— 接口十：挪类型（F-14 的「挪」）。改「桶」「类型族」两行，文件移到新目录，文件名不变。
// 新路径已存在时拒绝：挪过去盖掉另一张卡，等于一次删卡还没进回收站。
export function cardMove(root, { path: relPath, bucket, family } = {}) {
  const checked = cardRel(relPath)
  if (!checked.ok) return { ok: false, issues: [checked.error] }
  const rel = checked.rel
  const nextBucket = String(bucket ?? '').trim()
  const nextFamily = String(family ?? '').trim()
  if (!nextBucket) return { ok: false, issues: ['缺 --bucket：挪到哪个桶（故事零件、写作方法、作品案例、现实避坑）'] }
  if (!nextFamily) return { ok: false, issues: ['缺 --family：挪到哪个类型族，如 S-03 剧情桥段'] }
  // 注册表只固定编号前缀，族名可生长（子类开放）；但「编号 名字」的段式是注册表的一贯写法，缺名字会与注册表行对不上。
  const familyMatch = /^(S-\d{2})\s+(\S.*)$/.exec(nextFamily)
  if (!familyMatch) {
    return { ok: false, issues: [`--family 要写成注册表的段式「S-NN 族名」，如 S-03 剧情桥段：${nextFamily}`] }
  }
  // 目录名只取族名，不带编号：注册表的产卡路径是 素材库/<桶>/<族名>/，编号是卡上「类型族」那一行的前缀。
  const familyDir = familyMatch[2].trim()
  if (/[/\\]|\.\./.test(familyDir)) return { ok: false, issues: [`类型族名不能含路径分隔符或 ..：${nextFamily}`] }
  if (isTrashed(rel)) return { ok: false, issues: [`${TRASH_DIR}/ 里的卡不参与挪类型：${rel}`] }
  if (!BUCKETS.includes(nextBucket)) return { ok: false, issues: [`桶「${nextBucket}」不合法，只能是：${BUCKETS.join('、')}`] }

  const file = join(root, rel)
  if (!existsSync(file)) return { ok: false, issues: [`卡不存在：${rel}`] }

  // 目录由「桶/族名」派生，与注册表「产卡入 素材库/<桶>/<类型族>/」同一口径。
  const nextRel = `${nextBucket}/${familyDir}/${basename(rel)}`
  if (nextRel === rel) {
    // 同一个位置：只把两行对齐，不假装挪过；已经对得上就一个字节都不写。
    const current = readCard(file).basic
    if (current.桶 === nextBucket && current.类型族 === nextFamily) {
      return { ok: true, issues: [], relPath: rel, unchanged: true }
    }
    const aligned = writeCard(root, { basic: { 桶: nextBucket, 类型族: nextFamily } }, rel)
    if (!aligned.ok) return { ok: false, issues: aligned.issues }
    return { ok: true, issues: [], relPath: rel, unchanged: true }
  }
  if (existsSync(join(root, nextRel))) return { ok: false, issues: [`新路径已存在，不覆盖：${nextRel}`] }
  // 搬之前先按新两行校验一遍：卡本身坏了就不该动它的位置，否则库校验会多出一条说不清的错。
  const before = readCard(file)
  const nextBasic = { ...before.basic, 桶: nextBucket, 类型族: nextFamily }
  const issues = checkBasic(nextBasic)
  if (issues.length) return { ok: false, issues }

  // 先搬文件再写两行：写卡走 writeCard，它按盘上内容合并，落盘位置就是新路径。
  // 反过来先写后搬，一旦搬失败，卡上写着新桶而文件还在旧目录，最容易被误当成已挪好。
  moveFile(file, join(root, nextRel))
  const written = writeCard(root, { basic: { 桶: nextBucket, 类型族: nextFamily } }, nextRel)
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
function sourceFingerprint(sourceDir) {
  const files = listSourceFiles(sourceDir)
  const hash = createHash('sha256')
  hash.update(basename(sourceDir).toLowerCase())
  for (const f of files) hash.update(`\u0000${f}`)
  return { fingerprint: hash.digest('hex').slice(0, 12), files }
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

// —— 查重（F-19）：先按桶、类型族、子类、关键词四级收窄索引，命中才打开卡比对要点。
// 库上千张卡时整表翻一遍既慢又看不出「像不像」，收窄后再比对才有意义。
// 一个筛选项都不给时直接拒绝：那等于整表翻，而整表翻正是 F-19 要消掉的做法。
// 关键词比对索引里的「要点」与「卡名」两列，够用来判断「库里有没有这个对象」；
// 要判「内容是否重复」还得打开卡读正文，那一步交给调用方（流程文件里是采集流程第 4 步）。
const FIND_FILTERS = ['bucket', 'family', 'sub', 'keyword']

function matchesText(haystack, needle) {
  return String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase())
}

export function findCards(root, { bucket, family, sub, keyword } = {}) {
  const filters = { bucket, family, sub, keyword }
  const used = FIND_FILTERS.filter((k) => filters[k] !== undefined && String(filters[k]).trim() !== '')
  if (used.length === 0) {
    return {
      ok: false,
      issues: [`查重至少要给一个筛选项（${FIND_FILTERS.map((k) => `--${k}`).join('、')}）：不给就成整表翻，库大了翻不动`],
      rows: [],
    }
  }
  // 桶名与类型族名先验：拼错时返回 0 行会被误读成「库里没有」，其实只是名字写错了。
  if (bucket !== undefined && bucket !== '' && !BUCKETS.includes(bucket)) {
    return { ok: false, issues: [`--bucket 只认四个桶：${BUCKETS.join('、')}；给的是「${bucket}」`], rows: [] }
  }

  let rows = readIndex(root)
  // 逐级收窄：桶 → 类型族 → 子类 → 关键词。每级都在上一级的结果里筛，不重读索引。
  if (bucket) rows = rows.filter((r) => r.桶 === bucket)
  if (family) rows = rows.filter((r) => matchesText(r.类型族, family))
  if (sub) rows = rows.filter((r) => matchesText(r.子类, sub))
  if (keyword) rows = rows.filter((r) => matchesText(r.要点, keyword) || matchesText(r.卡名, keyword))

  return { ok: true, issues: [], rows, narrowed: used }
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
    for (const f of FIELDS) {
      if (basic[f.名] !== undefined && basic[f.名] !== '') continue
      if (f.名 === '私有') {
        // 私有有默认值可算，不必记「待补」。
        basic.私有 = defaultPrivate(basic.类型族)
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

// —— 建库（F-09）：一次写齐身份证、索引表头与四个桶目录。
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
  init              建库：写身份证、索引表头与四个桶目录（F-09）
  check             校验库：身份证、索引、卡三方对账（逐列比）
  index rebuild     从卡重算整个索引；坏卡跳过并单独报
  upgrade           把老库升到当前格式：补缺失字段，已删字段挪进「历史字段」
  index add         只把一张卡补进索引，不重扫全库
  write             按 JSON 写一张卡，顺带修好索引
  card edit         改卡上的一行，索引同步（桶与类型族改用 card move）
  card delete       把卡移进 已删卡片/，并存原相对路径，可从那里找回
  card restore      把 已删卡片/ 里的卡移回原路径并补回索引；原位置被占则拒绝
  card merge        把 --from 的补充记录与关联卡并进 --into，原卡进 已删卡片/
  card move         改桶与类型族两行并移到新目录；新路径已存在则拒绝
  find              查重：按桶、类型族、子类、关键词收窄索引，命中才比对（F-19）
  collect plan      清点来源目录：列出可采的文本文件与不采的其他文件，给源指纹（F-22）
  collect mark      把本批采完的文件记进进度，并报还剩多少（F-22）

选项
  --vault <路径>    库根；不给则按 detect 的三层判定
  --intro <一行>    init 时写进身份证的简介
  --card <路径>     write 的卡内容 JSON 文件，- 表示从标准输入读
  --path <相对路径> index add 要补进索引的卡；card 动作要操作的卡
  --field <字段名>  card edit 要改的行名，如 要点
  --value <新值>    card edit 改成什么
  --section <节名>  card edit 改哪一节：基本信息（默认）、类型维度、正文
  --from <相对路径> card merge 被并入的卡
  --into <相对路径> card merge 的目标卡
  --bucket <桶>     card move 挪到哪个桶；find 按桶收窄
  --family <类型族> card move 挪到哪个类型族；find 按类型族收窄
  --sub <子类>      find 按子类收窄（含即命中）
  --keyword <文本>  find 按关键词收窄，比对卡名与要点（含即命中）
  --source <目录>   collect 的素材来源目录
  --fingerprint <值> collect mark 的源指纹，由 collect plan 给出
  --done <路径列表> collect mark 本批采完了哪些（相对源目录，逗号分隔）
  --dry-run         index rebuild 与 upgrade 只报清单，不落盘
  --json            输出单个 JSON 对象
  --help, -h        显示本说明`

// 参数一律长名，短名只留 -h：短名一多，隔几个月就没人记得住哪个字母是什么。
const FLAGS_WITH_VALUE = new Set(['--vault', '--intro', '--card', '--path', '--field', '--value', '--section', '--from', '--into', '--bucket', '--family', '--sub', '--keyword', '--source', '--fingerprint', '--done'])
const KNOWN_COMMANDS = new Set(['detect', 'init', 'check', 'write', 'index', 'upgrade', 'card', 'find', 'collect'])
// 每个 card 动作的必填参数，形如 [选项名, 用法里的写法]。缺参数是参数错误（2），
// 不该等撞上「未找到库」或「卡不存在」才报——那样调用方无从区分自己拼错了什么。
export const CARD_ACTION_FLAGS = {
  edit: [['path', '--path <卡的相对路径>'], ['field', '--field <字段名>'], ['value', '--value <新值>']],
  delete: [['path', '--path <卡的相对路径>']],
  restore: [['path', '--path <卡的相对路径>']],
  merge: [['from', '--from <被并入的卡>'], ['into', '--into <目标卡>']],
  move: [['path', '--path <卡的相对路径>'], ['bucket', '--bucket <桶>'], ['family', '--family <类型族>']],
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
  if (options.cmd === 'collect' && !['plan', 'mark'].includes(options.action)) {
    const message = `collect 需要动作：plan（清点来源）或 mark（记进度）；给的是「${options.action}」`
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

  if (options.cmd === 'find') {
    const result = findCards(root, { bucket: options.bucket, family: options.family, sub: options.sub, keyword: options.keyword })
    if (!result.ok) {
      emit({ ok: false, error: result.issues.join('；'), data: {} }, result.issues.join('\n'))
      return 2
    }
    const head = result.rows.length
      ? `命中 ${result.rows.length} 张（收窄条件：${result.narrowed.join('、')}）`
      : `没有命中（收窄条件：${result.narrowed.join('、')}）——库里可能确实没有，也可能筛得太窄，可放宽再试`
    const list = result.rows
      .map((r) => `- ${r.卡名}\n  ${r.桶} / ${r.类型族} / ${r.子类}；要点：${r.要点}\n  ${r.相对路径}`)
      .join('\n')
    // 查重结果为空不是失败：库里没有这张卡是正常结论，退出码仍是 0。
    emit({ ok: true, errors: [], data: { count: result.rows.length, narrowed: result.narrowed, rows: result.rows } }, [head, list].filter(Boolean).join('\n'))
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
    try {
      const text = options.card === '-' ? readFileSync(0, 'utf8') : readFileSync(options.card, 'utf8')
      payload = JSON.parse(text)
    } catch (error) {
      err(`读不出卡内容：${error.message}`)
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
      move: result.unchanged ? `桶与类型族已是目标值，文件未移动：${result.relPath}` : `已挪到 ${result.relPath}（原 ${result.from}）`,
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
