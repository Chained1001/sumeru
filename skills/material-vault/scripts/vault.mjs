#!/usr/bin/env node
// 库接口（vault）：素材库的四件事——找库、建库、写一张卡、查一个库。
// 字段与取值的事实源是 cardFormat.mjs，本文件只管「怎么读写库」与「校验怎么汇总」。
// 调用方不再需要知道「读卡 → 拼索引行 → 追加索引 → 再校验」这个顺序：writeCard 一次做完。
// 用法：node scripts/vault.mjs <子命令> [选项]，子命令与选项见 --help。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkBasic, indexRow, INDEX_COLUMNS, FIELDS, FIELD_NAMES, BUCKETS, defaultPrivate } from './cardFormat.mjs'

export { FIELDS, INDEX_COLUMNS, defaultPrivate, checkBasic }
// 格式版本：1 是老库（卡上无「私有」行），2 起「私有」必填。升级见 upgradeVault。
export const SCHEMA_VERSION = 2

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
    if (!existsSync(join(root, row.相对路径))) issues.push(`索引行指向不存在的卡：${row.相对路径}`)
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
      if (entry.name === '已删卡片') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/^卡-.+\.md$/.test(entry.name)) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root, 0)
  return out
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

// —— 接口四：把一张卡补进索引（F-09）。等价于只对这卡重算一行，不重扫全库。
function indexCard(root, rel) {
  if (!existsSync(join(root, rel))) return { ok: false, issues: [`卡不存在：${rel}`] }
  const card = readCard(join(root, rel))
  const issues = checkBasic(card.basic)
  if (issues.length) return { ok: false, issues }
  upsertIndex(root, indexRow(card, rel))
  return { ok: true, issues: [] }
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

选项
  --vault <路径>    库根；不给则按 detect 的三层判定
  --intro <一行>    init 时写进身份证的简介
  --card <路径>     write 的卡内容 JSON 文件，- 表示从标准输入读
  --path <相对路径> index add 要补进索引的卡
  --dry-run         index rebuild 与 upgrade 只报清单，不落盘
  --json            输出单个 JSON 对象
  --help, -h        显示本说明`

// 参数一律长名，短名只留 -h：短名一多，隔几个月就没人记得住哪个字母是什么。
const FLAGS_WITH_VALUE = new Set(['--vault', '--intro', '--card', '--path'])
const KNOWN_COMMANDS = new Set(['detect', 'init', 'check', 'write', 'index', 'upgrade'])

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

  err(`未知子命令 ${options.cmd}。\n${USAGE}`)
  return 2
}

function main() {
  process.exitCode = runCli(process.argv.slice(2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
