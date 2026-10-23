// 防的漂移：基座副本的模板与源头不一致，或副本缺文件、多出文件。
// 源头是 开发框架/模板/，只在框架仓内存在。项目复制基座后源头不在，此时只检查副本自身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const copy = join(here, '..', 'templates')
const source = join(here, '..', '..', '模板')

async function listFiles(dir) {
  const out = []
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  await walk(dir)
  return out.sort()
}

test('副本中的模板与源头逐字一致（仅在框架仓内运行）', { skip: !existsSync(source) && '项目环境中无源头，本条不适用' }, async () => {
  const names = await listFiles(copy)
  assert.ok(names.length > 0, '副本中没有模板')
  assert.deepEqual(names, await listFiles(source), '副本与源头的文件清单不一致')
  for (const n of names) {
    assert.equal(readFileSync(join(copy, n), 'utf8'), readFileSync(join(source, n), 'utf8'), `${n} 与源头不一致，须同次同步`)
  }
})
