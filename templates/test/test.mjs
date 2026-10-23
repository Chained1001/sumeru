import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')

// 防的漂移：TODO，写明防的是哪种漂移，不超过 60 字。
test('TODO：输入与期望结果，格式为"<输入>报 <结果>"', () => {
  assert.fail(`TODO：替换为对可观测输出的真实断言，夹具目录为 ${fixtures}`)
})
