import { describe, expect, test } from 'bun:test'
import { parseMarkdownProperties, planMarkdownPropertyEdit, type MarkdownPropertyEdit } from './live-markdown-properties'
import { getLeadingFrontmatterRange } from './live-markdown-frontmatter'

function edit(source: string, operation: Omit<MarkdownPropertyEdit, 'expectedFrontmatter'>): string {
  const model = parseMarkdownProperties(source)
  const result = planMarkdownPropertyEdit(source, { ...operation, expectedFrontmatter: model.source })
  if (result.status === 'unchanged') return source
  if (result.status !== 'changed') throw new Error(`${result.status}: ${result.reason}`)
  return source.slice(0, result.change.from) + result.change.insert + source.slice(result.change.to)
}

describe('Properties AST局部编辑', () => {
  test('Given 嵌套映射和列表内map When 改深层叶子 Then 不改相邻类型、注释和正文', () => {
    const source = '\uFEFF---\r\n# 原注释\r\nmeta:\r\n  名称 :  "旧😀"  # 行尾\r\n  enabled: true\r\nitems:\r\n  - name: one\r\n    tags: [ a , "b" ]\r\n---\r\n最新正文\n'
    expect(edit(source, { kind: 'set', path: ['meta', '名称'], scalarType: 'string', value: '新😀' })).toBe(source.replace('"旧😀"', '"新😀"'))
    expect(edit(source, { kind: 'set', path: ['items', 0, 'tags', 1], scalarType: 'string', value: 'c' })).toBe(source.replace('"b"', '"c"'))
  })
  test('Given flow和block列表 When 编辑第二项 Then 保留列表风格和顺序', () => {
    const source = '---\na: [one, two]\nb:\n  - [x, y]\n---\nbody'
    expect(edit(source, { kind: 'set', path: ['a', 1], scalarType: 'string', value: 'true' })).toBe(source.replace('two', '"true"'))
    expect(edit(source, { kind: 'set', path: ['b', 0, 1], scalarType: 'number', value: '12' })).toBe(source.replace('y]', '12]'))
  })
  test('Given 仅focus/blur When 值与类型没变 Then 没有重写格式或undo事务', () => {
    const source = '---\nkey :  \'same\' # keep\nn: 0x1F\n---\n'
    expect(edit(source, { kind: 'set', path: ['key'], scalarType: 'string', value: 'same' })).toBe(source)
    expect(edit(source, { kind: 'set', path: ['n'], scalarType: 'number', value: '31' })).toBe(source)
  })
  test('Given 语义看似类型的字符串 When 修改 Then 仍为字符串并保留单引号风格', () => {
    const source = "---\na: 'old'\nb: old\n---\n"
    expect(edit(source, { kind: 'set', path: ['a'], scalarType: 'string', value: "it's true" })).toContain("a: 'it''s true'")
    expect(edit(source, { kind: 'set', path: ['b'], scalarType: 'string', value: 'null' })).toContain('b: "null"')
  })
  test('Given 大整数 When 修改另一字段 Then 不损精度且可准确输入新的整数', () => {
    const source = '---\nn: 9007199254740993\na: old\n---\n'
    expect(edit(source, { kind: 'set', path: ['a'], scalarType: 'string', value: 'new' })).toContain('9007199254740993')
    expect(edit(source, { kind: 'set', path: ['n'], scalarType: 'number', value: '9007199254740995' })).toContain('9007199254740995')
  })
  test('Given 只有正文改变 When 操作提交 Then 保留最新正文；属性改变则拒绝旧快照', () => {
    const source = '---\na: old\nb: one\n---\nold body'
    const baseline = parseMarkdownProperties(source).source
    const op: MarkdownPropertyEdit = { kind: 'set', path: ['a'], scalarType: 'string', value: 'new', expectedFrontmatter: baseline }
    expect(planMarkdownPropertyEdit(source.replace('old body', 'NEW body'), op).status).toBe('changed')
    expect(planMarkdownPropertyEdit(source.replace('b: one', 'b: newest'), op).status).toBe('conflict')
  })
  test('Given 有引号的键 When 重命名 Then 仅替换键token；同级重名拒绝', () => {
    const source = '---\n"old key" : x # keep\nother: y\n---\n'
    expect(edit(source, { kind: 'rename', path: ['old key'], key: 'new key' })).toBe(source.replace('"old key"', '"new key"'))
    expect(planMarkdownPropertyEdit(source, { kind: 'rename', path: ['old key'], key: 'other', expectedFrontmatter: parseMarkdownProperties(source).source }).status).toBe('raw-required')
  })
  test('Given 简单block映射和列表 When 删除一个子项 Then 不改其他项的字节', () => {
    const source = '---\nmap:\n  a: x # remove\n  b : "keep"\nlist:\n  - one\n  - two # stay\n---\n'
    expect(edit(source, { kind: 'remove', path: ['map', 'a'] })).toBe(source.replace('  a: x # remove\n', ''))
    expect(edit(source, { kind: 'remove', path: ['list', 0] })).toBe(source.replace('  - one\n', ''))
  })
  test('Given flow列表或映射 When 删除首中尾和最后一项 Then 集合仍合法', () => {
    for (const [path, expected] of [[['a', 0], '[two, three]'], [['a', 1], '[one, three]'], [['a', 2], '[one, two]']] as const) {
      expect(edit('---\na: [one, two, three]\n---\n', { kind: 'remove', path })).toContain(expected)
    }
    expect(edit('---\na: [one]\n---\n', { kind: 'remove', path: ['a', 0] })).toContain('a: []')
    expect(edit('---\na: { x: 1, y: 2 }\n---\n', { kind: 'remove', path: ['a', 'x'] })).toContain('{ y: 2 }')
  })
  test('Given block集合最后一个子项 When 删除 Then 显式保留空集合类型', () => {
    expect(parseMarkdownProperties(edit('---\na:\n  - one\n---\n', { kind: 'remove', path: ['a', 0] })).root?.children[0]?.kind).toBe('sequence')
    expect(parseMarkdownProperties(edit('---\na:\n  x: one\n---\n', { kind: 'remove', path: ['a', 'x'] })).root?.children[0]?.kind).toBe('mapping')
  })
  test('Given block/flow/空映射列表 When 添加 Then 可递归继续编辑且原项不重排', () => {
    expect(edit('---\na: x\n---\n', { kind: 'insert', path: [], key: 'b', valueSource: '"new"' })).toBe('---\na: x\nb: "new"\n---\n')
    expect(edit('---\na: []\n---\n', { kind: 'insert', path: ['a'], valueSource: '{}' })).toContain('a: [{}]')
    expect(edit('---\n---\n', { kind: 'insert', path: [], key: 'new', valueSource: '[]' })).toBe('---\nnew: []\n---\n')
    expect(edit('---\na:\n  - one\n---\n', { kind: 'insert', path: ['a'], valueSource: '"two"' })).toContain('  - one\n  - "two"\n')
  })
  test('Given 注释归属有歧义的flow结构 When 删除 Then 明示源码编辑而不重排', () => {
    const source = '---\na: [one, # comment\n two]\n---\n'
    const result = planMarkdownPropertyEdit(source, { kind: 'remove', path: ['a', 0], expectedFrontmatter: parseMarkdownProperties(source).source })
    expect(result.status).toBe('raw-required')
  })
  test('Given anchor/alias/tag/重复键/语法错误 When 解析 Then 原文回退而非toJS展开', () => {
    for (const yaml of ['a: &a {x: y}\nb: *a', 'a: !custom v', 'a: 1\na: 2', '? [a, b]\n: x', 'a: [broken', '%YAML 1.2\n---\na: x']) {
      const source = `---\n${yaml}\n---\nbody`
      expect(parseMarkdownProperties(source).mode).toBe('raw')
    }
  })
  test('Given block scalar里含缩进分隔符 When 扫描 Then 不错误关闭围栏且普通属性仍可编辑', () => {
    const source = '---\ntext: |-\n  ---\n  [[raw]]\na: old\n---\nbody'
    const parsed = parseMarkdownProperties(source)
    expect(parsed.endLine).toBe(6)
    expect(parsed.root?.children[0]?.kind).toBe('raw')
    expect(edit(source, { kind: 'set', path: ['a'], scalarType: 'string', value: 'new' })).toBe(source.replace('a: old', 'a: new'))
    expect(getLeadingFrontmatterRange(source.split('\n'))?.endLine).toBe(6)
    expect(getLeadingFrontmatterRange(['---', '---'])?.endLine).toBe(2)
  })
  test('Given 未闭合/非首部围栏 When 扫描 Then 不伪造Properties范围', () => {
    expect(parseMarkdownProperties('---\na: x').mode).toBe('none')
    expect(parseMarkdownProperties('body\n---\na: x\n---').mode).toBe('none')
  })
})

