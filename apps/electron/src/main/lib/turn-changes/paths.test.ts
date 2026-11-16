import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  isPathInside,
  isSafeRelativePath,
  joinDisplayPath,
  normalizePathKey,
  relativeToRoot,
  resolveTargetPath,
  toPosixPath,
} from './paths'

const rootPath = resolve('/workspace/project')

describe('turn-changes paths', () => {
  test('Given Windows 风格路径 When 归一化 Then 统一为 POSIX', () => {
    expect(toPosixPath('src\\main\\index.ts')).toBe('src/main/index.ts')
  })

  test('Given 根目录内文件 When 计算相对路径 Then 返回 POSIX 路径', () => {
    expect(relativeToRoot(rootPath, resolve(rootPath, 'src/app.ts'))).toBe('src/app.ts')
  })

  test('Given 根目录自身或越界路径 When 计算相对路径 Then 返回 null', () => {
    expect(relativeToRoot(rootPath, rootPath)).toBeNull()
    expect(relativeToRoot(rootPath, resolve(rootPath, '../outside.ts'))).toBeNull()
    expect(relativeToRoot(rootPath, resolve('/workspace/other/file.ts'))).toBeNull()
  })

  test('Given 大小写差异 When 归一化 Then Windows 下生成稳定小写键', () => {
    const key = normalizePathKey(resolve(rootPath, 'SRC/App.ts'))
    expect(key.endsWith('/src/app.ts')).toBe(process.platform === 'win32')
    expect(key.includes('\\')).toBe(false)
  })

  test('Given 相对与绝对工具路径 When 解析 Then 都得到根内绝对路径', () => {
    expect(resolveTargetPath(rootPath, 'src/app.ts')).toBe(resolve(rootPath, 'src/app.ts'))
    expect(resolveTargetPath(rootPath, resolve(rootPath, 'src/app.ts'))).toBe(resolve(rootPath, 'src/app.ts'))
  })

  test('Given 边界判断 When 目标是根内文件、根自身、根外路径 Then 分别判定', () => {
    expect(isPathInside(rootPath, resolve(rootPath, 'a/b.ts'))).toBe(true)
    expect(isPathInside(rootPath, rootPath)).toBe(true)
    expect(isPathInside(rootPath, resolve(rootPath, '..'))).toBe(false)
  })

  test('Given 展示相对路径 When 校验 Then 拒绝绝对路径、盘符与 .. 段', () => {
    expect(isSafeRelativePath('src/app.ts')).toBe(true)
    expect(isSafeRelativePath('../secret.txt')).toBe(false)
    expect(isSafeRelativePath('src/../../secret.txt')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:/Windows/win.ini')).toBe(false)
    expect(isSafeRelativePath('')).toBe(false)
  })

  test('Given 根与相对路径 When 拼接展示路径 Then 使用单个斜杠', () => {
    expect(joinDisplayPath('C:\\repo\\', 'src\\app.ts')).toBe('C:/repo/src/app.ts')
  })
})
