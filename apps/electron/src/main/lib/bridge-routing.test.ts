import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import type { BridgeAttachment, BridgeChatBinding, BridgeCommandHandlerConfig } from './bridge-command-handler'
import type { FeishuUpdateBindingInput } from '@proma/shared'
import { WECHAT_ITEM_TYPE, WECHAT_MESSAGE_STATE, WECHAT_MESSAGE_TYPE } from '@proma/shared'

// VM载入原样生产TS类，仅替换依赖；不启动Electron、IM、provider或真实配置。
interface TestSession { id: string; workspaceId: string; title: string; channelId?: string }
interface TestWorkspace { id: string; name: string; slug: string }
interface TestBinding extends BridgeChatBinding { archived?: boolean }
interface GenericHandler {
  handleIncomingMessage(chatId: string, text: string, meta?: unknown, files?: BridgeAttachment[]): Promise<boolean>
  ensureBinding(chatId: string): BridgeChatBinding | null
  getBinding(chatId: string): BridgeChatBinding | undefined
  chatBindings: Map<string, BridgeChatBinding>
  rejectedBindings: Map<string, BridgeChatBinding>
  sessionToChat: Map<string, string>
  sessionBuffers: Map<string, unknown>
  config: BridgeCommandHandlerConfig
}
interface MediaImage { id: string; mediaType: string; data: Buffer }
interface MediaFile { id: string; fileName: string; data: Buffer }
interface DingTalkHandler {
  commandHandler: GenericHandler
  botConfig: { defaultWorkspaceId?: string }
  pendingImages: Map<string, { images: MediaImage[]; createdAt: number }>
  processRobotMessage(message: unknown): Promise<void>
}
interface WeChatHandler {
  pendingImages: Map<string, { images: MediaImage[]; createdAt: number }>
  pendingFiles: Map<string, { files: MediaFile[]; createdAt: number }>
  handleMessage(message: unknown): Promise<void>
}
interface FeishuHandler {
  chatBindings: Map<string, TestBinding>
  rejectedBindings: Map<string, TestBinding>
  sessionToChat: Map<string, string>
  sessionBuffers: Map<string, unknown>
  streamingCards: Map<string, unknown>
  pendingImages: Map<string, Array<{ imageKey: string; mediaType: string; data: Buffer; receivedAt?: number }>>
  pendingFiles: Map<string, Array<{ fileKey: string; fileName: string; data: Buffer; receivedAt?: number }>>
  client?: unknown
  messageQueue: { push(scope: string, payload: unknown): number }
  handleFeishuMessage(data: Record<string, unknown>): Promise<void>
  runMergedBatch(scope: string, batch: unknown[]): Promise<void>
  loadBindings(): void
  createNewSession(context: unknown): Promise<void>
  findBindingBySessionId(id: string): TestBinding | undefined
  handleAgentPayload(id: string, payload: unknown): void
  handleWorkspaceCommand(context: unknown, arg: string): Promise<void>
  handleUserMessage(context: unknown, text: string): Promise<void>
  updateBinding(input: FeishuUpdateBindingInput): TestBinding | null
  handleSwitchCommand(context: unknown, arg: string): Promise<void>
  quarantineBindingsForDeletedWorkspace(workspaceId: string, sessionIds: ReadonlySet<string>): number
}
interface SlackBinding { key: string; sessionId: string; workspaceId: string }
interface SlackHandler {
  bindings: Map<string, SlackBinding>
  activeRuns: Map<string, unknown>
  rejectedBindings: Map<string, SlackBinding>
  loadBindings(): void
  getOrCreateBinding(message: unknown, thread: string): SlackBinding
  runAgentForMessage(binding: SlackBinding, message: unknown): Promise<void>
  postThinking(): Promise<string | undefined>
}
interface Fixture {
  ws: Map<string, TestWorkspace>
  sessions: Map<string, TestSession>
  created: TestSession[]
  runs: Array<[{ workspaceId: string; sessionId: string; permissionModeOverride?: string; userMessage: string; rawUserMessage?: string }, ...unknown[]]>
  persisted: BridgeChatBinding[]
  fileBindings: unknown[]
  saved: unknown[]
  sent: Array<{ text?: string; card?: unknown }>
  defaults: string | undefined
  diskDefault?: string
  settings: { agentChannelId?: string; agentWorkspaceId?: string }
  configFailure: Error | null
  bindingFailure: boolean | 'once'
  mediaFailure: boolean
  mediaFailureHook?: () => boolean
  mediaSaves: Array<{ hint: string }>
  mediaAttempts?: number
  journalPending: boolean
  agentDeps: { runAgentHeadless: (...args: unknown[]) => Promise<void> }
  closedCards?: number
  onSend?: (text: string) => void | Promise<void>
  onCardOpen?: () => void | Promise<void>
  binding(session?: string): TestBinding
  generic(options?: Partial<BridgeCommandHandlerConfig>): GenericHandler
  dingtalk(): DingTalkHandler
  wechat(): WeChatHandler
  feishu(): FeishuHandler
  slack(): SlackHandler
  manager(platform: 'feishu' | 'dingtalk'): { removeBindingsForDeletedWorkspace(workspaceId: string, sessions: string[]): number }
}
const fixtureModule: unknown = createRequire(import.meta.url)('./bridge-routing.fixture.cjs')
const { fixture } = fixtureModule as { fixture(): Fixture }
const context = { chatId: 'im-chat', senderOpenId: 'fixture-user', chatType: 'p2p' }
const slackMessage = { teamId: 'T', channelId: 'C', userId: 'U', ts: '1', eventId: 'E', text: 'hello', mentioned: true }
function dingText(text = 'hello'): unknown {
  return { headers: { messageId: 'fixture-message' }, data: JSON.stringify({ conversationId: 'im-chat', msgtype: 'text', text: { content: text }, sessionWebhook: 'https://invalid.invalid' }) }
}
function wechatText(text = 'hello'): unknown {
  return { from_user_id: 'im-chat', message_type: WECHAT_MESSAGE_TYPE.USER, message_state: WECHAT_MESSAGE_STATE.FINISH,
    context_token: 'fixture-token', message_id: 'fixture-message', item_list: [{ type: WECHAT_ITEM_TYPE.TEXT, text_item: { text } }] }
}
function seedFeishu(f: Fixture): FeishuHandler {
  const h = f.feishu()
  h.chatBindings.set('im-chat', f.binding())
  h.sessionToChat.set('old', 'im-chat')
  return h
}

