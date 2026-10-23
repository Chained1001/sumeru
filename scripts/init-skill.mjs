#!/usr/bin/env node
// 从 templates/ 生成技能骨架：入口，以及按需的流程、参考件、版式、子代理、评测用例。只用 Node 内置模块。
// 用法：init-skill.mjs <name> [--description "..."] [--workflow] [--reference] [--asset] [--agent] [--eval] [--all] [--root <路径>] [--dry-run] [--force] [--json] [--help]
// 退出码：0 成功，1 业务失败（已存在且未 --force），2 参数错误，3 模板缺失。
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const USAGE = '用法：init-skill.mjs <name> [--description "..."] [--workflow] [--reference] [--asset] [--agent] [--eval] [--all] [--root <路径>] [--dry-run] [--force] [--json] [--help]'
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))
const TEMPLATE = join(TEMPLATES, 'skill', 'SKILL.md')
const WORKFLOW_TEMPLATE = join(TEMPLATES, 'skill', 'workflow.md')
const EVAL_TEMPLATE = join(TEMPLATES, 'eval', 'case.md')
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_DESCRIPTION = 'TODO：写明何时使用本技能。'

// 每个可选骨架：开关名、模板、技能内相对路径、标题占位符的取值。
const SCAFFOLDS = [
  { key: 'withReference', from: join('skill', 'reference.md'), path: join('references', '参考件.md'), title: '参考件' },
  { key: 'withAsset', from: join('skill', 'asset.md'), path: join('assets', '版式.md'), title: '版式' },
  { key: 'withAgent', from: join('skill', 'agent.md'), path: join('agents', '子代理.md'), title: '子代理' },
]

export class UsageError extends Error {}
export class TemplateError extends Error {}
export class ExistsError extends Error {}

