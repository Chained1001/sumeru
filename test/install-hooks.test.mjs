// 防的漂移：钩子内容与命令脱节，或装到非 git 仓库里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HookExistsError, NotGitRepoError, UsageError, installHooks, parseArgs } from '../scripts/install-hooks.mjs'

const hookScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-hooks.mjs')

// 受限沙箱禁止子进程走管道（EPERM）。此时跳过 CLI 测试，并写明恢复条件。
const probe = spawnSync(process.execPath, ['-e', "process.stdout.write('ok')"], { encoding: 'utf8' })
const noSpawn = probe.stdout === 'ok' ? {} : { skip: '当前环境禁止子进程管道（EPERM），CLI 测试需在普通终端运行' }
const cliTest = (name, fn) => test(name, noSpawn, fn)

async function withRepo(run) {
  const root = await mkdtemp(join(tmpdir(), 'hooks-'))
  await mkdir(join(root, '.git', 'hooks'), { recursive: true })
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('安装后钩子存在且调用 validate 与 test', async () => {
  await withRepo(async (root) => {
    const result = await installHooks({ root })
    assert.equal(result.action, 'installed')
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.match(text, /npm run validate/)
    assert.match(text, /npm test/)
  })
})

test('--package-dir 让钩子切到子目录', async () => {
  await withRepo(async (root) => {
    await installHooks({ root, packageDir: '基座' })
    const text = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')
    assert.match(text, /cd "\$root\/基座"/)
  })
})

test('已有钩子时拒绝覆盖，--force 可覆盖', async () => {
  await withRepo(async (root) => {
    await installHooks({ root })
    await assert.rejects(() => installHooks({ root }), HookExistsError)
    const result = await installHooks({ root, force: true })
    assert.equal(result.overwrite, true)
  })
})

test('非 git 仓库时拒绝安装', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nogit-'))
  try {
    await assert.rejects(() => installHooks({ root }), NotGitRepoError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--dry-run 不写文件', async () => {
  await withRepo(async (root) => {
    const result = await installHooks({ root, dryRun: true })
    assert.equal(result.action, 'dry-run')
    assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false)
  })
})

test('--package-dir 为绝对路径时拒绝', async () => {
  await withRepo(async (root) => {
    await assert.rejects(
      () => installHooks({ root, packageDir: resolve('some', 'pkg') }),
      (error) => error instanceof UsageError && error.message.includes('相对'),
    )
  })
})

test('--package-dir 含 " ` $ 或反斜杠时拒绝，并提示用 /', async () => {
  await withRepo(async (root) => {
    for (const bad of ['a\\b', 'a"b', 'a`b', 'a$b']) {
      await assert.rejects(
        () => installHooks({ root, packageDir: bad }),
        (error) => error instanceof UsageError && error.message.includes('/'),
        `${bad} 应被拒绝并提示用 /`,
      )
    }
    await installHooks({ root, packageDir: '基座/sub-dir' })
    assert.match(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), /cd "\$root\/基座\/sub-dir"/)
  })
})

test('第二个位置参数报「多余的参数」而不是静默覆盖 root', () => {
  const one = parseArgs(['some/repo'])
  assert.equal(one.root, 'some/repo')
  assert.throws(() => parseArgs(['a', 'b']), (error) => error instanceof UsageError && error.message.includes('多余的参数'))
})

cliTest('CLI：--help 退出码 0，未知参数退出码 2，非 git 仓库退出码 1', async () => {
  const help = spawnSync(process.execPath, [hookScript, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /用法/)

  assert.equal(spawnSync(process.execPath, [hookScript, '--bogus'], { encoding: 'utf8' }).status, 2)

  const root = await mkdtemp(join(tmpdir(), 'hooks-cli-'))
  try {
    const r = spawnSync(process.execPath, [hookScript, root], { encoding: 'utf8' })
    assert.equal(r.status, 1, `非 git 仓库应退出码 1，实际 ${r.status}：${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /不是 git 仓库/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
