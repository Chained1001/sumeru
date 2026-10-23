#!/usr/bin/env node
// 静态校验 skills/ 的目录结构、frontmatter、本地引用与 README 技能表。只用 Node 内置模块。
// 用法：validate.mjs [路径] [--json] [--help]
// 退出码：0 通过，1 校验失败，2 参数错误。
import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = '用法：validate.mjs [路径] [--json] [--help]'
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// 与 规范/03-命名.md 的保留名清单一致，改一处须同次改另一处。
const RESERVED_NAMES = new Set(['skills', 'docs', 'templates', 'scripts', 'test', 'evals', 'examples', 'node_modules'])
// 与 规范/01 的 frontmatter 两表一致：前六个是 agentskills 规范键，后三个是宿主扩展键。
const KNOWN_KEYS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
  'whenToUse', 'disable-model-invocation', 'user-invocable',
])
const BOOLEAN_KEYS = ['disable-model-invocation', 'user-invocable']
const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'])
const MAX_BODY_LINES = 500
// 宿主上下文压缩后只重附技能文件前 20000 字符（Claude Code 官方文档），超限内容在余下会话丢失。
const MAX_SKILL_CHARS = 20000
const MAX_DESCRIPTION = 1024
const MAX_COMPATIBILITY = 500

function unquote(value) {
  const double = /^"(.*)"$/.exec(value)
  if (double) return double[1].replace(/\\"/g, '"')
  const single = /^'(.*)'$/.exec(value)
  if (single) return single[1].replace(/''/g, "'")
  return value
}

export function parseFrontmatter(text) {
  text = text.replace(/^\uFEFF/, '') // 容 UTF-8 BOM（评审 P14）：带 BOM 的 SKILL.md 不应误报缺 frontmatter
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { error: '缺少 frontmatter：文件开头须为 --- 包裹的 YAML 块' }
  const fields = {}
  let current = null
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) {
      if (current === null) return { error: `frontmatter 缩进行没有父键：${line}` }
      continue
    }
    const pair = /^([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/.exec(line)
    if (!pair) return { error: `frontmatter 行无法解析：${line}` }
    const value = (pair[2] ?? '').trim()
    if (/^[>|][-+]?$/.test(value)) return { error: `frontmatter 不支持多行块标量（${value}），请写成单行` }
    if (!/^["']/.test(value) && value.includes(': ')) return { error: `${pair[1]} 的值含 ": "，须用双引号包起来` }
    current = pair[1]
    fields[current] = unquote(value)
  }
  return { fields, body: text.slice(match[0].length) }
}

export function localLinks(body) {
  const stripped = body.replace(/```[\s\S]*?```/g, '')
  const targets = []
  for (const match of stripped.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
    targets.push(target.split('#')[0])
  }
  // 反引号里的相对路径。模板与示例都用这种写法，不认它等于这条检查从未生效。
  for (const match of stripped.matchAll(/`([^`\s]+\.md)`/g)) {
    const target = match[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue
    if (/[<>{}*]|TODO|NN-/.test(target)) continue
    targets.push(target)
  }
  return [...new Set(targets.filter(Boolean))]
}

export function checkSkillText(dirName, text, file = `skills/${dirName}/SKILL.md`) {
  const errors = []
  const fail = (code, message) => errors.push({ code, file, message })
  text = text.replace(/^﻿/, '') // BOM 统一在入口剥（评审 P14）
  const parsed = parseFrontmatter(text)
  if (parsed.error) {
    fail('E_FRONTMATTER', parsed.error)
    return errors
  }
  const { fields, body } = parsed

  for (const key of Object.keys(fields)) {
    if (!KNOWN_KEYS.has(key)) fail('E_UNKNOWN_KEY', `未知字段 ${key}`)
  }

  const name = fields.name ?? ''
  if (!name) {
    fail('E_NAME', '缺少 name')
  } else {
    if (name.length > 64 || !NAME_PATTERN.test(name)) {
      fail('E_NAME', `name "${name}" 须为 1–64 位小写英文、数字与单连字符，不以连字符开头或结尾`)
    }
    if (name !== dirName) fail('E_NAME_MISMATCH', `name "${name}" 与目录名 "${dirName}" 不一致`)
  }

  if (RESERVED_NAMES.has(dirName)) fail('E_NAME_RESERVED', `"${dirName}" 是保留名，不得用作技能目录名，见 docs/规范/03-命名.md`)

  const description = fields.description ?? ''
  const descriptionLength = [...description].length
  if (descriptionLength === 0) {
    fail('E_DESCRIPTION', '缺少非空的 description')
  } else if (descriptionLength > MAX_DESCRIPTION) {
    fail('E_DESCRIPTION', `description 为 ${descriptionLength} 字符，超过 ${MAX_DESCRIPTION}`)
  }

  if (fields.compatibility !== undefined && [...fields.compatibility].length > MAX_COMPATIBILITY) {
    fail('E_COMPATIBILITY', `compatibility 超过 ${MAX_COMPATIBILITY} 字符`)
  }

  for (const key of BOOLEAN_KEYS) {
    if (fields[key] !== undefined && !BOOLEAN_WORDS.has(fields[key].toLowerCase())) {
      fail('E_BOOLEAN', `${key} 只接受 true/false、yes/no、on/off、1/0，当前为 "${fields[key]}"`)
    }
  }

  if (text.includes('TODO')) fail('E_PLACEHOLDER', '仍含 TODO，请补全正式内容')
  if (text.includes('{{')) fail('E_PLACEHOLDER', '仍含 {{ 占位符，请替换')

  const lines = body.replace(/\r?\n$/, '').split(/\r?\n/).length
  if (lines > MAX_BODY_LINES) fail('E_BODY_LINES', `正文 ${lines} 行，超过 ${MAX_BODY_LINES} 行，请拆到 workflows/ 或 references/`)

  const chars = [...text].length
  if (chars > MAX_SKILL_CHARS) fail('E_BODY_SIZE', `SKILL.md 全文 ${chars} 字符，超过 ${MAX_SKILL_CHARS}（宿主压缩后只重附前 ${MAX_SKILL_CHARS} 字符），请拆到 workflows/ 或 references/`)

  return errors
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

// 占位符不只查 SKILL.md：workflows/、references/ 等留满 TODO 同样不合格。
async function checkSkillPlaceholders(skillDir, rel) {
  const errors = []
  for (const file of await walk(skillDir)) {
    if (!file.endsWith('.md')) continue
    const name = relative(skillDir, file).split(sep).join('/')
    if (name === 'SKILL.md') continue
    const text = await readFile(file, 'utf8')
    const at = `${rel}/${name}`
    if (text.includes('TODO')) errors.push({ code: 'E_PLACEHOLDER', file: at, message: '仍含 TODO，请补全正式内容' })
    if (text.includes('{{')) errors.push({ code: 'E_PLACEHOLDER', file: at, message: '仍含 {{ 占位符，请替换' })
  }
  return errors
}

// 引用检查覆盖技能内所有 .md，不只 SKILL.md；反引号路径也算引用。
// 相对路径以所在文件为基准解析（workflows/ 里的 `../SKILL.md` 指技能根）。
async function checkSkillLinks(skillDir, rel) {
  const errors = []
  const root = resolve(skillDir)
  for (const file of await walk(skillDir)) {
    if (!file.endsWith('.md')) continue
    const name = relative(skillDir, file).split(sep).join('/')
    const text = await readFile(file, 'utf8')
    const body = name === 'SKILL.md' ? (parseFrontmatter(text).body ?? text) : text
    const at = `${rel}/${name}`
    for (const target of localLinks(body)) {
      // 只查技能内部引用。仓库级路径不属于技能内容，不在技能内解析。
      if (/^(?:docs|evals|templates|skills)\//.test(target)) continue
      const abs = resolve(dirname(file), target)
      if (!abs.startsWith(root + sep)) {
        errors.push({ code: 'E_LINK', file: at, message: `引用路径越出技能目录：${target}` })
      } else if (!existsSync(abs)) {
        errors.push({ code: 'E_LINK', file: at, message: `引用的文件不存在：${target}` })
      }
    }
  }
  return errors
}

export async function validateRepo(root) {
  const skillsDir = join(root, 'skills')
  if (!existsSync(skillsDir)) {
    return [{ code: 'E_NO_SKILLS_DIR', file: 'skills/', message: '缺少 skills/ 目录' }]
  }
  if (!statSync(skillsDir).isDirectory()) {
    return [{ code: 'E_NO_SKILLS_DIR', file: 'skills/', message: 'skills/ 不是目录，请改为目录并放入技能' }]
  }
  const errors = []
  const skillNames = []
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    const rel = `skills/${entry.name}`
    if (entry.isFile()) {
      if (entry.name.endsWith('.md')) {
        errors.push({ code: 'E_FLAT', file: rel, message: '技能必须是目录形式（<name>/SKILL.md），不允许平铺 .md' })
      }
      continue
    }
    if (!entry.isDirectory()) continue
    skillNames.push(entry.name)

    const skillDir = join(skillsDir, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    if (!existsSync(skillFile)) {
      errors.push({ code: 'E_NO_SKILL_MD', file: rel, message: '目录缺少 SKILL.md' })
      continue
    }
    const file = `${rel}/SKILL.md`
    const text = await readFile(skillFile, 'utf8')
    errors.push(...checkSkillText(entry.name, text, file))
    errors.push(...(await checkSkillPlaceholders(skillDir, rel)))
    errors.push(...(await checkSkillLinks(skillDir, rel)))
  }

  for (const file of await walk(skillsDir)) {
    const parts = relative(skillsDir, file).split(sep)
    if (parts.at(-1) === 'SKILL.md' && parts.length !== 2) {
      errors.push({ code: 'E_NESTED', file: `skills/${parts.join('/')}`, message: 'SKILL.md 只能位于 skills/<name>/ 下，不允许嵌套' })
    }
  }

  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    errors.push(...(await checkWorkflows(join(skillsDir, entry.name), `skills/${entry.name}`)))
  }

  // README 技能表是使用者发现技能的入口，技能增删后最容易漏同步（约定，脚本检查）。
  // 只认表格行（首列为技能名）：散文顺带提及不算入索引，否则这条检查形同虚设。
  const readme = join(root, 'README.md')
  if (existsSync(readme)) {
    const readmeText = (await readFile(readme, 'utf8')).replace(/^\uFEFF/, '')
    for (const name of skillNames) {
      const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (!new RegExp(`^\\|\\s*${safeName}\\s*\\|`, 'm').test(readmeText)) {
        errors.push({ code: 'E_INDEX', file: 'README.md', message: `未提及技能 ${name}，请更新技能列表` })
      }
    }
  }
  return errors
}

export const WORKFLOW_SECTIONS = ['## 目的', '## 输入', '## 步骤', '## 产出', '## 停止条件']
const WORKFLOW_NAME = /^(\d{2})-.+\.md$/

export function checkWorkflowFiles(entries, file = 'workflows/') {
  const errors = []
  const names = entries.filter((e) => e.endsWith('.md'))
  const seen = []
  for (const name of names) {
    const match = WORKFLOW_NAME.exec(name)
    if (!match) {
      errors.push({ code: 'E_WORKFLOW_ORDER', file: `${file}${name}`, message: '流程文件名须为 NN-中文名.md' })
      continue
    }
    // init-skill 生成的骨架文件名是 NN-TODO.md，内容补全后忘改名不算完成。
    if (name.includes('TODO')) errors.push({ code: 'E_PLACEHOLDER', file: `${file}${name}`, message: '流程文件名仍含 TODO，请改为正式中文名' })
    seen.push(Number(match[1]))
  }
  seen.sort((a, b) => a - b)
  seen.forEach((n, i) => {
    if (n !== i + 1) errors.push({ code: 'E_WORKFLOW_ORDER', file, message: `序号须从 01 起连续，缺少 ${String(i + 1).padStart(2, '0')} 或序号重复` })
  })
  return errors
}

export function checkWorkflowText(text, file) {
  const missing = WORKFLOW_SECTIONS.filter((h) => !text.includes(h))
  return missing.map((h) => ({ code: 'E_WORKFLOW_SECTION', file, message: `缺少固定小节 ${h}` }))
}

async function checkWorkflows(skillDir, rel) {
  const dir = join(skillDir, 'workflows')
  if (!existsSync(dir)) return []
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
  const errors = checkWorkflowFiles(names, `${rel}/workflows/`)
  for (const name of names.filter((n) => n.endsWith('.md'))) {
    const text = await readFile(join(dir, name), 'utf8')
    errors.push(...checkWorkflowText(text, `${rel}/workflows/${name}`))
  }
  return errors
}

export function parseArgs(argv) {
  const options = { root: '.', json: false, help: false }
  const positional = []
  for (const arg of argv) {
    if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`未知参数 ${arg}。${USAGE}`)
    // 以 - 开头的一律按未知参数拒绝（含单短横与单独的 -），不支持把 - 或 -x 之类当路径。
    else if (arg.startsWith('-')) throw new Error(`未知参数 ${arg}。以 - 开头的输入会被当成参数，路径不能用 - 开头。${USAGE}`)
    else positional.push(arg)
  }
  if (positional.length > 1) throw new Error(`多余的参数 ${positional.slice(1).join(' ')}。${USAGE}`)
  if (positional.length === 1) options.root = positional[0]
  return options
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, errors: [{ code: error.code ?? 'E_ARGS', file: '', message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  const root = resolve(options.root)
  const errors = await validateRepo(root)
  const ok = errors.length === 0
  const data = { root }

  if (options.json) {
    console.log(JSON.stringify({ ok, errors, data }, null, 2))
  } else {
    for (const e of errors) console.error(`FAIL [${e.code}] ${e.file}: ${e.message}`)
    console.log(ok ? '校验通过' : `校验失败：${errors.length} 处问题`)
  }
  if (!ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
