#!/usr/bin/env node
// 库接口（vault）：读素材库的身份证、索引、卡，并做机器可判的校验。
// 这是所有「读写库」功能的唯一入口——定位、升级、卡管理、复审、库况都从这走，
// 格式演进只改本文件。判据对应：J-03 要点字数、J-06 时效取值、J-09 来源等级取值。
// 用法：node scripts/vault.mjs check <库根>
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BUCKETS = ['故事零件', '写作方法', '作品案例', '现实避坑']
export const TIME_STATES = ['现行', '已过时', '待观察', '长期']
export const SOURCE_LEVELS = ['证实', '单源', '线索', '存疑']
const REQUIRED_FIELDS = ['卡名', '桶', '类型族', '子类', '来源', '来源等级', '采集日期', '时效状态', '要点']
const INDEX_COLUMNS = ['卡名', '桶', '类型族', '子类', '要点', '时效', '相对路径']
const SCHEMA_VERSION = 1

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
  const rest = text.slice(start).split(/\n(?=## )/)[0]
  return rest
}

// —— 身份证（VAULT.md）：格式版本＋一句话简介
export function readVaultMeta(root) {
  const file = join(root, 'VAULT.md')
  if (!existsSync(file)) return { exists: false }
  const text = readFileSync(file, 'utf8')
  const version = /版本：(\d+)/.exec(text)?.[1]
  const intro = /简介：(.+)/.exec(text)?.[1]?.trim()
  return { exists: true, version: version == null ? null : Number(version), intro: intro ?? null }
}

export function writeVaultMeta(root, intro) {
  writeFileSync(join(root, 'VAULT.md'), `# 素材库身份证\n\n版本：${SCHEMA_VERSION}\n简介：${intro}\n`)
}

// —— 索引（INDEX.md）：一行一卡
export function readIndex(root) {
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

export function appendIndex(root, row) {
  const file = join(root, 'INDEX.md')
  const head = existsSync(file)
    ? ''
    : `# 素材索引\n\n| ${INDEX_COLUMNS.join(' | ')} |\n|${INDEX_COLUMNS.map(() => '---').join('|')}|\n`
  const line = `| ${INDEX_COLUMNS.map((c) => row[c] ?? '').join(' | ')} |`
  const prev = head === '' ? readFileSync(file, 'utf8').replace(/\s*$/, '') : head.replace(/\s*$/, '')
  writeFileSync(file, `${prev}\n${line}\n`)
}

// —— 卡：三节（基本信息 / 类型维度 / 正文）
export function readCard(file) {
  const text = readFileSync(file, 'utf8')
  const name = /\/([^/\\]+)$/.exec(file)?.[1] ?? file
  return {
    file: name,
    basic: parseListField(text, '基本信息'),
    dimension: parseListField(text, '类型维度'),
    body: parseListField(text, '正文'),
  }
}

export function indexRowFor(card, relPath) {
  return {
    卡名: card.basic.卡名 ?? '',
    桶: card.basic.桶 ?? '',
    类型族: card.basic.类型族 ?? '',
    子类: card.basic.子类 ?? '',
    要点: card.basic.要点 ?? '',
    时效: card.basic.时效状态 ?? '',
    相对路径: relPath,
  }
}

// —— 校验：只做机器可判的判据（J-03 / J-06 / J-09 / 必填 / 桶合法）
export function checkCard(card) {
  const issues = []
  for (const f of REQUIRED_FIELDS) {
    if (!card.basic[f]) issues.push(`缺必填字段「${f}」`)
  }
  if ((card.basic.要点 ?? '').length > 40) issues.push(`要点 ${card.basic.要点.length} 字，超 40（J-03）`)
  if (card.basic.时效状态 && !TIME_STATES.includes(card.basic.时效状态)) issues.push(`时效状态「${card.basic.时效状态}」不合法（J-06）`)
  if (card.basic.来源等级 && !SOURCE_LEVELS.includes(card.basic.来源等级)) issues.push(`来源等级「${card.basic.来源等级}」不合法（J-09）`)
  if (card.basic.桶 && !BUCKETS.includes(card.basic.桶)) issues.push(`桶「${card.basic.桶}」不合法`)
  return issues
}

export function checkVault(root) {
  const issues = []
  const meta = readVaultMeta(root)
  if (!meta.exists) issues.push('缺 VAULT.md 身份证')
  else if (meta.version !== SCHEMA_VERSION) issues.push(`身份证版本 ${meta.version} ≠ 当前 ${SCHEMA_VERSION}，须先升级`)
  const rows = readIndex(root)
  if (rows.length === 0) issues.push('索引为空或不存在')
  for (const row of rows) {
    const file = join(root, row.相对路径)
    if (!existsSync(file)) {
      issues.push(`索引行指向不存在的卡：${row.相对路径}`)
      continue
    }
    const card = readCard(file)
    for (const i of checkCard(card)) issues.push(`${row.相对路径}：${i}`)
    if (card.basic.卡名 && row.卡名 !== card.basic.卡名) issues.push(`${row.相对路径}：索引卡名与卡不一致`)
  }
  return issues
}

// —— CLI
function main() {
  const [cmd, target] = process.argv.slice(2)
  if (cmd !== 'check' || !target) {
    console.error('用法：node scripts/vault.mjs check <库根>')
    process.exit(2)
  }
  if (!existsSync(target)) {
    console.error(`库根不存在：${target}`)
    process.exit(2)
  }
  const issues = checkVault(target)
  if (issues.length === 0) {
    console.log(`库校验通过（${readIndex(target).length} 张卡，格式版本 ${SCHEMA_VERSION}）`)
    return
  }
  console.error(`库校验发现 ${issues.length} 处问题：`)
  for (const i of issues) console.error(`- ${i}`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
