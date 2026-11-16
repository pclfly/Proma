import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AgentSessionMeta, AgentStreamPayload, SkillMeta, WorkspaceCapabilities } from '@proma/shared'

interface SessionFixture {
  id: string
  title: string
  workspaceId?: string
  channelId?: string
  modelId?: string
}

const state = {
  sessions: new Map<string, SessionFixture>(),
  workspaces: [
    { id: 'ws-1', name: '项目一', slug: 'one' },
    { id: 'ws-2', name: '项目二', slug: 'two' },
  ] as Array<{ id: string; name: string; slug: string }>,
  settings: {
    agentChannelId: 'ch-1' as string | undefined,
    agentWorkspaceId: 'ws-1' as string | undefined,
    agentModelId: 'model-1' as string | undefined,
  },
  activeSessions: new Set<string>(),
  sent: [] as Array<{ chatId: string; text: string; meta?: unknown }>,
  headlessInputs: [] as Array<Record<string, unknown>>,
  headlessOptions: undefined as undefined | {
    onError: (error: string) => void
    onComplete: () => void
    onTitleUpdated: () => void
  },
  eventHandlers: new Set<(sessionId: string, payload: AgentStreamPayload) => void>(),
  persisted: [] as Array<{ chatId: string; sessionId: string; workspaceId: string; channelId: string; modelId?: string }>,
  stopped: [] as string[],
  sessionSequence: 0,
}

const channels = [
  {
    id: 'ch-1',
    name: '渠道一',
    models: [{ id: 'model-1', name: '模型一' }, { id: 'model-2', name: '模型二' }],
  },
  {
    id: 'ch-2',
    name: '渠道二',
    models: [{ id: 'model-3', name: '模型三' }],
  },
]

function resetState(): void {
  state.sessions.clear()
  state.settings = { agentChannelId: 'ch-1', agentWorkspaceId: 'ws-1', agentModelId: 'model-1' }
  state.activeSessions.clear()
  state.sent = []
  state.headlessInputs = []
  state.headlessOptions = undefined
  state.eventHandlers.clear()
  state.persisted = []
  state.stopped = []
  state.sessionSequence = 0
}

mock.module('./main-window-store', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { send: () => undefined },
  }),
}))

mock.module('./bridge-workspace-resolution', () => ({
  resolveBridgeWorkspace: ({ candidates, exists }: {
    candidates: Array<string | undefined>
    exists: (id: string) => boolean
  }) => {
    const workspaceId = candidates.find((candidate) => candidate && exists(candidate))
    return workspaceId
      ? { ok: true, workspaceId }
      : { ok: false, reason: 'missing', candidates: candidates.filter(Boolean) }
  },
  describeBridgeWorkspaceFailure: () => '当前项目不可用',
}))

mock.module('./agent-session-manager', () => ({
  createAgentSession: (title: string | undefined, channelId: string, workspaceId?: string) => {
    state.sessionSequence += 1
    const session: SessionFixture = {
      id: `session-${state.sessionSequence}`,
      title: title || '新会话',
      workspaceId,
      channelId,
      modelId: 'model-1',
    }
    state.sessions.set(session.id, session)
    return session
  },
  listAgentSessions: () => [...state.sessions.values()],
  getAgentSessionMeta: (id: string) => state.sessions.get(id) as unknown as AgentSessionMeta | undefined,
}))

mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspacesByUpdatedAt: () => state.workspaces,
  getAgentWorkspace: (id: string) => state.workspaces.find((workspace) => workspace.id === id),
  getProjectFilesPath: (slug: string) => `/project/${slug}`,
  getWorkspaceCapabilities: (): WorkspaceCapabilities => ({
    mcpServers: [],
    skills: [] as SkillMeta[],
  }) as unknown as WorkspaceCapabilities,
}))

mock.module('./agent-service', () => ({
  runAgentHeadless: (input: Record<string, unknown>, options: typeof state.headlessOptions) => {
    state.headlessInputs.push(input)
    state.headlessOptions = options
    return Promise.resolve()
  },
  agentEventBus: {
    on: (handler: (sessionId: string, payload: AgentStreamPayload) => void) => {
      state.eventHandlers.add(handler)
      return () => state.eventHandlers.delete(handler)
    },
  },
  stopAgent: (sessionId: string) => {
    state.stopped.push(sessionId)
  },
  isAgentSessionActive: (sessionId: string) => state.activeSessions.has(sessionId),
}))

mock.module('./settings-service', () => ({
  getSettings: () => state.settings,
}))

