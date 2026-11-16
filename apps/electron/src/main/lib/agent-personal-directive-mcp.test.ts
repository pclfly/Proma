/**
 * 破甲 MCP 挂载层的行为测试。
 *
 * 覆盖三条契约：
 * 1. 只有破甲开启时才读取外部配置；
 * 2. 两种顶层键（servers / mcpServers）与 transport 推断都能解析；
 * 3. 工作区同名配置优先，破甲层只补空缺。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergePersonalDirectiveMcpServers, resolvePersonalDirectiveMcpServers } from './agent-personal-directive-mcp'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'proma-pd-mcp-'))
}

function writeConfig(dir: string, payload: unknown): string {
  const filePath = join(dir, 'mcp.json')
  writeFileSync(filePath, JSON.stringify(payload), 'utf-8')
  return filePath
}

describe('resolvePersonalDirectiveMcpServers', () => {
  test('破甲关闭时即使配置了路径也不读取', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, { servers: { seep: { type: 'stdio', command: 'python' } } })

    expect(resolvePersonalDirectiveMcpServers({
      enabled: false,
      content: '',
      seepMcpConfigPath: filePath,
    })).toEqual({})

    rmSync(dir, { recursive: true, force: true })
  })

  test('未配置路径时返回空集', () => {
    expect(resolvePersonalDirectiveMcpServers({ enabled: true, content: '' })).toEqual({})
    expect(resolvePersonalDirectiveMcpServers(undefined)).toEqual({})
  })

  test('文件不存在时返回空集且不抛错', () => {
    const missing = join(tmpdir(), 'proma-pd-mcp-missing', 'nope.json')
    expect(resolvePersonalDirectiveMcpServers({
      enabled: true,
      content: '',
      seepMcpConfigPath: missing,
    })).toEqual({})
  })

  test('兼容 mcpServers 顶层键并按结构推断 transport', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      mcpServers: {
        seep: { command: 'python', args: ['server.py'], env: { PYTHONIOENCODING: 'utf-8' } },
        remote: { url: 'https://example.com/mcp' },
      },
    })

    const servers = resolvePersonalDirectiveMcpServers({
      enabled: true,
      content: '',
      seepMcpConfigPath: filePath,
    })

    expect(servers).toMatchObject({
      seep: {
        type: 'stdio',
        command: 'python',
        args: ['server.py'],
        env: { PYTHONIOENCODING: 'utf-8' },
        enabled: true,
      },
      remote: { type: 'http', url: 'https://example.com/mcp' },
    })

    rmSync(dir, { recursive: true, force: true })
  })

  test('兼容 servers 顶层键与 transport 别名', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      servers: {
        web: { type: 'streamable-http', url: 'https://example.com/mcp', timeout: 45 },
      },
    })

    const servers = resolvePersonalDirectiveMcpServers({
      enabled: true,
      content: '',
      seepMcpConfigPath: filePath,
    })

    expect(servers).toMatchObject({ web: { type: 'http', timeout: 45 } })

    rmSync(dir, { recursive: true, force: true })
  })

  test('保留显式 enabled:false 供编排层跳过', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      servers: { disabled: { command: 'python', enabled: false } },
    })

    const servers = resolvePersonalDirectiveMcpServers({
      enabled: true,
      content: '',
      seepMcpConfigPath: filePath,
    })

    expect(servers).toMatchObject({ disabled: { enabled: false } })

    rmSync(dir, { recursive: true, force: true })
  })

  test('缺 command/url 的条目被跳过', () => {
    const dir = makeTempDir()
    const filePath = writeConfig(dir, {
      servers: {
        broken: { env: { A: '1' } },
        ok: { command: 'python' },
      },
    })

    const servers = resolvePersonalDirectiveMcpServers({
      enabled: true,
      content: '',
      seepMcpConfigPath: filePath,
    })

    expect(Object.keys(servers)).toEqual(['ok'])

    rmSync(dir, { recursive: true, force: true })
  })

  test('文件内容不是对象时返回空集', () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'mcp.json')
    writeFileSync(filePath, '[]', 'utf-8')

    expect(resolvePersonalDirectiveMcpServers({
      enabled: true,
      content: '',
      seepMcpConfigPath: filePath,
    })).toEqual({})

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('mergePersonalDirectiveMcpServers', () => {
  const workspaceEntry = { type: 'stdio' as const, command: 'workspace-python', enabled: true }
  const directiveEntry = { type: 'stdio' as const, command: 'seep-python', enabled: true }

  test('工作区同名条目优先，破甲层记入 shadowed', () => {
    const { servers, shadowed } = mergePersonalDirectiveMcpServers(
      { seep: workspaceEntry },
      { seep: directiveEntry, ida: directiveEntry },
    )

    expect(servers).toMatchObject({
      seep: { source: 'workspace', entry: { command: 'workspace-python' } },
      ida: { source: 'directive' },
    })
    expect(shadowed).toEqual(['seep'])
  })

  test('无重叠时两侧都保留', () => {
    const { servers, shadowed } = mergePersonalDirectiveMcpServers(
      { custom: workspaceEntry },
      { seep: directiveEntry },
    )

    expect(Object.keys(servers).sort()).toEqual(['custom', 'seep'])
    expect(shadowed).toEqual([])
  })

  test('破甲关闭时传入空集，结果与工作区配置一致', () => {
    const { servers } = mergePersonalDirectiveMcpServers({ custom: workspaceEntry }, {})

    expect(Object.keys(servers)).toEqual(['custom'])
  })
})
