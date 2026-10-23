#!/usr/bin/env node
// 在 git 仓库里安装 pre-commit 钩子：提交前跑 validate 与 test，任一失败则拒绝提交。只用 Node 内置模块。
// 用法：install-hooks.mjs [路径] [--package-dir <相对路径>] [--force] [--dry-run] [--json] [--help]
// 退出码：0 成功，1 业务失败（不是 git 仓库、已有钩子且未加 --force），2 参数错误。
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// 钩子实际生效的目录由 core.hooksPath 决定：设了它（husky、lefthook、monorepo 常见），
// <git dir>/hooks 下的钩子永不执行，装在那里会「提示已安装、实际从不触发」。
// 只读 .git/config 里的一行，不起 git 子进程：零依赖、无沙箱与 PATH 依赖，失败即按默认处理。
async function resolveHooksDir(dir) {
  const gitDir = await resolveGitDir(dir)
  const fallback = join(gitDir, 'hooks')
  if (!gitDir) return fallback
  let config
  try {
    config = await readFile(join(gitDir, 'config'), 'utf8')
  } catch {
    return fallback
  }
  // 只认 [core] 段里的 hooksPath，避免认错其它段里的同名键。
  let inCore = false
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line)
    if (section) {
      inCore = section[1].trim().toLowerCase() === 'core'
      continue
    }
    if (!inCore) continue
    const kv = /^\s*hooksPath\s*=\s*(.*)$/i.exec(line)
    if (!kv) continue
    const value = kv[1].trim().replace(/^"(.*)"$/, '$1')
    if (!value) return fallback
    // 相对路径按仓库根解释，与 git 的行为一致。
    return isAbsolute(value) ? value : join(dir, value)
  }
  return fallback
}

// .git 在 worktree 与 submodule 里是文件（内容为 "gitdir: <路径>"），不是目录。
async function resolveGitDir(dir) {
  const dotGit = join(dir, '.git')
  if (!existsSync(dotGit)) return null
  try {
    const text = await readFile(dotGit, 'utf8')
    const m = /^gitdir:\s*(.+)$/m.exec(text)
    if (m) return resolve(dir, m[1].trim())
    return dotGit
  } catch {
    return dotGit
  }
}

const USAGE = '用法：install-hooks.mjs [路径] [--package-dir <相对路径>] [--force] [--dry-run] [--json] [--help]'

function hookText(packageDir) {
  const cd = packageDir ? `cd "$root/${packageDir}"` : 'cd "$root"'
  return `#!/bin/sh
# 由 scripts/install-hooks.mjs 生成。提交前跑静态校验与测试，任一失败则拒绝提交。
set -e
root=$(git rev-parse --show-toplevel)
${cd}
if [ ! -f package.json ]; then
  echo "pre-commit: 该目录没有 package.json，跳过校验" >&2
  exit 0
fi
npm run validate
npm test
`
}

export class UsageError extends Error {}
export class NotGitRepoError extends Error {}
export class HookExistsError extends Error {}

// packageDir 会拼进钩子脚本的 `cd "$root/${packageDir}"：绝对路径没有 $root 前缀可依，
// " ` $ 与反斜杠则会破坏 sh 引号或被展开，一律在入口拒绝。
function validatePackageDir(packageDir) {
  if (!packageDir) return
  if (isAbsolute(packageDir)) {
    throw new UsageError(`--package-dir 须为相对仓库根的路径，当前为 "${packageDir}"`)
  }
  if (/["`$\\]/.test(packageDir)) {
    throw new UsageError(`--package-dir 不得含 "、\`、$ 或反斜杠，路径分隔请用 /，当前为 "${packageDir}"`)
  }
  if (/[\x00-\x1f\x7f]/.test(packageDir)) {
    throw new UsageError('--package-dir 不得含控制字符（含换行），当前值含不可见字符')
  }
}

export async function installHooks({ root = '.', packageDir = '', force = false, dryRun = false } = {}) {
  validatePackageDir(packageDir)
  const dir = resolve(root)
  if (!existsSync(join(dir, '.git'))) {
    throw new NotGitRepoError(`不是 git 仓库：${dir}。先运行 git init`)
  }
  const hooksDir = await resolveHooksDir(dir)
  const hookPath = join(hooksDir, 'pre-commit')
  const exists = existsSync(hookPath)
  if (exists && !force) {
    throw new HookExistsError(`已存在 pre-commit 钩子：${hookPath}。加 --force 覆盖`)
  }

  if (dryRun) return { action: 'dry-run', path: hookPath, overwrite: exists }

  await mkdir(hooksDir, { recursive: true })
  await writeFile(hookPath, hookText(packageDir), 'utf8')
  // Windows 上 git 会忽略执行位，但类 Unix 系统需要 755。
  await chmod(hookPath, 0o755)
  return { action: 'installed', path: hookPath, overwrite: exists }
}

export function parseArgs(argv) {
  const options = { root: '.', packageDir: '', force: false, dryRun: false, json: false, help: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--package-dir') options.packageDir = requireValue(argv, ++i, arg)
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new UsageError(`未知参数 ${arg}。${USAGE}`)
    else positional.push(arg)
  }
  // 第二个位置参数不再静默覆盖 root，与兄弟脚本一致报「多余的参数」。
  if (positional.length > 1) throw new UsageError(`多余的参数 ${positional.slice(1).join(' ')}。${USAGE}`)
  if (positional.length === 1) options.root = positional[0]
  return options
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith('--')) throw new UsageError(`${flag} 缺少取值。${USAGE}`)
  return argv[index]
}

// 错误出口唯一化：--json 时一律输出 {ok:false, errors:[{code,message}], data:{}}，否则写 stderr。
// 用法错误（UsageError）与业务错误必须走同一出口，只差退出码。
function reportError(error, { json, code, exitCode }) {
  if (json) {
    console.log(JSON.stringify({ ok: false, errors: [{ code, message: error.message }], data: {} }, null, 2))
  } else {
    console.error(error.message)
  }
  process.exitCode = exitCode
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    // parseArgs 抛错时 options 还不存在，只能从 argv 里找 --json。
    reportError(error, { json: process.argv.includes('--json'), code: 'E_ARGS', exitCode: 2 })
    return
  }
  if (options.help) {
    console.log(USAGE)
    return
  }

  try {
    const result = await installHooks({
      root: options.root,
      packageDir: options.packageDir,
      force: options.force,
      dryRun: options.dryRun,
    })
    if (options.json) {
      console.log(JSON.stringify({ ok: true, errors: [], data: result }, null, 2))
    } else if (result.action === 'dry-run') {
      console.log(`将写入 ${result.path}${result.overwrite ? '（覆盖已有钩子）' : ''}`)
    } else {
      console.log(`已安装 pre-commit 钩子：${result.path}`)
      console.log('下次 git commit 前会自动运行 npm run validate 与 npm test。')
    }
  } catch (error) {
    if (error instanceof UsageError) {
      reportError(error, { json: options.json, code: 'E_ARGS', exitCode: 2 })
      return
    }
    reportError(error, { json: options.json, code: 'E_HOOK', exitCode: 1 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
