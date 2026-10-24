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

// 02-脚本与测试 规定「code 只取下表取值；新增错误码须同次写进本表并补测试」。
// 这条一致性没有人核对就会漂：E_ARGS 在三个脚本里用着，却一直不在表里。
test('脚本里用到的错误码都已在 02-脚本与测试 的错误码表中登记', async () => {
  const scriptsDir = join(here, '..', 'scripts')
  const used = new Set()
  for (const name of await readdir(scriptsDir)) {
    if (!name.endsWith('.mjs')) continue
    const text = readFileSync(join(scriptsDir, name), 'utf8')
    for (const m of text.matchAll(/'(E_[A-Z_]+)'/g)) used.add(m[1])
    // 三元里以裸标识符形式出现的码（如 code: 'E_IO' 已覆盖；此处兜住 "? 'E_A' : 'E_B'"）。
    for (const m of text.matchAll(/"(E_[A-Z_]+)"/g)) used.add(m[1])
  }
  assert.ok(used.size > 0, '未从脚本里读到任何错误码，检查的取法可能已失效')

  const spec = readFileSync(join(copy, '02-脚本与测试.md'), 'utf8')
  const documented = new Set([...spec.matchAll(/^\| `(E_[A-Z_]+)`/gm)].map((m) => m[1]))
  const missing = [...used].filter((c) => !documented.has(c)).sort()
  assert.deepEqual(missing, [], `这些错误码只在脚本里用、没写进 02 的错误码表：${missing.join('、')}`)
})

// 防的漂移：文件里混进控制字符，git 把整个文件判成二进制，diff 从此看不见。
// 2026-10-24 真发生过：用 PowerShell 写 CHANGELOG 时反引号被当转义符吃掉——
// 反引号后跟 0 成了 NUL、跟 a 成了响铃、跟 r 成了回车，CHANGELOG 在 git diff 里显示成 "Bin"。
// 这类坏字节肉眼看不见，只能机器扫。CR 也一并拦：.gitattributes 定的是 eol=lf。
test('仓库文本文件里没有控制字符（含 NUL 与 CR）', async () => {
  const root = join(here, '..')
  // .gitattributes 也是 eol 的事实源，但它没有扩展名，所以单列。
  const exts = ['.md', '.mjs', '.json', '.yml', '.yaml']
  const names = new Set(['.gitattributes', '.gitignore'])
  // test/.tmp/ 是测试临时目录（.gitignore 已挡），残留夹具会误报。
  const skipDirs = new Set(['node_modules', '.git', '.tmp', '.收编进度'])
  const bad = []

  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (skipDirs.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
        continue
      }
      if (!exts.some((x) => e.name.endsWith(x)) && !names.has(e.name)) continue

      const buf = readFileSync(full)
      const rel = full.slice(root.length + 1).split('\\').join('/')
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i]
        if (v === 0x09 || v === 0x0a) continue // tab 与 LF 合法
        if (v < 0x20) {
          const line = buf.subarray(0, i).toString('utf8').split('\n').length
          const from = Math.max(0, i - 40)
          const around = buf.subarray(from, Math.min(buf.length, i + 40)).toString('utf8')
          const shown = [...around].map((ch) => (ch.charCodeAt(0) < 0x20 ? '?' : ch)).join('')
          bad.push(rel + ':' + line + ' 有 0x' + v.toString(16).toUpperCase() + '，上下文「' + shown + '」')
          break
        }
      }
    }
  }

  await walk(root)
  assert.deepEqual(bad, [], '这些文件里有控制字符（多半是 PowerShell 把反引号当转义符吃掉了）：\n' + bad.join('\n'))
})
