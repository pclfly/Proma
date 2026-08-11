import { beforeAll, describe, expect, mock, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

type PiNanoBananaToolsModule = typeof import('../chat-tools/nano-banana-mcp')
type BuiltinMcpSettingsModule = typeof import('../builtin-mcp/settings')

let buildPiNanoBananaTools: PiNanoBananaToolsModule['buildPiNanoBananaTools']
let isBuiltinMcpDefaultDisabled: BuiltinMcpSettingsModule['isBuiltinMcpDefaultDisabled']

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd(),
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] { return [] }
    static getFocusedWindow(): null { return null }
  },
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('../chat-tool-config', () => ({
  getToolState: () => ({ enabled: true }),
  getToolCredentials: () => ({ apiKey: 'test-key', provider: 'gemini' }),
}))

beforeAll(async () => {
  const [toolsModule, settingsModule] = await Promise.all([
    import('../chat-tools/nano-banana-mcp'),
    import('../builtin-mcp/settings'),
  ])
  buildPiNanoBananaTools = toolsModule.buildPiNanoBananaTools
  isBuiltinMcpDefaultDisabled = settingsModule.isBuiltinMcpDefaultDisabled
})

describe('Pi AI 生图工具桥接', () => {
  test('Given AI 生图 MCP 支持独立关闭 When 判断 Agent 默认能力 Then 默认开启', () => {
    expect(isBuiltinMcpDefaultDisabled('nano-banana')).toBe(false)
  })

  test('Given Pi runtime When 构建生图工具 Then 注册 generate_image 并禁止脚本替代', () => {
    const sdk = {
      defineTool<T>(definition: T): T {
        return definition
      },
    } as unknown as Parameters<typeof buildPiNanoBananaTools>[0]

    const tools: ToolDefinition[] = buildPiNanoBananaTools(sdk, {
      sessionId: 'SESSION_ID',
      agentCwd: 'C:/workspace/session',
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('generate_image')
    expect(tools[0]?.description).toContain('MUST call this tool')
    expect(tools[0]?.description).toContain('instead of substituting Python')
  })
})
