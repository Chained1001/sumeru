#!/usr/bin/env node
// 用途：TODO，不超过 60 字。
// 用法：node scripts/TODO.mjs [路径] [--json] [--dry-run] [--help]
// 退出码：0 成功，1 业务失败，2 参数错误，3 环境缺失。
// 依赖：无，只用 node: 内置模块。
// 写文件：先写临时文件再重命名；默认不覆盖，覆盖须 --force；--dry-run 只输出动作，不落盘。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = '用法：node scripts/TODO.mjs [路径] [--json] [--dry-run] [--help]'

export async function run(root) {
  // TODO：纯逻辑，返回 { ok, errors, data }。
  return { ok: true, errors: [], data: { root } }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(USAGE)
    return
  }
  const unknown = args.find((a) => a.startsWith('--') && a !== '--json' && a !== '--dry-run')
  if (unknown) {
    console.error(`未知参数 ${unknown}。${USAGE}`)
    process.exitCode = 2
    return
  }
  // TODO：需要外部程序时，检测失败以 3 退出，并写明安装方法。
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? '.')
  const result = await run(root)
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const e of result.errors) console.error(`FAIL [${e.code}] ${e.file}: ${e.message}`)
    console.log(result.ok ? '通过' : `失败：${result.errors.length} 处问题`)
  }
  if (!result.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
