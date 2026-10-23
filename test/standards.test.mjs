// 防的漂移：基座副本的标准与源头不一致，或副本缺编号、多出文件。
// 源头是 开发框架/规范/，只在框架仓内存在。项目复制基座后源头不在，此时只检查副本自身的结构。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const copy = join(here, '..', 'docs', '规范')
const source = join(here, '..', '..', '规范')
const NAME = /^\d{2}-[^/\\]+\.md$/

const copyFiles = async () => (await readdir(copy)).filter((n) => n.endsWith('.md')).sort()

test('副本的每个标准文件名都带两位编号，且编号从 00 起连续', async () => {
  const names = await copyFiles()
  assert.ok(names.length > 0, '副本中没有标准')
  names.forEach((n, i) => {
    assert.match(n, NAME, `${n} 不符合 NN-名称.md`)
    assert.equal(Number(n.slice(0, 2)), i, `${n} 的编号应为 ${String(i).padStart(2, '0')}，编号须连续`)
  })
})

test('副本中的标准与源头逐字一致（仅在框架仓内运行：源头 ../规范 存在时）', { skip: !existsSync(source) && '项目环境中无源头，本条不适用' }, async () => {
  const names = await copyFiles()
  const srcNames = (await readdir(source)).filter((n) => n.endsWith('.md')).sort()
  assert.deepEqual(names, srcNames, '副本与源头的文件清单不一致')
  for (const n of names) {
    const a = readFileSync(join(copy, n), 'utf8')
    const b = readFileSync(join(source, n), 'utf8')
    assert.equal(a, b, `${n} 与源头不一致，须同次同步`)
  }
})
