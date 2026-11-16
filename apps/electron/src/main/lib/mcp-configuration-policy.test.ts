import { describe, expect, test } from 'bun:test'
import {
  buildWorkspaceMcpEntry,
  hasWorkspaceMcpTransportChanged,
  preserveSensitiveConnectionFields,
  requireWorkspaceMcpServerName,
} from './mcp-configuration-policy'

describe('工作区 MCP 服务名校验', () => {
  test('Given 空、超长或控制字符 When 校验 Then 拒绝', () => {
    expect(() => requireWorkspaceMcpServerName('   ')).toThrow('不能为空')
    expect(() => requireWorkspaceMcpServerName('a'.repeat(121))).toThrow('不能超过 120')
    expect(() => requireWorkspaceMcpServerName('bad\u0000name')).toThrow('控制字符')
  })

  test('Given 合法名称 When 校验 Then 去空格返回', () => {
    expect(requireWorkspaceMcpServerName('  workspace-mcp  ')).toBe('workspace-mcp')
  })
})

describe('工作区 MCP 远程配置策略', () => {
  test('Given HTTP(S) or SSE input When building Then keeps the trimmed URL', () => {
    expect(buildWorkspaceMcpEntry({
      name: 'remote-http',
      type: 'http',
      url: '  https://example.com/mcp  ',
    })).toMatchObject({
      type: 'http',
      url: 'https://example.com/mcp',
      enabled: true,
    })

    expect(buildWorkspaceMcpEntry({
      name: 'remote-sse',
      type: 'sse',
      url: 'http://127.0.0.1:14242/sse',
      timeout: 12,
    })).toMatchObject({
      type: 'sse',
      url: 'http://127.0.0.1:14242/sse',
      timeout: 12,
      enabled: true,
    })
  })

  test('Given a non-HTTP scheme When building Then rejects before persisting', () => {
    for (const url of ['ftp://example.com/mcp', 'file:///tmp/mcp', 'ws://example.com/mcp']) {
      expect(() => buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url }))
        .toThrow(`无效的 MCP URL: ${url}`)
    }
  })

  test('Given embedded credentials When building Then rejects the URL', () => {
    expect(() => buildWorkspaceMcpEntry({
      name: 'remote',
      type: 'http',
      url: 'https://user:pass@example.com/mcp',
    })).toThrow('无效的 MCP URL: https://user:pass@example.com/mcp')
  })

  test('Given malformed or missing URL When building Then rejects', () => {
    expect(() => buildWorkspaceMcpEntry({ name: 'remote', type: 'sse' })).toThrow('sse MCP 需要 url')
    expect(() => buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url: 'not a url' }))
      .toThrow('无效的 MCP URL: not a url')
  })

  test('Given OAuth 参数 When building Then 只保留 HTTPS 端点与公开字段', () => {
    const entry = buildWorkspaceMcpEntry({
      name: 'remote-oauth',
      type: 'http',
      url: 'https://example.com/mcp',
      oauth: {
        provider: '  example  ',
        clientId: ' client-id ',
        authorizationEndpoint: 'https://example.com/auth',
        tokenEndpoint: 'https://example.com/token',
        scopes: [' read ', '', 'write'],
        clientSecretRequired: true,
      },
    })
    expect(entry.oauth).toEqual({
      provider: 'example',
      clientId: 'client-id',
      authorizationEndpoint: 'https://example.com/auth',
      tokenEndpoint: 'https://example.com/token',
      scopes: ['read', 'write'],
      clientSecretRequired: true,
    })
  })

  test('Given OAuth 非 HTTPS 或非法 URL When building Then 拒绝', () => {
    expect(() => buildWorkspaceMcpEntry({
      name: 'remote',
      type: 'http',
      url: 'https://example.com/mcp',
      oauth: { authorizationEndpoint: 'http://example.com/auth' },
    })).toThrow('必须使用 HTTPS')
    expect(() => buildWorkspaceMcpEntry({
      name: 'remote',
      type: 'http',
      url: 'https://example.com/mcp',
      oauth: { tokenEndpoint: 'not a url' },
    })).toThrow('不是有效 URL')
  })

  test('Given timeout 小数或小于 1 When building Then 收敛为整数且至少 1', () => {
    expect(buildWorkspaceMcpEntry({
      name: 'remote', type: 'http', url: 'https://example.com/mcp', timeout: 0,
    }).timeout).toBe(1)
    expect(buildWorkspaceMcpEntry({
      name: 'remote', type: 'http', url: 'https://example.com/mcp', timeout: 12.9,
    }).timeout).toBe(12)
  })

  test('Given stdio input When building Then keeps the existing normalization unchanged', () => {
    expect(buildWorkspaceMcpEntry({
      name: 'local',
      type: 'stdio',
      command: '  npx  ',
      args: [' -y ', ' ', 'server'],
      enabled: false,
    })).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      enabled: false,
    })
  })
})

describe('工作区 MCP 配置变更检测', () => {
  test('Given the same remote transport When compared Then reports no change', () => {
    const entry = buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url: 'https://example.com/mcp' })
    expect(hasWorkspaceMcpTransportChanged(entry, { ...entry })).toBe(false)
  })

  test('Given a different remote URL When compared Then reports a change', () => {
    const previous = buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url: 'https://example.com/mcp' })
    const next = buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url: 'https://example.com/other' })
    expect(hasWorkspaceMcpTransportChanged(previous, next)).toBe(true)
  })

  test('Given stdio env When 更新命令 Then 保留原 env', () => {
    const previous = { type: 'stdio' as const, command: 'old', env: { TOKEN: 'secret' }, enabled: true }
    const next = buildWorkspaceMcpEntry({ name: 'local', type: 'stdio', command: 'new' })
    expect(preserveSensitiveConnectionFields(previous, next)).toMatchObject({
      command: 'new',
      env: { TOKEN: 'secret' },
    })
  })

  test('Given SSE headers When 更新 URL Then 保留原 headers', () => {
    const previous = {
      type: 'sse' as const,
      url: 'https://example.com/old',
      headers: { Authorization: 'Bearer token' },
      enabled: true,
    }
    const next = buildWorkspaceMcpEntry({ name: 'remote', type: 'sse', url: 'https://example.com/new' })
    expect(preserveSensitiveConnectionFields(previous, next)).toMatchObject({
      url: 'https://example.com/new',
      headers: { Authorization: 'Bearer token' },
    })
  })

  test('Given 参数、timeout 或 OAuth 变化 When 比较 Then 判定为变更', () => {
    const previous = buildWorkspaceMcpEntry({
      name: 'local', type: 'stdio', command: 'npx', args: ['a'], timeout: 10,
    })
    expect(hasWorkspaceMcpTransportChanged(previous, { ...previous, args: ['b'] })).toBe(true)
    expect(hasWorkspaceMcpTransportChanged(previous, { ...previous, timeout: 20 })).toBe(true)
    expect(hasWorkspaceMcpTransportChanged(previous, {
      ...previous,
      oauth: { clientId: 'new' },
    })).toBe(true)
  })

  test('Given existing headers When a transport update arrives Then preserves credentials', () => {
    const previous = {
      type: 'http' as const,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      enabled: true,
    }
    const next = buildWorkspaceMcpEntry({ name: 'remote', type: 'http', url: 'https://example.com/mcp' })
    expect(preserveSensitiveConnectionFields(previous, next)).toMatchObject({
      headers: { Authorization: 'Bearer token' },
    })
  })
})
