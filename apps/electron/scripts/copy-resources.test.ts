import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSyncWithRetry } from '../src/main/lib/fs-retry'
import { copyElectronResources } from './copy-resources'

describe('跨平台Electron资源复制', () => {
  test('Given 启动页/图标/CLI与已存在输出 When 复制两次 Then 完整合并更新而不吞资源', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-build-resources-'))
    try {
      mkdirSync(join(root, 'resources', 'startup-splash'), { recursive: true })
      mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
      mkdirSync(join(root, 'dist', 'resources'), { recursive: true })
      writeFileSync(join(root, 'resources', 'startup-splash', 'index.html'), '<html>fixture</html>')
      writeFileSync(join(root, 'resources', 'icon.svg'), '<svg/>')
      writeFileSync(join(root, 'resources', 'bin', 'proma.exe'), Buffer.from([1, 2, 3]))
      writeFileSync(join(root, 'dist', 'resources', 'unrelated'), 'keep')
      copyElectronResources(root)
      expect(readFileSync(join(root, 'dist', 'resources', 'startup-splash', 'index.html'), 'utf8')).toBe('<html>fixture</html>')
      expect(readFileSync(join(root, 'dist', 'resources', 'bin', 'proma.exe'))).toEqual(Buffer.from([1, 2, 3]))
      writeFileSync(join(root, 'resources', 'icon.svg'), '<svg>updated</svg>')
      copyElectronResources(root)
      expect(readFileSync(join(root, 'dist', 'resources', 'icon.svg'), 'utf8')).toBe('<svg>updated</svg>')
      expect(readFileSync(join(root, 'dist', 'resources', 'unrelated'), 'utf8')).toBe('keep')
    } finally { rmSyncWithRetry(root, { recursive: true, force: true }) }
  })

  test('Given 输入资源缺失 When 构建 Then 明确失败且不制造成功输出', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-build-missing-'))
    try {
      expect(() => copyElectronResources(root)).toThrow()
      expect(existsSync(join(root, 'dist'))).toBe(false)
    } finally { rmSyncWithRetry(root, { recursive: true, force: true }) }
  })

  test('Given 目标被普通文件阻塞 When 构建 Then 抛错而非吞失败或覆盖无关文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-build-blocked-'))
    try {
      mkdirSync(join(root, 'resources')); mkdirSync(join(root, 'dist'))
      writeFileSync(join(root, 'resources', 'icon.svg'), '<svg/>')
      writeFileSync(join(root, 'dist', 'resources'), 'keep')
      expect(() => copyElectronResources(root)).toThrow()
      expect(readFileSync(join(root, 'dist', 'resources'), 'utf8')).toBe('keep')
    } finally { rmSyncWithRetry(root, { recursive: true, force: true }) }
  })
})
