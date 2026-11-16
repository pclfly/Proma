import { describe, expect, test } from 'bun:test'
import { getDefaultReasoningProfileConfigData } from '@proma/shared'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { serializePiQueryInput } from './pi-query-input'

describe('Agent utility 请求序列化', () => {
  test.each([{ profiles: [] }, { profiles: getDefaultReasoningProfileConfigData() }])('Given 每轮完整快照 When 序列化 Then 包括空列表都穿过进程边界', ({ profiles }) => {
    const input: PiAgentQueryOptions = {
      sessionId: 'test', prompt: 'test', apiKey: 'not-a-real-key', provider: 'custom',
      permissionMode: 'bypassPermissions', systemPrompt: '', piAgentDir: '', piSessionDir: '',
      reasoningProfiles: [...profiles], thinkingLevel: 'max', onSessionId: () => {},
    }
    const serialized = serializePiQueryInput(input)
    const received = structuredClone(serialized)
    expect(received.reasoningProfiles).toEqual(profiles)
    expect(received.thinkingLevel).toBe('max')
    expect(received.onSessionId).toBeUndefined()
  })

  test('Given 主进程来源观察器 When 序列化 Then 函数被剔除且只保留声明标记', () => {
    const input: PiAgentQueryOptions = {
      sessionId: 'test', prompt: 'test', apiKey: 'not-a-real-key', provider: 'custom',
      permissionMode: 'bypassPermissions', systemPrompt: '', piAgentDir: '', piSessionDir: '',
      knowledgeMutationObserver: { begin: async () => null, finish: async () => {} },
    }
    const serialized = serializePiQueryInput(input)
    expect(serialized.knowledgeMutationObserver).toBeUndefined()
    expect(serialized.knowledgeAttribution).toBe(true)
    expect(() => structuredClone(serialized)).not.toThrow()
  })

  test('Given 工作区记忆上下文 When 序列化 Then 纯数据穿过 utility 边界', () => {
    const memoryContext = {
      globalDir: '/tmp/proma/memory',
      workspaceRoot: '/tmp/proma/agent-workspaces/demo',
      projectRoot: '/tmp/project',
      canonicalProjectRoot: '/tmp/project',
      workspaces: [{ slug: 'demo', root: '/tmp/proma/agent-workspaces/demo' }],
      allowProfileMigration: true,
      allowInstructionMaintenance: true,
      allowMemoryWrites: true,
    }
    const input: PiAgentQueryOptions = {
      sessionId: 'test', prompt: 'test', apiKey: 'not-a-real-key', provider: 'custom',
      permissionMode: 'bypassPermissions', systemPrompt: '', piAgentDir: '', piSessionDir: '',
      memoryContext,
    }
    const serialized = serializePiQueryInput(input)
    const received = structuredClone(serialized)
    expect(received.memoryContext).toEqual(memoryContext)
  })

  test('Given 工具含 prepareArguments/render 函数 When 序列化 Then 只保留可克隆声明', () => {
    const input: PiAgentQueryOptions = {
      sessionId: 'test', prompt: 'test', apiKey: 'not-a-real-key', provider: 'custom',
      permissionMode: 'bypassPermissions', systemPrompt: '', piAgentDir: '', piSessionDir: '',
      customTools: [{
        name: 'ComputerUsePreview',
        label: '预览',
        description: 'preview',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [] }),
        prepareArguments: (args: unknown) => args,
        prepareLoadout: (loadout: unknown) => loadout,
        renderCall: () => null,
      }] as unknown as PiAgentQueryOptions['customTools'],
    }
    const serialized = serializePiQueryInput(input)
    expect(() => structuredClone(serialized)).not.toThrow()
    const tool = (serialized.customTools as Array<Record<string, unknown>>)[0]
    expect(tool?.name).toBe('ComputerUsePreview')
    expect(tool).not.toHaveProperty('execute')
    expect(tool).not.toHaveProperty('prepareArguments')
    expect(tool).not.toHaveProperty('prepareLoadout')
    expect(tool).not.toHaveProperty('renderCall')
  })

  test('Given 没有来源观察器 When 序列化 Then 不产生任何归因声明', () => {
    const input: PiAgentQueryOptions = {
      sessionId: 'test', prompt: 'test', apiKey: 'not-a-real-key', provider: 'custom',
      permissionMode: 'bypassPermissions', systemPrompt: '', piAgentDir: '', piSessionDir: '',
    }
    expect(serializePiQueryInput(input).knowledgeAttribution).toBeUndefined()
  })
})