// description 要进 YAML 单行值：换行压成空格，可能被解析成非字符串的一律加引号。
function yamlValue(text) {
  const flat = String(text).replace(/\r?\n/g, ' ').trim()
  if (flat === '') return '""'
  // 值内任意位置的 # 都可能被 YAML 当注释起点（评审 P12），与行首特殊字符同规则加引号。
  const needsQuote = /: |#|^[\s'">|&*!%@`{[\]?,;]|^- /.test(flat)
  return needsQuote ? `"${flat.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : flat
}

// 生成物行尾统一 LF：模板可能来自 autocrlf 克隆（CRLF），下游按 \n 解析。
const lf = (text) => text.replaceAll('\r\n', '\n')

export function renderSkill(template, { name, description }) {
  return lf(template)
    .replaceAll('{{name}}', () => name)
    .replaceAll('{{description}}', () => yamlValue(description ?? DEFAULT_DESCRIPTION))
}

// --workflow 不能固定写 01：--force 覆盖已有技能时，会与已有流程重号。
function nextWorkflowIndex(dir) {
  const wf = join(dir, 'workflows')
  if (!existsSync(wf)) return '01'
  const nums = readdirSync(wf)
    .map((n) => /^(\d{2})-/.exec(n)?.[1])
    .filter(Boolean)
    .map(Number)
  if (nums.length && Math.max(...nums) >= 99) {
    throw new UsageError(`流程序号已达上限 99：${wf} 已有 99 号流程。先整理合并既有流程，腾出序号再生成`)
  }
  return String(nums.length ? Math.max(...nums) + 1 : 1).padStart(2, '0')
}

export function renderWorkflow(template, { name, seq = '01' }) {
  return lf(template)
    .replaceAll('{{序号}}', () => seq)
    .replaceAll('{{步骤组名}}', () => 'TODO')
    .replaceAll('{{name}}', () => name)
}

// 参考件、版式、子代理、评测用例共用 {{title}}；评测用例还要把被测技能填成实际路径。
export function renderTitled(template, { title }) {
  return lf(template).replaceAll('{{title}}', () => title)
}

function renderEval(template, { name }) {
  return renderTitled(template, { title: `${name} 冒烟` }).replace(/^- 被测技能：.*$/m, `- 被测技能：skills/${name}`)
}

// 读模板：只有「文件不存在」（ENOENT）才算模板缺失；其余错误（权限、被目录占位等）
// 是底层 IO 问题，原样上抛由 main 统一报 E_IO，不得误标成 E_TEMPLATE。
async function readTemplate(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new TemplateError(`模板缺失：${error.path ?? file}。请确认 templates/ 未被删除`)
    }
    throw error
  }
}

export async function initSkill({
  root,
  name,
  description,
  withWorkflow = false,
  withReference = false,
  withAsset = false,
  withAgent = false,
  withEval = false,
  dryRun = false,
  force = false,
}) {
  if (name.length > 64 || !NAME_PATTERN.test(name)) {
    throw new UsageError(`name "${name}" 不合法：须为 1–64 位小写英文、数字与单连字符`)
  }
  const relDir = join('skills', name)
  const dir = join(root, relDir)
  const relFile = join(relDir, 'SKILL.md')
  const exists = existsSync(dir)
  if (exists && !force) {
    throw new ExistsError(`已存在：${relDir}。加 --force 覆盖，或换一个名字`)
  }

  const files = []
  const skillTemplate = await readTemplate(TEMPLATE)
  files.push({ rel: relFile, text: renderSkill(skillTemplate, { name, description }) })

  if (withWorkflow) {
    const seq = nextWorkflowIndex(dir)
    const flow = await readTemplate(WORKFLOW_TEMPLATE)
    files.push({ rel: join(relDir, 'workflows', `${seq}-TODO.md`), text: renderWorkflow(flow, { name, seq }) })
  }
  const enabled = { withReference, withAsset, withAgent }
  for (const s of SCAFFOLDS) {
    if (!enabled[s.key]) continue
    const text = await readTemplate(join(TEMPLATES, s.from))
    files.push({ rel: join(relDir, s.path), text: renderTitled(text, { title: s.title }) })
  }
  if (withEval) {
    const text = await readTemplate(EVAL_TEMPLATE)
    files.push({ rel: join('evals', 'cases', `${name}.md`), text: renderEval(text, { name }) })
  }

  if (dryRun) return { action: 'dry-run', path: relFile, files: files.map((f) => f.rel), overwrite: exists }

  // 先把全部目录建好再写文件，避免中途失败留下半截
  for (const f of files) await mkdir(join(root, f.rel, '..'), { recursive: true })
  for (const f of files) {
    const target = join(root, f.rel)
    const tmp = `${target}.tmp`
    try {
      await writeFile(tmp, f.text, 'utf8')
      await rename(tmp, target)
    } catch (error) {
      // rename 失败时清掉半截临时文件再上抛，不留垃圾。
      await rm(tmp, { force: true })
      throw error
    }
  }
  return { action: 'created', path: relFile, files: files.map((f) => f.rel), overwrite: exists }
}

export function parseArgs(argv) {
  const options = { root: '.', name: undefined, description: undefined, workflow: false, reference: false, asset: false, agent: false, eval: false, dryRun: false, force: false, json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') options.root = requireValue(argv, ++i, arg)
    else if (arg === '--description') options.description = requireValue(argv, ++i, arg)
    else if (arg === '--workflow') options.workflow = true
    else if (arg === '--reference') options.reference = true
    else if (arg === '--asset') options.asset = true
    else if (arg === '--agent') options.agent = true
    else if (arg === '--eval') options.eval = true
    else if (arg === '--all') options.workflow = options.reference = options.asset = options.agent = options.eval = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`)
    else if (options.name === undefined) options.name = arg
    else throw new UsageError(`多余的参数 ${arg}。${USAGE}`)
  }
  if (!options.help && !options.name) throw new UsageError(USAGE)
  return options
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith('--')) throw new UsageError(`${flag} 缺少取值。${USAGE}`)
  return argv[index]
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
  try {
    const result = await initSkill({
      root,
      name: options.name,
      description: options.description,
      withWorkflow: options.workflow,
      withReference: options.reference,
      withAsset: options.asset,
      withAgent: options.agent,
      withEval: options.eval,
      dryRun: options.dryRun,
      force: options.force,
    })
    if (options.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: { ...result, root } }, null, 2))
    } else if (result.action === 'dry-run') {
      console.log(`将生成 ${result.files.join('、')}${result.overwrite ? '（将覆盖已有目录）' : ''}`)
    } else {
      console.log(`已生成 ${result.files.join('、')}`)
      console.log('补全文件中的 TODO 后，运行 npm run validate 确认通过。')
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exitCode = 2
      return
    }
    // 未知错误（如 EACCES/ENOTDIR 等底层 IO 失败）不再误标 E_EXISTS，统一报 E_IO。
    const code = error instanceof TemplateError ? 'E_TEMPLATE' : error instanceof ExistsError ? 'E_EXISTS' : 'E_IO'
    if (options.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ code, message: error.message }], data: {} }, null, 2))
    } else {
      console.error(error.message)
    }
    process.exitCode = error instanceof TemplateError ? 3 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