describe('飞书附件失败不丢掉实际调度引用', () => {
  interface Queued { imageAttachments: unknown[]; fileAttachments: unknown[] }
  function feishuText(text = 'inspect the attached image'): Record<string, unknown> {
    return { event_id: `fixture-event-${text}`, sender: { sender_type: 'user', sender_id: { open_id: 'fixture-user' } },
      message: { message_id: `fixture-message-${text}`, chat_id: 'im-chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } }
  }
  async function ingressThenFlush(h: FeishuHandler, text: string): Promise<Queued> {
    let queued: Queued | undefined
    h.messageQueue.push = (_scope, payload) => { queued = payload as Queued; return 1 }
    await h.handleFeishuMessage(feishuText(text))
    expect(queued).toBeDefined()
    await h.runMergedBatch('im-chat', [queued])
    return queued!
  }

  test('Given 图片保存失败 When 实际ingress→queue→batch Then 不调度无图文字并保留原TTL', async () => {
    const f = fixture(); f.fileBindings = [f.binding()]
    const h = seedFeishu(f); h.client = {}
    const createdAt = Date.now() - 1000
    h.pendingImages.set('im-chat', [{ imageKey: 'image', mediaType: 'image/png', data: Buffer.from('fixture'), receivedAt: createdAt }])
    f.mediaFailure = true
    const queued = await ingressThenFlush(h, 'inspect the attached image')
    expect(queued.imageAttachments).toHaveLength(1)
    expect(f.runs).toHaveLength(0)
    expect(f.mediaAttempts).toBe(1)
    expect(f.mediaSaves).toHaveLength(0)
    expect(h.pendingImages.get('im-chat')?.[0]?.receivedAt).toBe(createdAt)
    expect(f.sent.at(-1)?.text).toContain('重新发送文字消息重试')
  })

  test('Given 修复后重试 Then 已落盘部分不重存、只调度一次且带附件引用', async () => {
    const f = fixture(); f.fileBindings = [f.binding()]
    const h = seedFeishu(f); h.client = {}
    h.pendingImages.set('im-chat', [{ imageKey: 'image', mediaType: 'image/png', data: Buffer.from('fixture'), receivedAt: Date.now() }])
    f.mediaFailure = true
    await ingressThenFlush(h, 'first attempt')
    f.mediaFailure = false
    const queued = await ingressThenFlush(h, 'second attempt')
    expect(queued.imageAttachments).toHaveLength(1)
    expect(f.mediaAttempts).toBe(2)
    expect(f.mediaSaves).toHaveLength(1)
    expect(f.runs).toHaveLength(1)
    const agentMessage = String((f.runs[0]?.[0] as { userMessage?: string }).userMessage)
    expect(agentMessage).toContain('attached_files')
    expect(h.pendingImages.has('im-chat')).toBe(false)
  })

  test('Given 部分图片已保存但另一张失败 When 重试 Then 成功的那张不重复写盘', async () => {
    const f = fixture(); f.fileBindings = [f.binding()]
    const h = seedFeishu(f); h.client = {}
    h.pendingImages.set('im-chat', [
      { imageKey: 'first', mediaType: 'image/png', data: Buffer.from('a'), receivedAt: Date.now() },
      { imageKey: 'second', mediaType: 'image/png', data: Buffer.from('b'), receivedAt: Date.now() },
    ])
    let calls = 0
    f.mediaFailure = false
    // 第二张失败，第一张已成功落盘
    f.mediaFailureHook = () => { calls += 1; return calls === 2 }
    await ingressThenFlush(h, 'partial')
    expect(f.runs).toHaveLength(0)
    expect(f.mediaAttempts).toBe(2)
    expect(f.mediaSaves).toHaveLength(1)
    f.mediaFailureHook = undefined
    await ingressThenFlush(h, 'retry')
    expect(f.mediaAttempts).toBe(3)
    expect(f.mediaSaves).toHaveLength(2)
    expect(f.runs).toHaveLength(1)
    expect(h.pendingImages.has('im-chat')).toBe(false)
  })
})

describe('桥接回合资源所有权', () => {
  test('Given 调度在回调前reject When 再次发送 Then 清除旧buffer并可重试', async () => {
    const f = fixture(); f.persisted = [f.binding()]
    let attempts = 0
    f.agentDeps.runAgentHeadless = async () => { attempts++; throw new Error('dispatch rejected') }
    const h = f.generic()
    expect(await h.handleIncomingMessage('im-chat', 'first')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sessionBuffers.size).toBe(0)
    f.agentDeps.runAgentHeadless = async () => { attempts++ }
    expect(await h.handleIncomingMessage('im-chat', 'retry')).toBe(true)
    expect(attempts).toBe(2)
  })
  test('Given 旧reject或onError迟到 When buffer已被替换 Then 不清除新轮或给新轮发错误', async () => {
    const f = fixture(); f.persisted = [f.binding()]
    let reject: (error: Error) => void = () => { throw new Error('尚未开始') }
    let onError: (error: string) => void = () => { throw new Error('尚未开始') }
    f.agentDeps.runAgentHeadless = (...args) => {
      onError = (args[1] as { onError(error: string): void }).onError
      return new Promise<void>((_resolve, fail) => { reject = fail })
    }
    const h = f.generic(); await h.handleIncomingMessage('im-chat', 'first')
    const newer = { text: 'new buffer' }; h.sessionBuffers.set('old', newer)
    const replies = f.sent.length
    onError('old callback'); reject(new Error('old rejection'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sessionBuffers.get('old')).toBe(newer)
    expect(f.sent).toHaveLength(replies)
  })
  test('Given Slack两条有效恢复线程共用session When load Then 隔离所有歧义路由而不是覆盖run', () => {
    const f = fixture(); f.settings.agentWorkspaceId = 'A'; const original = f.slack()
    const first = original.getOrCreateBinding(slackMessage, '1')
    const second = original.getOrCreateBinding({ ...slackMessage, ts: '2' }, '2')
    f.fileBindings = [first, { ...second, sessionId: first.sessionId }]
    const restored = f.slack(); restored.loadBindings()
    expect(restored.bindings.size).toBe(0)
    expect(restored.rejectedBindings.size).toBe(2)
    expect(() => restored.getOrCreateBinding(slackMessage, '1')).toThrow()
    expect(() => restored.getOrCreateBinding({ ...slackMessage, ts: '2' }, '2')).toThrow()
    expect(f.runs).toHaveLength(0)
  })
})

describe('桥接消息保持首次目标与失败事务', () => {
  for (const change of ['delete', 'switch'] as const) test(`Given 确认await时${change} When 原消息继续 Then 不创建或运行另一项目`, async () => {
    const f = fixture(); f.persisted = [f.binding()]
    const h = f.generic()
    f.onSend = (text) => {
      if (!text.includes('处理中')) return
      if (change === 'delete') f.ws.delete('A')
      else h.chatBindings.set('im-chat', f.binding('valid'))
    }
    expect(await h.handleIncomingMessage('im-chat', 'private-A')).toBe(false)
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
  })

  test('Given 无绑定且唯一项目 When 普通消息 Then 只创建和运行一次Agent', async () => {
    const f = fixture(); f.ws.delete('B')
    expect(await f.generic().handleIncomingMessage('im-chat', 'hello')).toBe(true)
    expect(f.created).toHaveLength(1)
    expect(f.runs).toHaveLength(1)
    expect(f.runs[0]?.[0].workspaceId).toBe('A')
  })

  for (const mode of ['missing', 'ambiguous', 'stale'] as const) test(`Given ${mode}项目 When 首条消息 Then 不建孤儿会话`, async () => {
    const f = fixture()
    if (mode === 'missing') f.ws.clear()
    if (mode === 'stale') f.defaults = 'gone'
    expect(await f.generic().handleIncomingMessage('im-chat', 'hello')).toBe(false)
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
  })

  for (const asynchronous of [false, true]) test(`Given ${asynchronous ? '异步' : '同步'}项目保存失败 When 切换 Then 旧正反向绑定保持且不确认成功`, async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]
    const fail = (): never => { throw new Error('synthetic failure') }
    const h = f.generic({ onWorkspaceSwitched: asynchronous ? async () => fail() : fail })
    await h.handleIncomingMessage('im-chat', '/workspace b')
    expect(h.getBinding('im-chat')?.sessionId).toBe('old')
    expect(h.sessionToChat.get('old')).toBe('im-chat')
    expect(f.defaults).toBe('A')
    expect(f.sent.some((row) => row.text?.includes('✅'))).toBe(false)
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
  })

  test('Given 默认项目尚在保存 When 另一消息到达 Then 等待成功前不新建或误投A', async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]
    let release: () => void = () => { throw new Error('未开始') }
    const h = f.generic({ onWorkspaceSwitched: async (id) => { await new Promise<void>((done) => { release = done }); f.defaults = id } })
    const switching = h.handleIncomingMessage('im-chat', '/workspace b')
    await Promise.resolve()
    expect(await h.handleIncomingMessage('im-chat', 'during-switch')).toBe(false)
    expect(f.runs).toHaveLength(0)
    release(); await switching
    expect(f.sent.some((row) => row.text?.includes('已切换到项目: Project B'))).toBe(true)
    await h.handleIncomingMessage('im-chat', 'after-switch')
    expect(f.runs).toHaveLength(1)
    expect(f.runs[0]?.[0].workspaceId).toBe('B')
  })

  test('Given 绑定写失败 When 补偿 Then 保留旧索引和默认且不显示成功', async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]
    const h = f.generic({ onWorkspaceSwitched: (id) => { f.defaults = id } })
    f.bindingFailure = 'once'
    await h.handleIncomingMessage('im-chat', '/workspace b')
    expect(f.defaults).toBe('A')
    expect(h.getBinding('im-chat')?.sessionId).toBe('old')
    expect(h.sessionToChat.get('old')).toBe('im-chat')
    expect(f.journalPending).toBe(false)
    expect(f.sent.some((row) => row.text?.includes('✅'))).toBe(false)
  })

  test('Given 补偿失败及新handler重启 When 自动消息 Then pending继续阻断而非投到另一项目', async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]
    const h = f.generic({ onWorkspaceSwitched: (id) => { if (id === 'A') throw new Error('rollback failed'); f.defaults = id } })
    f.bindingFailure = 'once'
    await h.handleIncomingMessage('im-chat', '/workspace b')
    expect(f.journalPending).toBe(true)
    expect(await f.generic().handleIncomingMessage('im-chat', 'after-restart')).toBe(false)
    expect(f.runs).toHaveLength(0)
  })

  test('Given 已知失效旧chat及有效新默认 When 恢复后普通消息 Then 不静默重建到B', async () => {
    const f = fixture(); f.persisted = [f.binding()]; f.ws.delete('A'); f.defaults = 'B'
    const h = f.generic()
    expect(await h.handleIncomingMessage('im-chat', 'private-A')).toBe(false)
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
    await h.handleIncomingMessage('im-chat', '/switch valid')
    expect(await h.handleIncomingMessage('im-chat', 'explicit-B')).toBe(true)
    expect(f.runs[0]?.[0].workspaceId).toBe('B')
  })

  test('Given 真实钉钉异步callback保存失败 When workspace命令 Then 旧默认/索引保持且不返回成功', async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]; f.configFailure = new Error('disk failed')
    const h = f.dingtalk()
    await h.commandHandler.handleIncomingMessage('im-chat', '/workspace b')
    expect(h.botConfig.defaultWorkspaceId).toBe('A')
    expect(h.commandHandler.getBinding('im-chat')?.sessionId).toBe('old')
    expect(h.commandHandler.sessionToChat.get('old')).toBe('im-chat')
    expect(f.sent.some((row) => row.text?.includes('✅'))).toBe(false)
  })
})