mock.module('./bridge-attachment-utils', () => ({
  buildAttachedFilesBlock: (files: Array<{ label: string; path: string }>) =>
    `<attached_files>\n${files.map((file) => `- ${file.label}: ${file.path}`).join('\n')}\n</attached_files>\n\n`,
  buildSessionFileTree: () => ['session.txt'],
  buildFileTree: () => ['index.html'],
}))

mock.module('./bridge-model-utils', () => ({
  listSwitchableChannels: () => channels,
  getEnabledModels: (channel: typeof channels[number]) => channel.models,
  resolveChannelByIndex: (index: number) => channels[index - 1],
  resolveModelByIndex: (channel: typeof channels[number], index: number) => channel.models[index - 1],
  describeBindingModel: (channelId?: string, modelId?: string) => {
    const channel = channels.find((item) => item.id === channelId)
    const model = channel?.models.find((item) => item.id === modelId)
    return {
      channelName: channel?.name ?? '未知渠道',
      modelName: model?.name ?? '未知模型',
      valid: Boolean(channel && model),
    }
  },
}))

mock.module('./bridge-workspace-switch', () => ({
  BridgeWorkspaceSwitchError: class BridgeWorkspaceSwitchError extends Error {},
  commitBridgeWorkspaceSwitch: async () => undefined,
}))

