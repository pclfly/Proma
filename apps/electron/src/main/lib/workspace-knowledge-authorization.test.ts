import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { rmSyncWithRetry } from './fs-retry'

let root = ''
let workspaceId: string | undefined = 'workspace-one'
let destroyed = false
let actorValid = true
let picked: { canceled: boolean; filePaths: string[] }
let confirmed = 0
let beforeReply: () => void | Promise<void> = () => {}
let pickerCalls = 0
let confirmationCalls = 0
let confirmationOptions: unknown
let attaches: Array<{ slug: string; path: string }> = []
mock.module('electron', () => ({ dialog: {
  showOpenDialog: async (..._args: unknown[]) => { pickerCalls++; await beforeReply(); return picked },
  showMessageBox: async (...args: unknown[]) => { confirmationCalls++; confirmationOptions = args.at(-1); await beforeReply(); return { response: confirmed } },
}, BrowserWindow: class {} }))
mock.module('./agent-workspace-manager', () => ({ getKnownKnowledgeWorkspace: (slug: string) => {
  if (slug !== 'fixture' || !workspaceId) throw new Error('未知工作区')
  return { id: workspaceId, slug, name: 'fixture' }
} }))
const { authorizeWorkspaceKnowledgeDirectory, confirmWorkspaceDirectoryAttachment } = await import('./workspace-knowledge-authorization')
const parent = { isDestroyed: () => destroyed } as unknown as BrowserWindow
const attach = (slug: string, path: string): string[] => { attaches.push({ slug, path }); return ['existing', path] }
const validateActor = (): void => { if (!actorValid) throw new Error('actor已变化') }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'proma-native-grant-'))
  mkdirSync(join(root, 'selected'))
  workspaceId = 'workspace-one'; destroyed = false; actorValid = true
  picked = { canceled: false, filePaths: [join(root, 'selected')] }
  confirmed = 0; pickerCalls = 0; confirmationCalls = 0; beforeReply = () => {}; attaches = []; confirmationOptions = undefined
})
afterEach(() => { rmSyncWithRetry(root, { recursive: true, force: true }) })

describe('目录授权的原生意图与等待期间身份', () => {
  test('Given main picker返回目录 When 用户确认 Then 持久化canonical路径并返回实际目录列表', async () => {
    const result = await authorizeWorkspaceKnowledgeDirectory('fixture', parent, attach, validateActor)
    const path = realpathSync(join(root, 'selected'))
    expect(result).toEqual({ status: 'authorized', path, directories: ['existing', path] })
    expect(attaches).toEqual([{ slug: 'fixture', path }])
  })
  test('Given 用户选中目录别名 When 明确授权 Then 记录真实目录而非别名', async () => {
    const alias = join(root, 'alias')
    symlinkSync(join(root, 'selected'), alias, 'junction')
    picked.filePaths = [alias]
    const result = await authorizeWorkspaceKnowledgeDirectory('fixture', parent, attach, validateActor)
    expect(result.path).toBe(realpathSync(join(root, 'selected')))
    expect(attaches).toHaveLength(1)
  })
  test('Given 用户取消且路径不存在 When picker结束 Then 不检查该路径或写授权', async () => {
    picked = { canceled: true, filePaths: [join(root, 'does-not-exist')] }
    expect(await authorizeWorkspaceKnowledgeDirectory('fixture', parent, attach, validateActor)).toEqual({ status: 'cancelled' })
    expect(attaches).toEqual([])
  })
  test('Given 未知slug When 请求授权 Then 不打开picker也不创建工作区', async () => {
    await expect(authorizeWorkspaceKnowledgeDirectory('unknown', parent, attach, validateActor)).rejects.toThrow('未知工作区')
    expect(pickerCalls).toBe(0)
    expect(attaches).toEqual([])
  })
  test('Given 未登记actor When 发起授权 Then picker之前拒绝', async () => {
    actorValid = false
    await expect(authorizeWorkspaceKnowledgeDirectory('fixture', parent, attach, validateActor)).rejects.toThrow('actor')
    expect(pickerCalls).toBe(0)
  })
  for (const change of ['recreate', 'delete', 'destroy', 'actor'] as const) test(`Given picker等待时${change} When 确认 Then 读取路径前拒绝且零授权`, async () => {
    picked.filePaths = [join(root, 'does-not-exist')]
    beforeReply = () => {
      if (change === 'recreate') workspaceId = 'workspace-two'
      if (change === 'delete') workspaceId = undefined
      if (change === 'destroy') destroyed = true
      if (change === 'actor') actorValid = false
    }
    await expect(authorizeWorkspaceKnowledgeDirectory('fixture', parent, attach, validateActor)).rejects.toThrow(change === 'delete' ? '未知工作区' : change === 'actor' ? 'actor' : '窗口或工作区已变化')
    expect(attaches).toEqual([])
  })
  test('Given picker返回文件而非目录 When 确认 Then 不附加文件或其父目录', async () => {
    const file = join(root, 'file.md'); writeFileSync(file, 'fixture')
    picked.filePaths = [file]
    await expect(authorizeWorkspaceKnowledgeDirectory('fixture', parent, attach, validateActor)).rejects.toThrow('普通目录')
    expect(attaches).toEqual([])
  })
})

describe('既有renderer路径入口也需main原生确认', () => {
  test('Given 未确认的任意路径 When 请求附加 Then 默认取消且不读写该目录', async () => {
    expect(await confirmWorkspaceDirectoryAttachment('fixture', join(root, 'does-not-exist'), parent, attach, validateActor)).toEqual({ status: 'cancelled' })
    expect(confirmationCalls).toBe(1)
    expect(attaches).toEqual([])
    expect(confirmationOptions).toMatchObject({ buttons: ['取消', '授权访问'], defaultId: 0, cancelId: 0 })
  })
  test('Given 用户明确确认已有路径 When 附加 Then 返回canonical列表', async () => {
    confirmed = 1
    const result = await confirmWorkspaceDirectoryAttachment('fixture', join(root, 'selected'), parent, attach, validateActor)
    expect(result.directories).toEqual(['existing', realpathSync(join(root, 'selected'))])
    expect(attaches).toHaveLength(1)
  })
  for (const path of ['relative/path', 'C:relative', join(tmpdir(), `bad\u0000path`)]) test(`Given 非法路径${JSON.stringify(path)} When 请求 Then 确认窗口之前拒绝`, async () => {
    await expect(confirmWorkspaceDirectoryAttachment('fixture', path, parent, attach, validateActor)).rejects.toThrow('绝对路径')
    expect(confirmationCalls).toBe(0)
    expect(attaches).toEqual([])
  })
  test('Given 原生确认期间同slug重建 When 确认 Then 不给新工作区授权', async () => {
    confirmed = 1; beforeReply = () => { workspaceId = 'workspace-two' }
    await expect(confirmWorkspaceDirectoryAttachment('fixture', join(root, 'selected'), parent, attach, validateActor)).rejects.toThrow('工作区已变化')
    expect(attaches).toEqual([])
  })
  test('Given 原生确认期间actor失效 When 确认 Then 不访问调用方提供的路径', async () => {
    confirmed = 1; beforeReply = () => { actorValid = false }
    await expect(confirmWorkspaceDirectoryAttachment('fixture', join(root, 'missing'), parent, attach, validateActor)).rejects.toThrow('actor')
    expect(attaches).toEqual([])
  })
})