describe('桥接附件仅在原目标接受后消费', () => {
  for (const platform of ['dingtalk', 'wechat'] as const) test(`Given ${platform}有效旧绑定但默认失效 When 图片加文字 Then 使用旧绑定并只保存/处理一次`, async () => {
    const f = fixture(); f.defaults = 'gone'; f.persisted = [f.binding()]
    const h = f[platform]()
    h.pendingImages.set('im-chat', { images: [{ id: 'image', mediaType: 'image/png', data: Buffer.from('fixture') }], createdAt: Date.now() })
    if (platform === 'dingtalk') await (h as DingTalkHandler).processRobotMessage(dingText())
    else await (h as WeChatHandler).handleMessage(wechatText())
    expect(f.runs).toHaveLength(1)
    expect(f.runs[0]?.[0].workspaceId).toBe('A')
    expect(f.mediaSaves).toHaveLength(1)
    expect(h.pendingImages.has('im-chat')).toBe(false)
  })

  for (const platform of ['dingtalk', 'wechat'] as const) test(`Given ${platform}工作区拒绝 When 修复后重试 Then 保留原媒体/TTL并只保存一次`, async () => {
    const f = fixture(); f.defaults = 'gone'
    const h = f[platform](); const createdAt = Date.now() - 1000
    h.pendingImages.set('im-chat', { images: [{ id: 'image', mediaType: 'image/png', data: Buffer.from('fixture') }], createdAt })
    if (platform === 'wechat') (h as WeChatHandler).pendingFiles.set('im-chat', { files: [{ id: 'file', fileName: 'a.txt', data: Buffer.from('file') }], createdAt })
    const dispatch = async (): Promise<void> => {
      if (platform === 'dingtalk') await (h as DingTalkHandler).processRobotMessage(dingText())
      else await (h as WeChatHandler).handleMessage(wechatText())
    }
    await dispatch()
    expect(h.pendingImages.get('im-chat')?.createdAt).toBe(createdAt)
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
    expect(f.sent.at(-1)?.text).not.toContain('选择 Agent 渠道')
    f.defaults = 'A'
    // 钉钉有自己的botConfig快照，模拟设置页完成配置更新。
    if (platform === 'dingtalk') (h as DingTalkHandler).botConfig.defaultWorkspaceId = 'A'
    await dispatch()
    expect(f.runs).toHaveLength(1)
    expect(f.mediaSaves).toHaveLength(platform === 'wechat' ? 2 : 1)
    expect(h.pendingImages.has('im-chat')).toBe(false)
    if (platform === 'wechat') expect((h as WeChatHandler).pendingFiles.has('im-chat')).toBe(false)
  })

  for (const platform of ['dingtalk', 'wechat'] as const) test(`Given ${platform}确认期间目标失效 When 重发到原项目 Then 使用已存附件不重复落盘`, async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]
    const h = f[platform]()
    h.pendingImages.set('im-chat', { images: [{ id: 'image', mediaType: 'image/png', data: Buffer.from('fixture') }], createdAt: Date.now() })
    f.onSend = (text) => { if (text.includes('处理中')) f.ws.delete('A') }
    if (platform === 'dingtalk') await (h as DingTalkHandler).processRobotMessage(dingText())
    else await (h as WeChatHandler).handleMessage(wechatText())
    expect(f.runs).toHaveLength(0)
    expect(h.pendingImages.has('im-chat')).toBe(true)
    expect(f.mediaSaves).toHaveLength(1)
    f.ws.set('A', { id: 'A', slug: 'a', name: 'Project A' }); f.onSend = undefined
    if (platform === 'dingtalk') await (h as DingTalkHandler).processRobotMessage(dingText())
    else await (h as WeChatHandler).handleMessage(wechatText())
    expect(f.runs).toHaveLength(1)
    expect(f.mediaSaves).toHaveLength(1)
    expect(h.pendingImages.has('im-chat')).toBe(false)
  })
})

