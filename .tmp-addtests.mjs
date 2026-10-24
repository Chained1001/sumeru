
test('add 判「已有」用整条相等，不用子串包含', () => {
  // 子串判定会吞掉意思相反的新信息：旧正文「他并不是天才，全靠苦练」，
  // 新补「天才」是它的子串 → 判成「已有」→ 静默丢弃。
  // 丢掉的那条恰是与旧文相反的说法，正是最该记进去的；而且结果只显示
  // 「这张卡上已经有这段内容了」，人不会回头核对一张据说没变的卡。
  const root = addVault()
  addRun(root, { 卡名: '甲', 对象标识: '甲' })
  // 先把正文改成带否定的句子
  const rel = '故事零件/S-02 人物设定/卡-20261001-甲.md'
  const before = readFileSync(join(root, rel), 'utf8')
  writeFileSync(join(root, rel), before.replace('这是甲的正文', '他并不是天才，全靠苦练'), 'utf8')

  const r = addRun(root, { 卡名: '甲', 对象标识: '甲', 补充内容: '天才' })
  assert.match(r.stdout, /新内容补进去了/, '与旧文意思相反的新信息必须记进去，不能被当成子串吞掉')
  const after = readFileSync(join(root, rel), 'utf8')
  assert.match(after, /补充记录[\s\S]*天才/, '补充记录里要有这条')
})

test('add 去掉补充行的日期前缀后再比，重复补同一条仍然幂等', () => {
  // 整条相等不能因为「上一行带了日期前缀」就认不出重复，否则每次补同一条
  // 都会再写一行，补充记录变成流水账。
  const root = addVault()
  addRun(root, { 卡名: '甲', 对象标识: '甲' })
  addRun(root, { 卡名: '甲', 对象标识: '甲', 补充内容: '同一段' })
  const r = addRun(root, { 卡名: '甲', 对象标识: '甲', 补充内容: '同一段' })
  assert.match(r.stdout, /没建新卡/)
  const body = readFileSync(join(root, '故事零件/S-02 人物设定/卡-20261001-甲.md'), 'utf8')
  assert.equal((body.match(/同一段/g) || []).length, 1, '不该写两遍')
})