describe('Properties安全操作语义不变量', () => {
  test('Given 隐式空值与注释 When set Then 父集合和注释不改变', () => {
    expect(edit('---\na:\n  -\n  - two\n---\nbody', { kind: 'set', path: ['a', 0], scalarType: 'string', value: 'NEW' })).toBe('---\na:\n  - NEW\n  - two\n---\nbody')
    expect(edit('---\na: # keep\nb: next\n---\n', { kind: 'set', path: ['a'], scalarType: 'boolean', value: 'true' })).toBe('---\na: true # keep\nb: next\n---\n')
  })
  test('Given 带注释的null项 When remove Then 不吞下个兄弟的缩进', () => {
    expect(edit('---\na:\n  x: #c\n  y: two\n---\nbody', { kind: 'remove', path: ['a', 'x'] })).toBe('---\na:\n  y: two\n---\nbody')
    expect(edit('---\na:\n  - #keep\n  - two\n  - three\n---\nbody', { kind: 'remove', path: ['a', 0] })).toBe('---\na:\n  - two\n  - three\n---\nbody')
  })
  test('Given 独立dash嵌套列表 When 外层insert Then 外层增加而非最后内层增加', () => {
    const source = '---\na:\n  -\n    - one\n    - two\n  -\n    - three\n    - four\n---\nbody'
    const next = edit(source, { kind: 'insert', path: ['a'], valueSource: '0' })
    const outer = parseMarkdownProperties(next).root?.children[0]
    expect(outer?.children).toHaveLength(3)
    expect(outer?.children[1]?.children).toHaveLength(2)
    expect(next).toBe(source.replace('    - four\n', '    - four\n  - 0\n'))
  })
  test('Given 新增包含flow分隔符的plain文本 When insert Then 只新增一个字符串', () => {
    const next = edit('---\na: []\n---', { kind: 'insert', path: ['a'], valueSource: 'x, y' })
    expect(parseMarkdownProperties(next).root?.children[0]?.children).toHaveLength(1)
    expect(next).toContain('["x, y"]')
  })
})
