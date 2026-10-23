#!/usr/bin/env node
// 库接口（vault）：素材库的四件事——找库、建库、写一张卡、查一个库。
// 字段与取值的事实源是 cardFormat.mjs，本文件只管「怎么读写库」与「校验怎么汇总」。
// 调用方不再需要知道「读卡 → 拼索引行 → 追加索引 → 再校验」这个顺序：writeCard 一次做完。
// 用法：node scripts/vault.mjs <子命令> [选项]，子命令与选项见 --help。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkBasic, indexRow, INDEX_COLUMNS, FIELDS, BUCKETS, defaultPrivate } from './cardFormat.mjs'

export { FIELDS, INDEX_COLUMNS, defaultPrivate, checkBasic }
export const SCHEMA_VERSION = 1

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
function upsertIndex(root, row) {
  const rows = readIndex(root).filter((r) => r.相对路径 !== row.相对路径)
  rows.push(row)
  writeAtomic(join(root, 'INDEX.md'), renderIndex(rows))
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

// —— 接口二：查一个库。身份证、索引、卡、以及「卡有没有进索引」的一致性。
export function checkVault(root) {
  const issues = []
  const meta = readVaultMeta(root)
  if (!meta.exists) issues.push('缺 VAULT.md 身份证')
  else if (meta.version !== SCHEMA_VERSION) issues.push(`身份证版本 ${meta.version} ≠ 当前 ${SCHEMA_VERSION}，须先升级`)

  // 缺 INDEX.md 是错，空索引不是错：init 刚建出来的库就该一张卡也没有（F-09）。
  if (!existsSync(join(root, 'INDEX.md'))) issues.push('缺 INDEX.md')
  const rows = readIndex(root)
  const indexed = new Set()
  for (const row of rows) {
    const file = join(root, row.相对路径)
    indexed.add(row.相对路径)
    if (!existsSync(file)) {
      issues.push(`索引行指向不存在的卡：${row.相对路径}`)
      continue
    }
    const card = readCard(file)
    for (const i of checkBasic(card.basic)) issues.push(`${row.相对路径}：${i}`)
    if (card.basic.卡名 && row.卡名 !== card.basic.卡名) issues.push(`${row.相对路径}：索引卡名与卡不一致`)
  }

  for (const rel of listCards(root)) {
    if (!indexed.has(rel)) issues.push(`卡未进索引：${rel}`)
  }
  return issues
}

// 库里的卡：<桶>/<类型族>/卡-*.md。只认这个形状，其它文件不是卡。
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
  check             校验库：身份证、索引、卡、以及卡是否都进了索引
  write             按 JSON 写一张卡，顺带修好索引

选项
  --vault <路径>    库根；不给则按 detect 的三层判定
  --intro <一行>    init 时写进身份证的简介
  --card <路径>     write 的卡内容 JSON 文件，- 表示从标准输入读
  --json            输出单个 JSON 对象
  --help, -h        显示本说明`

// 参数一律长名，短名只留 -h：短名一多，隔几个月就没人记得住哪个字母是什么。
const FLAGS_WITH_VALUE = new Set(['--vault', '--intro', '--card'])
const KNOWN_COMMANDS = new Set(['detect', 'init', 'check', 'write'])

export function parseCliArgs(argv) {
  const options = { cmd: '', json: false, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值。\n${USAGE}`)
      options[arg.slice(2)] = value
    } else if (arg.startsWith('-') && arg !== '-') throw new Error(`未知参数 ${arg}。\n${USAGE}`)
    else positional.push(arg)
  }
  if (positional.length > 1) throw new Error(`多余的参数 ${positional.slice(1).join(' ')}。\n${USAGE}`)
  options.cmd = positional[0] ?? ''
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
