import { describe, expect, mock, test } from 'bun:test'

const order: string[] = []

mock.module('./browser-controller', () => ({
  browserController: {
    close: async (id: string) => { order.push(`browser:${id}`) },
  },
}))
mock.module('./terminal-service', () => ({
  closeTerminalsForSession: (id: string) => { order.push(`terminal:${id}`) },
}))
mock.module('./agent-session-manager', () => ({
  getAgentSessionMeta: (id: string) => ({
    id,
    title: 'fixture',
    attachedFiles: ['/tmp/files/a.md', '/tmp/files/b.md'],
    attachedDirectories: ['/tmp/dir-1', '/tmp/dir-1', '/tmp/dir-2'],
    createdAt: 1,
    updatedAt: 1,
  }),
  deleteAgentSession: (id: string) => { order.push(`delete:${id}`) },
}))
mock.module('./agent-service', () => ({
  stopAgentAndDrain: async (id: string) => { order.push(`stop:${id}`) },
  clearAgentQueuedMessages: (id: string) => { order.push(`queue:${id}`) },
}))
mock.module('./agent-ask-user-service', () => ({
  askUserService: { clearSessionPending: (id: string) => { order.push(`ask:${id}`) } },
}))
mock.module('./agent-exit-plan-service', () => ({
  exitPlanService: { clearSessionPending: (id: string) => { order.push(`exit-plan:${id}`) } },
}))
mock.module('./agent-permission-service', () => ({
  permissionService: {
    clearSessionWhitelist: (id: string) => { order.push(`permission-whitelist:${id}`) },
    clearSessionPending: (id: string) => { order.push(`permission-pending:${id}`) },
  },
}))
mock.module('./agent-attachment-watcher-release', () => ({
  releaseAttachedFileWatchers: (files: readonly string[] | undefined) => {
    order.push(`release-files:${(files ?? []).join(',')}`)
  },
  releaseDirectoryWatcherIfUnreferenced: (directory: string) => {
    order.push(`release-dir:${directory}`)
  },
}))

describe('Agent 会话删除资源清理', () => {
  test('Given 会话含附件与目录 When 删除 Then 按 tombstone→清理→关闭→删除→监听顺序执行', async () => {
    order.length = 0
    const { deleteAgentSessionWithRuntimeResources } = await import('./agent-session-deletion-service')
    await deleteAgentSessionWithRuntimeResources('session-1')
    expect(order).toEqual([
      'stop:session-1',
      'permission-whitelist:session-1',
      'permission-pending:session-1',
      'ask:session-1',
      'exit-plan:session-1',
      'queue:session-1',
      'browser:session-1',
      'terminal:session-1',
      'delete:session-1',
      'release-files:/tmp/files/a.md,/tmp/files/b.md',
      'release-dir:/tmp/dir-1',
      'release-dir:/tmp/dir-2',
    ])
  })

  test('Given drain 抛错 When 删除 Then 后续资源清理不执行', async () => {
    order.length = 0
    const { deleteAgentSessionWithRuntimeResources } = await import('./agent-session-deletion-service')
    await expect(deleteAgentSessionWithRuntimeResources('session-2', {
      stopAgentAndDrain: async () => { throw new Error('drain failed') },
    })).rejects.toThrow('drain failed')
    expect(order).toEqual([])
  })
})