describe('额外媒体失败与离线恢复', () => {
  for (const platform of ['dingtalk', 'wechat'] as const) test(`Given ${platform}附件保存失败 When 修复后重试 Then 原媒体保留且无纯文字误发`, async () => {
    const f = fixture(); f.defaults = 'A'; f.persisted = [f.binding()]; f.mediaFailure = true
    const h = f[platform]()
    h.pendingImages.set('im-chat', { images: [{ id: 'image', mediaType: 'image/png', data: Buffer.from('fixture') }], createdAt: Date.now() })
    const dispatch = async (): Promise<void> => {
      if (platform === 'dingtalk') await (h as DingTalkHandler).processRobotMessage(dingText())
      else await (h as WeChatHandler).handleMessage(wechatText())
    }
    await dispatch()
    expect(h.pendingImages.has('im-chat')).toBe(true)
    expect(f.runs).toHaveLength(0)
    f.mediaFailure = false
    await dispatch()
    expect(h.pendingImages.has('im-chat')).toBe(false)
    expect(f.runs).toHaveLength(1)
    expect(f.mediaSaves).toHaveLength(1)
  })
  for (const platform of ['dingtalk', 'feishu'] as const) test(`Given ${platform}离线旧路由 When 删除项目 Then manager不清空原记录`, () => {
    const f = fixture(); f.fileBindings = [f.binding()]
    expect(f.manager(platform).removeBindingsForDeletedWorkspace('A', ['old'])).toBe(0)
    expect(f.fileBindings).toHaveLength(1)
    expect(f.saved).toHaveLength(0)
  })
  test('Given 飞书已恢复失效chat When 原默认改为B Then 必须显式switch才可重新派发', async () => {
    const f = fixture(); f.defaults = 'B'; f.fileBindings = [f.binding()]; f.ws.delete('A')
    const h = f.feishu(); h.loadBindings()
    await h.handleUserMessage(context, 'private-A')
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
    await h.handleSwitchCommand(context, 'valid')
    expect(h.rejectedBindings.has('im-chat')).toBe(false)
    await h.handleUserMessage(context, 'explicit-B')
    expect(f.runs[0]?.[0].workspaceId).toBe('B')
  })
  test('Given 飞书删除项目关闭活动路由 When 重启并有另一个默认 Then 墓碑继续拒绝旧chat', async () => {
    const f = fixture(); const h = seedFeishu(f)
    expect(h.quarantineBindingsForDeletedWorkspace('A', new Set(['old']))).toBe(1)
    expect(h.chatBindings.size).toBe(0)
    expect(h.sessionToChat.has('old')).toBe(false)
    f.fileBindings = f.saved.at(-1) as unknown[]; f.ws.delete('A'); f.defaults = 'B'
    const restored = f.feishu(); restored.loadBindings()
    await restored.handleUserMessage(context, 'private-A')
    expect(f.created).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
  })
  test('Given 飞书switch写入失败 When 切有效目标 Then 旧正反向映射保持', async () => {
    const f = fixture(); const h = seedFeishu(f); f.bindingFailure = true
    await expect(h.handleSwitchCommand(context, 'valid')).rejects.toThrow()
    expect(h.chatBindings.get('im-chat')?.sessionId).toBe('old')
    expect(h.sessionToChat.get('old')).toBe('im-chat')
  })
})

