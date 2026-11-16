import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentAttachmentAccess, readVerifiedAgentFile } from './agent-attachment-access'

function setup(options: { deleting?: boolean; workspaceId?: string } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'proma-attach-'))
  const sessionDir = join(configDir, 'agent-workspaces', 'ws', 'sess')
  mkdirSync(sessionDir, { recursive: true })
  const filePath = join(sessionDir, 'file.txt')
  writeFileSync(filePath, 'hello', 'utf8')
  const access = createAgentAttachmentAccess({
    configDir,
    getAgentSession: (id) => id === 'sess' ? { id: 'sess', workspaceId: options.workspaceId ?? 'w1' } : undefined,
    isAgentSessionDeleting: () => options.deleting ?? false,
    getWorkspace: (id) => id === 'w1' ? { id: 'w1', slug: 'ws' } : undefined,
  })
  return { configDir, filePath, access, cleanup: () => rmSync(configDir, { recursive: true, force: true }) }
}

describe('Agent 附件访问控制', () => {
  test('Given 合法会话工作台附件 When 解析 Then 返回真实路径', () => {
    const { filePath, access, cleanup } = setup()
    try {
      expect(access.resolveAgentAttachmentPath(filePath)).toBe(filePath)
    } finally {
      cleanup()
    }
  })

  test('Given 路径越界或含 .. When 解析 Then 拒绝', () => {
    const { configDir, access, cleanup } = setup()
    try {
      expect(() => access.resolveAgentAttachmentPath(join(configDir, 'outside.txt'))).toThrow('不在 Agent 工作台中')
      expect(() => access.resolveAgentAttachmentPath(join(configDir, 'agent-workspaces', 'ws', 'sess', '..', 'x.txt'))).toThrow()
      expect(() => access.resolveAgentAttachmentPath('relative.txt')).toThrow('绝对路径')
    } finally {
      cleanup()
    }
  })

  test('Given 会话不存在/删除中/工作区不匹配 When 解析 Then 拒绝', () => {
    const missing = setup({ workspaceId: 'other' })
    try {
      expect(() => missing.access.resolveAgentAttachmentPath(missing.filePath)).toThrow('工作台归属无效')
    } finally {
      missing.cleanup()
    }
    const deleting = setup({ deleting: true })
    try {
      expect(() => deleting.access.resolveAgentAttachmentPath(deleting.filePath)).toThrow('未删除中')
    } finally {
      deleting.cleanup()
    }
  })

  test('Given 合法文件 When 校验读取 Then 返回内容；verify 失败时不返回', () => {
    const { filePath, cleanup } = setup()
    try {
      expect(readVerifiedAgentFile(filePath, () => {}).toString('utf8')).toBe('hello')
      expect(() => readVerifiedAgentFile(filePath, () => { throw new Error('revoked') })).toThrow('revoked')
    } finally {
      cleanup()
    }
  })
})
