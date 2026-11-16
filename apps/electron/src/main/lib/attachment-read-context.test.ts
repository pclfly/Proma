import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createAttachmentContextResolver } from './attachment-read-context'

describe('Agent 附件读取上下文', () => {
  const resolver = createAttachmentContextResolver({
    configDir: () => '/config',
    resolvePath: (localPath) => localPath,
  })

  test('Given 当前会话工作台附件 When 解析 Then 通过', () => {
    const path = join('/config', 'agent-workspaces', 'ws', 'sess', 'file.txt')
    expect(resolver(path, { kind: 'agent', sessionId: 'sess' })).toBe(path)
  })

  test('Given 其他会话或非法上下文 When 解析 Then 拒绝', () => {
    const path = join('/config', 'agent-workspaces', 'ws', 'sess', 'file.txt')
    expect(() => resolver(path, { kind: 'agent', sessionId: 'other' })).toThrow('不属于当前 Agent 会话')
    expect(() => resolver(path, undefined)).toThrow('有效 Agent 会话')
    expect(() => resolver('relative.txt', { kind: 'agent', sessionId: 'sess' })).toThrow('有效 Agent 会话')
  })
})
