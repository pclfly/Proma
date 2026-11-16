import { describe, expect, test } from 'bun:test'
import type { VaultTreeEntry } from '@proma/shared'
import { buildVaultTree, buildVaultTreeFromDirectories, flattenVaultTree, getVaultFileRowKey, getVaultFolderRowKey } from './vault-tree-model'

const folder = (relativePath: string): VaultTreeEntry => ({
  kind: 'folder',
  relativePath,
  name: relativePath.split('/').at(-1) ?? relativePath,
})
const file = (relativePath: string): VaultTreeEntry => ({
  kind: 'file',
  relativePath,
  name: relativePath.split('/').at(-1) ?? relativePath,
  size: 0,
  modifiedAt: 0,
})

describe('Vault 文件树展平', () => {
  test('Given 全部折叠 When 展平 Then 只产出顶层行且文件夹排在文件之前', () => {
    const tree = buildVaultTree([folder('b'), folder('a'), folder('a/nested'), file('b/note.md'), file('root.md')])
    const rows = flattenVaultTree(tree, new Set())
    expect(rows.map((row) => row.key)).toEqual([
      getVaultFolderRowKey('a'),
      getVaultFolderRowKey('b'),
      getVaultFileRowKey('root.md'),
    ])
    expect(rows.every((row) => row.depth === 0)).toBe(true)
  })

  test('Given 展开嵌套文件夹 When 展平 Then 子行紧随父行且深度递增', () => {
    const tree = buildVaultTree([folder('a'), folder('a/nested'), file('a/nested/deep.md'), file('a/top.md')])
    const rows = flattenVaultTree(tree, new Set(['a', 'a/nested']))
    expect(rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
      `folder:${getVaultFolderRowKey('a')}`,
      `folder:${getVaultFolderRowKey('a/nested')}`,
      `file:${getVaultFileRowKey('a/nested/deep.md')}`,
      `file:${getVaultFileRowKey('a/top.md')}`,
    ])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1])
  })

  test('Given 未展开父级 When 子级被标记展开 Then 不产出隐藏行', () => {
    const tree = buildVaultTree([folder('a'), folder('a/b'), file('a/b/x.md')])
    const rows = flattenVaultTree(tree, new Set(['a/b']))
    expect(rows.map((row) => row.key)).toEqual([getVaultFolderRowKey('a')])
  })

  test('Given 同名文件与文件夹 When 展平 Then 行键不冲突且按数字序排序', () => {
    const tree = buildVaultTree([file('note2.md'), file('note10.md'), file('note1.md')])
    const rows = flattenVaultTree(tree, new Set())
    expect(rows.map((row) => (row.kind === 'file' ? row.file.name : row.name))).toEqual([
      'note1.md',
      'note2.md',
      'note10.md',
    ])
    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(getVaultFolderRowKey('x')).not.toBe(getVaultFileRowKey('x'))
  })

  test('Given 空树 When 展平 Then 返回空数组', () => {
    expect(flattenVaultTree(buildVaultTree([]), new Set())).toEqual([])
  })
})

describe('Vault 增量构树（懒加载）', () => {
  test('Given 只加载根层 When 构树 Then 未请求的子目录保持空且不伪造文件', () => {
    const tree = buildVaultTreeFromDirectories([folder('a'), file('root.md')], new Map())
    expect([...tree.folders.keys()]).toEqual(['a'])
    expect(tree.folders.get('a')?.files).toEqual([])
    expect(tree.files.map((entry) => entry.relativePath)).toEqual(['root.md'])
  })

  test('Given 根层与子层分别到达 When 构树 Then 合并为同一棵树且重复条目不重复', () => {
    const children = new Map<string, readonly VaultTreeEntry[]>([
      ['a', [folder('a/b'), file('a/x.md')]],
      ['a/b', [file('a/b/y.md')]],
    ])
    const tree = buildVaultTreeFromDirectories([folder('a')], children)
    const a = tree.folders.get('a')
    expect(a?.files.map((entry) => entry.relativePath)).toEqual(['a/x.md'])
    expect(a?.folders.get('b')?.files.map((entry) => entry.relativePath)).toEqual(['a/b/y.md'])
  })

  test('Given 子层先于父层到达 When 构树 Then 自动补齐父节点路径', () => {
    const tree = buildVaultTreeFromDirectories([], new Map([['deep/nested', [file('deep/nested/z.md')]]]))
    expect(tree.folders.get('deep')?.folders.get('nested')?.files[0]?.relativePath).toBe('deep/nested/z.md')
  })
})
