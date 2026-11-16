import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import type { BridgeCommandHandlerConfig } from './bridge-command-handler'

/**
 * 桥接 Round3 修复的仓库回归：全部走原样生产方法。
 * 覆盖飞书跨 chat 共享会话的资源所有权、调度前拒绝、restore 淘汰顺序，
 * 以及 Slack 被顶替轮的投递收尾。沿用 `bridge-routing.fixture.cjs` 的隔离夹具。
 */
const fixtureModule: unknown = createRequire(import.meta.url)('./bridge-routing.fixture.cjs')
interface Round3Fixture {
  ws: Map<string, { id: string; name: string; slug: string }>
  sessions: Map<string, { id: string; workspaceId: string; title: string; channelId?: string }>
  created: Array<{ id: string; workspaceId: string }>
  runs: unknown[][]
  sent: Array<{ text?: string; card?: unknown }>
  fileBindings: unknown[]
  closedCards?: number
  mediaSaves: Array<{ hint: string }>
  defaultWorkspace?: string
  binding(session?: string): { chatId: string; sessionId: string; workspaceId: string; channelId: string }
  feishu(): FeishuLike
  slack(): SlackLike
  generic(options?: Partial<BridgeCommandHandlerConfig>): { handleIncomingMessage(chatId: string, text: string): Promise<boolean> }
  agentDeps: { runAgentHeadless: (...args: unknown[]) => Promise<void> }
  onRun?: (...args: unknown[]) => Promise<void>
}
interface CardHandle { update(): Promise<void>; close(): Promise<void>; closed: number }
interface FeishuLike {
  chatBindings: Map<string, { chatId: string; sessionId: string; workspaceId: string }>
  sessionToChat: Map<string, string>
  sessionBuffers: Map<string, unknown>
  streamingCards: Map<string, CardHandle>
  streamingRunStates: Map<string, unknown>
  pendingImages: Map<string, Array<{ imageKey: string; mediaType: string; data: Buffer; receivedAt?: number }>>
  client?: unknown
  handleSwitchCommand(context: unknown, arg: string): Promise<void>
  handleUserMessage(context: unknown, text: string, images?: unknown[], files?: unknown[]): Promise<string>
}
interface SlackLike {
  bindings: Map<string, { key: string; sessionId: string; workspaceId: string }>
  activeRuns: Map<string, unknown>
  deliveryStore: { records: Map<string, { status: string; finalText?: string }>; accept(record: { eventId: string; channelId: string; threadTs: string }): void }
  postThinking(): Promise<string | undefined>
  runAgentForMessage(binding: unknown, message: unknown): Promise<void>
  acceptIncoming(message: unknown): Promise<void>
}
interface Round3FixtureWithDelivery extends Round3Fixture {
  deliveryStore?: { records: Map<string, { status: string; finalText?: string }>; accept(record: { eventId: string; channelId: string; threadTs: string }): void }
}
const { fixture } = fixtureModule as { fixture(): Round3Fixture }
const ctx = { chatId: 'im-chat', senderOpenId: 'fixture-user', chatType: 'p2p' }
const slackMessage = { teamId: 'T', channelId: 'C', userId: 'U', ts: '1', eventId: 'E1', text: 'hello', mentioned: true }
function image(key: string): { imageKey: string; mediaType: string; data: Buffer; receivedAt: number } {
  return { imageKey: key, mediaType: 'image/png', data: Buffer.from(key), receivedAt: Date.now() }
}

