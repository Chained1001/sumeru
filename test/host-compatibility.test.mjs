// 静态契约与旧数据兼容性检查；通过不代表任何宿主已经完成联网或派工实测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBasic } from '../skills/material-vault/scripts/cardFormat.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, 'skills/material-vault', path), 'utf8')
function adapter() {
  const path = join(root, 'skills/material-vault/references/宿主能力适配.md')
  assert.ok(existsSync(path), '缺少宿主能力适配契约')
  return readFileSync(path, 'utf8')
}

test('宿主适配按文件、Node、搜索、读取、浏览器和派工能力映射', () => {
  const text = adapter()
  for (const capability of [/文件/, /Node/, /搜索|检索/, /页面|正文/, /浏览器/, /子代理|派工/]) {
    assert.match(text, capability, `适配表缺少能力 ${capability}`)
  }
  for (const path of ['SKILL.md', 'workflows/01-采集.md', 'workflows/02-调研采集.md']) {
    assert.match(read(path), /宿主能力适配\.md/, `${path} 没有接入适配契约`)
  }
})

test('无派工或子代理无网时由主线程执行同一任务书并核输出', () => {
  const text = adapter()
  assert.match(text, /无子代理|不支持.*派工|没有.*派工/)
  assert.match(text, /主线程|主对话/)
  assert.match(text, /同[一等样].*任务书|相同.*任务书/)
  assert.match(text, /返回字段|必需字段|输出字段/)
  assert.match(text, /子代理.*无网|子代理.*无联网/)
  assert.match(text, /不.*反复.*派|不.*重复.*派/)
})

test('调研工具按能力授权，品牌工具名不再构成唯一白名单', () => {
  const researcher = read('agents/调研采集.md')
  const tools = researcher.split('## 可用工具')[1]?.split('\n## ')[0] ?? ''
  assert.ok(tools, '调研任务书缺工具能力说明')
  assert.doesNotMatch(tools, /未列出的工具一律不得调用|^- WebSearch：|^- WebFetch：/m)
  assert.match(tools, /能力|宿主能力适配/)
  const text = adapter()
  assert.match(text, /原生/)
  assert.match(text, /浏览器/)
  assert.match(text, /Agent[- ]Reach/i)
  assert.match(text, /已安装|已经安装/)
  assert.match(text, /不.*自动安装|不.*安装/)
  assert.match(text, /登录/)
  assert.match(text, /宿主配置/)
})

test('缺少本地执行能力不冒充落库，登录和风控边界写明停止', () => {
  const text = adapter()
  assert.match(text, /Node/)
  assert.match(text, /不.*(?:已保存|写库|落库|入库)|不得.*(?:保存|落库)/)
  assert.match(text, /登录/)
  assert.match(text, /验证码|风控/)
  assert.match(text, /停止|停下/)
})

test('S-16 默认全球并服从用户地域限制，不按国别判可信度', () => {
  const row = /^\| S-16 \|.*$/m.exec(read('references/权威源分级.md'))?.[0] ?? ''
  assert.match(row, /全球/)
  assert.match(row, /用户.*(?:显式|指定|明确)/)
  assert.match(row, /优先|按.*限制/)
  assert.match(row, /不.*(?:国别|国家|地域).*可信|可信.*不.*(?:国别|国家|地域)/)
  assert.doesNotMatch(row, /默认只采中国大陆|境外.*必.*标/)
})

test('J-10 记录来源主体和语言，不从域名后缀推断地域', () => {
  const row = /^\| J-10 \|.*$/m.exec(read('references/入库判据.md'))?.[0] ?? ''
  assert.match(row, /主体/)
  assert.match(row, /语言/)
  assert.match(row, /(?:不|不能|不得).*后缀/)
  assert.doesNotMatch(row, /必标「来源：境外」/)
  for (const path of ['agents/调研采集.md', 'workflows/02-调研采集.md', 'references/按作品收集策略.md']) {
    assert.doesNotMatch(read(path), /默认只采大陆域|按 S-16 逐项标「来源：境外」|抽查来源等级与境外标注/, `${path} 仍强制旧地域口径`)
  }
})

test('既有卡的境外来源文本仍合法，不增加迁移必填字段', () => {
  const issues = checkBasic({
    卡名: '旧卡', 大类: '现实避坑', 类型: 'S-10 现实见闻', 细分: '职业细节',
    来源: '来源：境外；原始机构自述', 来源等级: '单源', 采集日期: '2026-10-01',
    时效状态: '长期', 私有: '否', 要点: '旧卡保留来源文本',
  })
  assert.deepEqual(issues, [])
  assert.match(adapter(), /旧卡|既有卡|已有卡/)
  assert.match(adapter(), /不.*迁移|无需.*迁移|不.*改写/)
})

test('无工具采集员只接收调用方查重结果，不自行读取索引', () => {
  const text = read('agents/采集员通用.md')
  assert.match(text, /调用方.*查重|查重.*调用方/)
  assert.match(text, /候选|查重结果/)
  assert.doesNotMatch(text, /J-05 对索引查重/)
})