describe('飞书与Slack入口和反向路由', () => {
  test('Given 飞书配置失败 When 切项目 Then 原绑定/索引/持久化不变', async () => {
    const f = fixture(); f.defaults = 'A'; const h = seedFeishu(f); f.configFailure = new Error('disk failed')
    await h.handleWorkspaceCommand(context, 'b')
    expect(h.chatBindings.get('im-chat')?.sessionId).toBe('old')
    expect(h.sessionToChat.get('old')).toBe('im-chat')
    expect(f.saved).toHaveLength(0)
  })
  for (const input of [{ sessionId: 'missing' }, { sessionId: 'orphan', workspaceId: 'gone' }, { workspaceId: 'B' }]) test(`Given 飞书无效目标${JSON.stringify(input)} When 设置页更新 Then 原索引和存储保持`, () => {
    const f = fixture(); const h = seedFeishu(f)
    expect(h.updateBinding({ chatId: 'im-chat', ...input })).toBeNull()
    expect(h.chatBindings.get('im-chat')?.sessionId).toBe('old')
    expect(h.sessionToChat.get('old')).toBe('im-chat')
    expect(f.saved).toHaveLength(0)
  })
  test('Given 飞书有效目标 When 设置切换/纯归档 Then 按新session归属更新且支持归档', () => {
    const f = fixture(); const h = seedFeishu(f)
    expect(h.updateBinding({ chatId: 'im-chat', sessionId: 'valid' })?.workspaceId).toBe('B')
    expect(h.sessionToChat.has('old')).toBe(false)
    expect(h.sessionToChat.get('valid')).toBe('im-chat')
    f.ws.delete('B')
    expect(h.updateBinding({ chatId: 'im-chat', archived: true })?.archived).toBe(true)
    expect(h.sessionToChat.has('valid')).toBe(false)
  })
  test('Given 飞书new成功 When 旧错误迟到 Then 旧索引不存在且不冒充新会话', async () => {
    const f = fixture(); f.defaults = 'A'; const h = seedFeishu(f)
    await h.createNewSession(context)
    expect(h.sessionToChat.has('old')).toBe(false)
    expect(h.findBindingBySessionId('old')).toBeUndefined()
    const replies = f.sent.length
    h.handleAgentPayload('old', { kind: 'sdk_message', message: { type: 'assistant', error: 'old-error' } })
    expect(f.sent).toHaveLength(replies)
  })
  test('Given 飞书新绑定保存失败 When new Then 旧正反向映射保持', async () => {
    const f = fixture(); f.defaults = 'A'; const h = seedFeishu(f); f.bindingFailure = true
    await expect(h.createNewSession(context)).rejects.toThrow()
    expect(h.chatBindings.get('im-chat')?.sessionId).toBe('old')
    expect(h.sessionToChat.get('old')).toBe('im-chat')
  })
  test('Given 飞书卡片await时删除项目 When 继续 Then 不运行且只关闭本轮卡片/缓冲', async () => {
    const f = fixture(); const h = seedFeishu(f); f.onCardOpen = () => { f.ws.delete('A') }
    await h.handleUserMessage(context, 'hello')
    expect(f.runs).toHaveLength(0)
    expect(h.sessionBuffers.size).toBe(0)
    expect(h.streamingCards.size).toBe(0)
    expect(f.closedCards).toBe(1)
  })
  test('Given Slack旧绑定项目删除 When 复用 Then 拒绝且不创建新默认项目', () => {
    const f = fixture(); f.settings.agentWorkspaceId = 'A'; const h = f.slack()
    h.getOrCreateBinding(slackMessage, '1'); f.ws.delete('A'); f.settings.agentWorkspaceId = 'B'
    expect(() => h.getOrCreateBinding(slackMessage, '1')).toThrow()
    expect(f.created).toHaveLength(1)
  })
  test('Given Slack持久化旧线程失效 When 重启恢复后发同线程 Then 路由墓碑阻止自动新建B', () => {
    const f = fixture(); f.settings.agentWorkspaceId = 'A'; const first = f.slack()
    const binding = first.getOrCreateBinding(slackMessage, '1'); f.fileBindings = [binding]; f.ws.delete('A'); f.settings.agentWorkspaceId = 'B'
    const restored = f.slack(); restored.loadBindings()
    expect(restored.bindings.size).toBe(0)
    expect(restored.rejectedBindings.size).toBe(1)
    expect(() => restored.getOrCreateBinding(slackMessage, '1')).toThrow()
    expect(f.created).toHaveLength(1)
  })
  test('Given Slack进度await时项目消失 When 派发 Then 不调用Agent', async () => {
    const f = fixture(); f.settings.agentWorkspaceId = 'A'; const h = f.slack()
    const binding = h.getOrCreateBinding(slackMessage, '1'); h.postThinking = async () => { f.ws.delete('A'); return undefined }
    await h.runAgentForMessage(binding, slackMessage)
    expect(f.runs).toHaveLength(0)
  })
  test('Given Slack有效绑定 When 正常复用/派发 Then 同一session且保持plan权限', async () => {
    const f = fixture(); f.settings.agentWorkspaceId = 'A'; const h = f.slack()
    const binding = h.getOrCreateBinding(slackMessage, '1')
    expect(h.getOrCreateBinding(slackMessage, '1').sessionId).toBe(binding.sessionId)
    await h.runAgentForMessage(binding, slackMessage)
    expect(f.created).toHaveLength(1)
    expect(f.runs[0]?.[0].permissionModeOverride).toBe('plan')
  })
})