mock.module('./bridge-agent-message-utils', () => ({
  extractFinalAssistantText: (message: { message?: { content?: Array<{ type: string; text?: string }> } }) =>
    (message.message?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join(''),
}))

mock.module('./bridge-log-redaction', () => ({
  redactSensitiveLogText: (value: string) => value,
  redactSensitiveLogValue: (value: unknown) => String(value),
}))

const { BridgeCommandHandler } = await import('./bridge-command-handler')

function createHandler(initialBindings: typeof state.persisted = []) {
  state.persisted = [...initialBindings]
  return new BridgeCommandHandler({
    platformName: '测试',
    adapter: {
      sendText: async (chatId, text, meta) => {
        state.sent.push({ chatId, text, meta })
      },
    },
    bindingStore: {
      load: () => [...state.persisted],
      save: (bindings: typeof state.persisted) => {
        state.persisted = [...bindings]
      },
      workspaceSwitchJournal: undefined,
    } as never,
  })
}

function seedSession(id = 'session-existing'): void {
  state.sessions.set(id, {
    id,
    title: '已有会话',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    modelId: 'model-1',
  })
}

function lastText(): string {
  return state.sent.at(-1)?.text ?? ''
}

describe('Bridge 命令处理器', () => {
  beforeEach(resetState)

  test('Given /help When 处理 Then 返回命令列表且不创建会话', async () => {
    const handler = createHandler()
    const handled = await handler.handleIncomingMessage('chat-help', '/help')
    expect(handled).toBe(false)
    expect(lastText()).toContain('/workspace')
    expect(lastText()).toContain('/model')
    expect(state.sessions.size).toBe(0)
  })

  test('Given 未配置渠道 When ensureBinding Then 返回 null 并提示配置', async () => {
    state.settings.agentChannelId = undefined
    const handler = createHandler()
    expect(handler.ensureBinding('chat-1')).toBeNull()
    const handled = await handler.handleIncomingMessage('chat-1', '你好')
    expect(handled).toBe(false)
    expect(lastText()).toContain('Agent 渠道')
  })

  test('Given 渠道与项目有效 When 普通消息 Then 创建绑定并调用 headless', async () => {
    const handler = createHandler()
    const handled = await handler.handleIncomingMessage('chat-1', '你好')
    expect(handled).toBe(true)
    expect(state.sessions.size).toBe(1)
    expect(state.headlessInputs).toHaveLength(1)
    expect(state.headlessInputs[0]).toMatchObject({
      channelId: 'ch-1',
      modelId: 'model-1',
      workspaceId: 'ws-1',
      userMessage: '你好',
      permissionModeOverride: 'bypassPermissions',
    })
    expect(state.persisted[0]?.chatId).toBe('chat-1')
    expect(lastText()).toContain('Agent 处理中')
  })

  test('Given 附件 When 普通消息 Then 注入 attached_files 且保留原始文本', async () => {
    const handler = createHandler()
    await handler.handleIncomingMessage('chat-1', '', undefined, [
      { absolutePath: 'C:/tmp/a.png', label: 'a.png', kind: 'image' },
    ])
    const input = state.headlessInputs[0]
    expect(String(input?.userMessage)).toContain('<attached_files>')
    expect(String(input?.userMessage)).toContain('a.png')
    expect(String(input?.userMessage)).toContain('请查看上面附加的文件')
    expect(String(input?.rawUserMessage)).toBe(String(input?.userMessage))
  })

  test('Given Agent 回复事件 When assistant/result Then 发送汇总文本并清理缓冲', async () => {
    seedSession('session-existing')
    const handler = createHandler([{
      chatId: 'chat-1', sessionId: 'session-existing', workspaceId: 'ws-1', channelId: 'ch-1', modelId: 'model-1',
    }])
    handler.subscribe()
    await handler.handleIncomingMessage('chat-1', '继续')
    for (const eventHandler of state.eventHandlers) {
      eventHandler('session-existing', {
        kind: 'sdk_message',
        message: { type: 'assistant', message: { content: [{ type: 'text', text: '回答内容' }] } },
      } as unknown as AgentStreamPayload)
      eventHandler('session-existing', {
        kind: 'sdk_message',
        message: { type: 'result' },
      } as unknown as AgentStreamPayload)
    }
    expect(lastText()).toBe('回答内容')
    expect(handler.isSessionActive('chat-1')).toBe(false)
  })

  test('Given 会话运行中 When 再发消息 Then 拒绝且不覆盖 buffer', async () => {
    seedSession('session-existing')
    state.activeSessions.add('session-existing')
    const handler = createHandler([{
      chatId: 'chat-1', sessionId: 'session-existing', workspaceId: 'ws-1', channelId: 'ch-1', modelId: 'model-1',
    }])
    const handled = await handler.handleIncomingMessage('chat-1', '再试一次')
    expect(handled).toBe(false)
    expect(lastText()).toContain('上一条消息仍在处理中')
    expect(state.headlessInputs).toHaveLength(0)
  })

  test('Given 多个项目会话 When /list Then 按项目分组并标记当前', async () => {
    seedSession('session-existing')
    state.sessions.set('session-other', {
      id: 'session-other', title: '另一个', workspaceId: 'ws-2', channelId: 'ch-1', modelId: 'model-1',
    })
    const handler = createHandler([{
      chatId: 'chat-1', sessionId: 'session-existing', workspaceId: 'ws-1', channelId: 'ch-1', modelId: 'model-1',
    }])
    await handler.handleIncomingMessage('chat-1', '/list')
    expect(lastText()).toContain('【项目一】')
    expect(lastText()).toContain('【项目二】')
    expect(lastText()).toContain('← 当前')
    expect(lastText()).toContain('使用 /switch <序号> 切换会话')
  })

  test('Given 已绑定会话 When /stop Then 调用 stopAgent', async () => {
    seedSession('session-existing')
    const handler = createHandler([{
      chatId: 'chat-1', sessionId: 'session-existing', workspaceId: 'ws-1', channelId: 'ch-1', modelId: 'model-1',
    }])
    await handler.handleIncomingMessage('chat-1', '/stop')
    expect(state.stopped).toEqual(['session-existing'])
    expect(lastText()).toContain('已停止 Agent')
  })

  test('Given 持久化绑定指向已删除会话 When 读取 Then 拒绝并引导 /workspace', async () => {
    const handler = createHandler([{
      chatId: 'chat-1', sessionId: 'gone', workspaceId: 'ws-1', channelId: 'ch-1', modelId: 'model-1',
    }])
    expect(handler.getBinding('chat-1')).toBeUndefined()
    const handled = await handler.handleIncomingMessage('chat-1', '你好')
    expect(handled).toBe(false)
    expect(lastText()).toContain('/workspace')
  })

  test('Given 已有绑定 When /model 2 1 Then 更新 per-chat 渠道和模型', async () => {
    seedSession('session-existing')
    const handler = createHandler([{
      chatId: 'chat-1', sessionId: 'session-existing', workspaceId: 'ws-1', channelId: 'ch-1', modelId: 'model-1',
    }])
    await handler.handleIncomingMessage('chat-1', '/model 2 1')
    expect(handler.getBinding('chat-1')).toMatchObject({ channelId: 'ch-2', modelId: 'model-3' })
    expect(state.persisted[0]).toMatchObject({ chatId: 'chat-1', channelId: 'ch-2', modelId: 'model-3' })
    expect(lastText()).toContain('已切换模型')
  })

  test('Given 未知命令 When 处理 Then 提示 /help', async () => {
    const handler = createHandler()
    await handler.handleIncomingMessage('chat-1', '/wat')
    expect(lastText()).toContain('未知命令')
  })
})
