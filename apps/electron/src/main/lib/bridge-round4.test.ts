import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'

/** Round4 回归：走 `bridge-routing.fixture.cjs` 的原样生产类。 */
const fixtureModule: unknown = createRequire(import.meta.url)('./bridge-routing.fixture.cjs')
interface CardHandle { closed: number; update(): Promise<void>; close(): Promise<void> }
interface FeishuLike {
  chatBindings: Map<string, { chatId: string; sessionId: string; workspaceId: string }>
  sessionToChat: Map<string, string>
  sessionBuffers: Map<string, unknown>
  streamingCards: Map<string, CardHandle>
  streamingRunStates: Map<string, unknown>
  streamingCardsUsedSessions: Set<string>
  client?: unknown
  handleSwitchCommand(context: unknown, arg: string): Promise<void>
  handleUserMessage(context: unknown, text: string): Promise<string>
  handleCommand(context: unknown, text: string): Promise<void>
}
interface Fixture {
  ws: Map<string, { id: string; name: string; slug: string }>
  sessions: Map<string, { id: string; workspaceId: string; title: string; channelId?: string }>
  sent: Array<{ id?: string; text?: string; card?: unknown }>
  fileBindings: unknown[]
  runs: unknown[][]
  agentDeps: { runAgentHeadless: (...args: unknown[]) => Promise<void>; stopAgent(id: string): void }
  binding(session?: string): { chatId: string; sessionId: string; workspaceId: string; channelId: string }
  feishu(): FeishuLike
}
const { fixture } = fixtureModule as { fixture(): Fixture }

async function twoChatsOneSession(): Promise<{ f: Fixture; h: FeishuLike }> {
  const f = fixture()
  f.fileBindings = [f.binding()]
  const h = f.feishu()
  h.client = {}
  h.chatBindings.set('im-chat', f.binding())
  h.sessionToChat.set('old', 'im-chat')
  await h.handleSwitchCommand({ chatId: 'im-chat-2', senderOpenId: 'u', chatType: 'p2p' }, 'old')
  return { f, h }
}

describe('飞书 /stop 不得静默关闭另一 chat 的卡片', () => {
  test('Given 两chat共用session When chat1发stop Then 卡片只关一次且对方收到归属说明', async () => {
    const { f, h } = await twoChatsOneSession()
    let release: () => void = () => { throw new Error('未开始') }
    let stopped: string[] = []
    f.agentDeps.runAgentHeadless = async () => { await new Promise<void>((resolve) => { release = resolve }) }
    f.agentDeps.stopAgent = (id: string) => { stopped.push(id) }
    const running = h.handleUserMessage({ chatId: 'im-chat-2', senderOpenId: 'u', chatType: 'p2p' }, 'chat2')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const chat2Card = h.streamingCards.get('old')
    expect(chat2Card).toBeDefined()
    const before = f.sent.length
    await h.handleCommand({ chatId: 'im-chat', senderOpenId: 'u', chatType: 'p2p' }, '/stop')
    // 卡片关闭发生在 flush().then() 中，等待微任务落定。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toEqual(['old'])
    expect(chat2Card?.closed ?? 0).toBe(1)
    const notices = f.sent.slice(before)
    // 发起方与卡片归属方都能看到说明。
    expect(notices.some((row) => row.id === 'im-chat' && row.text?.includes('已停止'))).toBe(true)
    expect(notices.some((row) => row.id === 'im-chat-2' && row.text?.includes('/stop'))).toBe(true)
    release()
    await running
  })

  test('Given 单chat自己发stop Then 仍只回一条已停止且不发给其他chat', async () => {
    const f = fixture(); f.fileBindings = [f.binding()]
    const h = f.feishu(); h.client = {}
    h.chatBindings.set('im-chat', f.binding()); h.sessionToChat.set('old', 'im-chat')
    let release: () => void = () => { throw new Error('未开始') }
    f.agentDeps.runAgentHeadless = async () => { await new Promise<void>((resolve) => { release = resolve }) }
    const running = h.handleUserMessage({ chatId: 'im-chat', senderOpenId: 'u', chatType: 'p2p' }, 'x')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const card = h.streamingCards.get('old')
    const before = f.sent.length
    await h.handleCommand({ chatId: 'im-chat', senderOpenId: 'u', chatType: 'p2p' }, '/stop')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(card?.closed ?? 0).toBe(1)
    const notices = f.sent.slice(before)
    expect(notices.filter((row) => row.id === 'im-chat')).toHaveLength(1)
    expect(notices.some((row) => row.id === 'im-chat-2')).toBe(false)
    release(); await running
  })
})
