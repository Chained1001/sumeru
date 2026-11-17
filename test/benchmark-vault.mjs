#!/usr/bin/env node
// 手动性能核验，不进 npm test：node test/benchmark-vault.mjs [--json]
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, platform, release, arch } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { checkVault, initVault, runCli, writeCard } from '../skills/material-vault/scripts/vault.mjs'

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write('用法：node test/benchmark-vault.mjs [--json]\n生成临时千卡库，测量五轮 check；结束后自动清理，不以耗时作为 CI 门禁。\n')
} else if (args.some((arg) => arg !== '--json') || args.length > 1) {
  const message = '只支持 --json 或 --help。请运行 node test/benchmark-vault.mjs --help。'
  if (args.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, errors: [{ code: 'E_ARGS', message }], data: {} }) + '\n')
  else process.stderr.write(message + '\n')
  process.exitCode = 2
} else {
  const root = mkdtempSync(join(tmpdir(), 'sumeru-benchmark-'))
  try {
    assert.equal(initVault(root).ok, true)
    const directory = '故事零件/人物设定'
    const rel = `${directory}/卡-20261117-0000.md`
    const card = {
      basic: {
        卡名: '性能样本0000', 大类: '故事零件', 类型: 'S-02 人物设定', 细分: '原型基底',
        来源: '人工构造性能样本', 来源等级: '单源', 采集日期: '2026-11-17', 时效状态: '长期',
        要点: '以玩笑掩盖执念的角色，测量用样本',
      },
      dimension: { 性格核: '表面随和、内里执拗', 执念与软肋: '兑现承诺，害怕辜负同伴' },
      body: { 为什么管用: '外在行为与内在动机形成反差', 原文摘录或事实要点: '人工样本，无外部原文' },
    }
    assert.equal(writeCard(root, card, rel).ok, true)
    const seed = readFileSync(join(root, rel), 'utf8')
    // 只测校验，夹具批量复制后一次重建索引，避免把逐卡维护索引计入准备时间。
    for (let i = 1; i < 1000; i++) {
      const number = String(i).padStart(4, '0')
      writeFileSync(join(root, directory, `卡-20261117-${number}.md`), seed.replaceAll('性能样本0000', `性能样本${number}`), 'utf8')
    }
    assert.equal(runCli(['index', 'rebuild', '--vault', root], { out: () => {}, err: () => {} }), 0)
    const samples = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      const issues = checkVault(root)
      samples.push(Number((performance.now() - start).toFixed(2)))
      assert.deepEqual(issues, [], '性能夹具必须是合法的千卡库')
    }
    const sorted = [...samples].sort((a, b) => a - b)
    const result = {
      environment: `${platform()} ${release()} ${arch()} / Node ${process.version}`,
      cards: 1000, samplesMs: samples, medianMs: sorted[2], maxMs: sorted.at(-1),
      targetMs: 2000, withinTarget: samples.every((value) => value <= 2000),
      scope: '同进程五轮，夹具刚写入，文件系统缓存可能已热；不代表冷盘、网络盘或其他机器',
    }
    process.stdout.write(args.includes('--json') ? JSON.stringify({ ok: true, errors: [], data: result }) + '\n' : `${JSON.stringify(result, null, 2)}\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
