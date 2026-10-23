// 防的漂移：发版做到一半——package.json 的 version 与 CHANGELOG 最新版本段不一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json 的 version 与 CHANGELOG 最新版本段一致', () => {
  const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
  const changelog = readFileSync(join(base, 'CHANGELOG.md'), 'utf8')
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - /gm)].map((m) => m[1])
  // 未发过版（CHANGELOG 只有 [Unreleased]）时无从漂移，跳过
  if (versions.length === 0) return
  assert.equal(versions[0], pkg.version, `CHANGELOG 最新版本 ${versions[0]} 与 package.json 的 ${pkg.version} 不一致，发版步骤 3、4 须同次完成`)
})
