import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './skills/material-vault/scripts/vault.mjs'

const vault = process.argv[2]
const quiet = { out() {}, err() {} }
runCli(['init', '--vault', vault], quiet)

// 按 evals/cases/material-vault-浏览.md 的前置状态：三张卡，桶与族各不相同，日期两两不同
const specs = [
  { rel: '故事零件/人物设定/卡-20261021-甲角色.md', 族: 'S-02 人物设定', 子: '角色卡', 名: '甲角色', 要点: '甲：认死理的老实人', 采: '2026-10-21', 内容: '甲的正文在此。' },
  { rel: '故事零件/剧情桥段/卡-20261023-丙桥段.md', 族: 'S-03 剧情桥段', 子: '开局钩子', 名: '丙桥段', 要点: '丙：一睁眼就在牢里', 采: '2026-10-23', 内容: '丙的正文在此——这句是摘录要念的那段。' },
  { rel: '现实避坑/现实见闻/卡-20261024-丁见闻.md', 族: 'S-10 现实见闻', 子: '历史事件', 名: '丁见闻', 要点: '丁：诏狱的三样器物', 采: '2026-10-24', 内容: '丁的正文在此。' },
]

for (const s of specs) {
  const card = {
    relPath: s.rel,
    basic: {
      卡名: s.名,
      桶: s.rel.split('/')[0],
      类型族: s.族,
      子类: s.子,
      来源: '用例构造',
      来源等级: '单源',
      采集日期: s.采,
      时效状态: '长期',
      私有: '否',
      对象标识: s.名,
      要点: s.要点,
    },
    dimension: { '核心欲望': 'x', '致命弱点': 'x', '可改造方向': 'x', '借鉴意图': 'x' },
    body: { 内容: s.内容, 原文摘录或事实要点: '', 借鉴意图: '', 已用在: '', 关联卡: '', 补充记录: '' },
  }
  const f = join(vault, '..', `${s.名}.json`)
  writeFileSync(f, JSON.stringify(card), 'utf8')
  runCli(['add', '--vault', vault, '--card', f], quiet)
}

let out = ''
runCli(['check', '--vault', vault], { out: (x) => (out += x), err: (x) => (out += x) })
console.log('check: ' + out.trim())

// C-01：INDEX 行数 vs 四桶卡数
console.log('\n===== C-01 四桶卡数（overview）=====')
out = ''
runCli(['overview', '--vault', vault], { out: (x) => (out += x), err: (x) => (out += x) })
console.log(out.trim())
