import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from 'jotai'
import { ATTACHMENT_IPC_CHANNELS } from '@proma/shared'
import { appModeAtom } from './app-mode'
import { getPersistableTabState } from './tab-atoms'
import type { TabItem } from './tab-atoms'
import { getStopGenerationTarget, resolveStopGenerationTarget } from '../lib/stop-generation-target'

const root = join(import.meta.dir, '..', '..')
const src = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replaceAll('\r\n', '\n')

describe('Chat专属链路退役与共享能力保护', () => {
  test('Given 旧模式写入 When 读取应用入口 Then 恒为Agent且不恢复Chat状态', () => {
    const store = createStore()
    expect(store.get(appModeAtom)).toBe('agent')
    store.set(appModeAtom, 'chat')
    expect(store.get(appModeAtom)).toBe('agent')
    expect(src('renderer', 'main.tsx')).not.toContain('listConversations(')
  })

  test('Given 旧持久化Chat标签 When 再次持久化 Then 过滤而不改标为Agent', () => {
    // 模拟来自旧JSON的外部输入，故意越过运行期TabType而不是扩大新运行时类型。
    const legacy = [
      { id: 'legacy-chat', sessionId: 'legacy-chat', title: '旧资料', type: 'chat' },
      { id: 'agent-a', sessionId: 'agent-a', title: '当前任务', type: 'agent' },
    ] as unknown as TabItem[]
    const persisted = getPersistableTabState(legacy, 'legacy-chat')
    expect(persisted.tabs.map(tab => tab.id)).toEqual(['agent-a'])
    expect(src('renderer', 'main.tsx')).toContain("t.type === 'agent' &&")
  })

  test('Given 侧栏/欢迎页/QuickTask/托盘 When 核对入口 Then 无Chat创建或切换分支', () => {
    for (const path of [
      ['renderer', 'components', 'app-shell', 'LeftSidebar.tsx'],
      ['renderer', 'components', 'welcome', 'WelcomeEmptyState.tsx'],
      ['renderer', 'components', 'quick-task', 'QuickTaskApp.tsx'],
      ['renderer', 'components', 'shortcuts', 'GlobalShortcuts.tsx'],
      ['main', 'tray.ts'],
    ]) {
      const source = src(...path)
      expect(source).not.toContain('createChat')
      expect(source).not.toContain("setMode('chat')")
      expect(source).not.toContain('Chat 对话')
    }
  })

  test('Given 桌面IPC四层 When 退役Chat Then 无旧消息/CRUD/流式API和迁移入口', () => {
    const main = src('main', 'ipc.ts')
    const preload = src('preload', 'index.ts')
    expect(main).not.toMatch(/\bCHAT_IPC_CHANNELS\b/)
    expect(main).not.toContain('autoArchiveConversations(')
    expect(main).not.toContain('migrateChatToAgentSession')
    for (const name of ['createConversation', 'listConversations', 'sendMessage', 'stopGeneration', 'onStreamChunk', 'migrateChatToAgent']) {
      expect(preload).not.toMatch(new RegExp(`\\b${name}\\s*:`))
    }
    for (const path of [['main', 'lib', 'chat-service.ts'], ['main', 'lib', 'conversation-manager.ts'], ['renderer', 'atoms', 'chat-atoms.ts'], ['renderer', 'components', 'chat', 'ChatView.tsx']]) {
      expect(existsSync(join(root, ...path))).toBe(false)
    }
  })

  test('Given Agent图片/文件/资源 When 中性化附件通道 Then 保持既有wire与两端接线', () => {
    expect(ATTACHMENT_IPC_CHANNELS.READ_ATTACHMENT).toBe('chat:read-attachment')
    expect(ATTACHMENT_IPC_CHANNELS.SAVE_IMAGE_AS).toBe('chat:save-image-as')
    for (const key of Object.keys(ATTACHMENT_IPC_CHANNELS)) {
      expect(src('main', 'ipc.ts')).toContain(`ATTACHMENT_IPC_CHANNELS.${key}`)
      expect(src('preload', 'index.ts')).toContain(`ATTACHMENT_IPC_CHANNELS.${key}`)
    }
    expect(existsSync(join(root, 'main', 'lib', 'vision-relay-service.ts'))).toBe(false)
    expect(existsSync(join(root, 'main', 'lib', 'chat-tools', 'http-tool-executor.ts'))).toBe(true)
  })

  test('Given 旧Chat停止事件 When 校验 Then 拒绝而非停止其他Agent', () => {
    expect(getStopGenerationTarget(new CustomEvent('stop', { detail: { kind: 'chat', sessionId: 'old' } }))).toBeNull()
    expect(getStopGenerationTarget(new CustomEvent('stop', { detail: { kind: 'agent', sessionId: 'agent-a' } }))).toEqual({ kind: 'agent', sessionId: 'agent-a' })
  })

  test('Given 预览或委派会话 When 解析停止目标 Then 保留对应Agent归属', () => {
    expect(resolveStopGenerationTarget({ type: 'preview', sessionId: 'owner' }, undefined)).toEqual({ kind: 'agent', sessionId: 'owner' })
    expect(resolveStopGenerationTarget({ type: 'agent', sessionId: 'owner' }, 'delegation', { type: 'agent', sessionId: 'child' })).toEqual({ kind: 'agent', sessionId: 'child' })
    expect(resolveStopGenerationTarget({ type: 'chat', sessionId: 'old' }, undefined)).toBeNull()
  })
})