describe('飞书同session多chat的资源所有权', () => {
  test('Given chat1迟到onError When chat2正在运行 Then 不删chat2卡片/状态/缓冲', async () => {
    const f = fixture()
    f.fileBindings = [f.binding()]
    const h = f.feishu()
    h.client = {}
    h.chatBindings.set('im-chat', f.binding())
    h.sessionToChat.set('old', 'im-chat')
    // 第二个 chat 经真实 /switch 绑定同一会话。
    await h.handleSwitchCommand({ ...ctx, chatId: 'im-chat-2' }, 'old')
    let releaseChat2: () => void = () => { throw new Error('未开始') }
    let chat1OnError: (message: string) => void = () => { throw new Error('未开始') }
    let call = 0
    f.agentDeps.runAgentHeadless = async (...args) => {
      call += 1
      const callbacks = args[1] as { onError(message: string): void }
      if (call === 1) {
        chat1OnError = callbacks.onError
        throw new Error('chat1 调度前拒绝')
      }
      // chat2 保持运行中，不回调任何终态。
      await new Promise<void>((resolve) => { releaseChat2 = resolve })
    }
    const chat1 = await h.handleUserMessage(ctx, 'chat1 message')
    expect(chat1).toBe('not-dispatched')
    const chat2Pending = h.handleUserMessage({ ...ctx, chatId: 'im-chat-2' }, 'chat2 message')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const chat2Card = h.streamingCards.get('old')
    const chat2State = h.streamingRunStates.get('old')
    const chat2Buffer = h.sessionBuffers.get('old')
    expect(chat2Card).toBeDefined()
    // chat1 的迟到 onError 不得命中 chat2 的资源。
    chat1OnError('chat1 迟到错误')
    expect(h.streamingCards.get('old')).toBe(chat2Card)
    expect(h.streamingRunStates.get('old')).toBe(chat2State)
    expect(h.sessionBuffers.get('old')).toBe(chat2Buffer)
    expect(chat2Card?.closed ?? 0).toBe(0)
    releaseChat2()
    await chat2Pending
  })

  test('Given 调度前拒绝 When 本轮带图片 Then 返回not-dispatched、归还媒体、关卡片并提示', async () => {
    const f = fixture()
    f.fileBindings = [f.binding()]
    const h = f.feishu()
    h.client = {}
    h.chatBindings.set('im-chat', f.binding())
    f.agentDeps.runAgentHeadless = async () => { throw new Error('会话仍在运行或收尾') }
    const before = f.sent.length
    const result = await h.handleUserMessage(ctx, 'see image', [image('img-1')])
    expect(result).toBe('not-dispatched')
    expect(f.runs).toHaveLength(0)
    expect(h.pendingImages.get('im-chat')).toHaveLength(1)
    expect(h.streamingCards.size).toBe(0)
    expect(h.sessionBuffers.size).toBe(0)
    expect(f.closedCards).toBe(1)
    expect(f.sent.slice(before).some((row) => row.text?.includes('稍后重新发送'))).toBe(true)
    // 第二轮正常调度，证明没有引入永久锁（显式记录调用，不用夹具默认实现）。
    f.agentDeps.runAgentHeadless = async (...args) => { f.runs.push(args) }
    expect(await h.handleUserMessage(ctx, 'retry', [image('img-1')])).toBe('dispatched')
    expect(f.runs).toHaveLength(1)
  })

  test('Given restore时等待区已满 When 归还失败媒体 Then 重试项保留而非被挤出', async () => {
    const f = fixture()
    f.fileBindings = [f.binding()]
    const h = f.feishu()
    h.client = {}
    h.chatBindings.set('im-chat', f.binding())
    // 20 张并发新图占满等待区。
    h.pendingImages.set('im-chat', Array.from({ length: 20 }, (_, index) => image(`filler-${index}`)))
    const retry = { ...image('retry-me'), receivedAt: Date.now() - 60_000 }
    f.agentDeps.runAgentHeadless = async () => { throw new Error('调度前拒绝') }
    await h.handleUserMessage(ctx, 'retry me', [retry])
    const pending = h.pendingImages.get('im-chat') ?? []
    expect(pending).toHaveLength(20)
    expect(pending.some((item) => item.imageKey === 'retry-me')).toBe(true)
    expect(pending.find((item) => item.imageKey === 'retry-me')?.receivedAt).toBe(retry.receivedAt)
  })
})

describe('Slack 被顶替轮的投递收尾', () => {
  test('Given 同session旧轮被新轮顶替 When postThinking返回后 Then 旧事件不停在running并给本线程明确说明', async () => {
    const f = fixture() as Round3FixtureWithDelivery
    f.ws.set('A', { id: 'A', name: 'Project A', slug: 'a' })
    f.sessions.set('shared', { id: 'shared', workspaceId: 'A', title: 'shared', channelId: 'channel' })
    const h = f.slack()
    const first = { key: 'k1', sessionId: 'shared', workspaceId: 'A', channelId: 'C', rootThreadTs: '1', userId: 'U', teamId: 'T', botId: 'b' }
    const second = { ...first, key: 'k2', rootThreadTs: '2' }
    const firstMessage = { ...slackMessage, eventId: 'E1', ts: '1' }
    h.deliveryStore.accept({ eventId: 'E1', channelId: 'C', threadTs: '1' })
    // 第一轮停在 postThinking；第二轮抢占 activeRuns 后才放行第一轮。
    let releaseFirst: () => void = () => { throw new Error('未开始') }
    let firstThinking: Promise<string | undefined> = Promise.resolve(undefined)
    h.postThinking = ((run: { binding: { key: string } }) => {
      if (run.binding.key === 'k1') {
        firstThinking = new Promise<string | undefined>((resolve) => { releaseFirst = () => resolve(undefined) })
        return firstThinking
      }
      return Promise.resolve(undefined)
    }) as never
    f.agentDeps.runAgentHeadless = async () => {}
    const firstRun = h.runAgentForMessage(first, firstMessage)
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.activeRuns.set('shared', { superseded: true })
    releaseFirst()
    await firstRun
    const record = h.deliveryStore.records.get('E1')
    expect(record?.status).not.toBe('running')
    expect(record?.finalText).toContain('已被同一会话的另一个执行顶替')
  })
})
