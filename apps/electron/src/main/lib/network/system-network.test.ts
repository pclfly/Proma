import { describe, expect, test } from 'bun:test'
import { NetworkRequestError } from './network-errors'
import { createNetworkDiagnostics } from './network-diagnostics'
import { createNetworkDiagnosticExporter } from './network-diagnostics-export'
import { createNetworkRecovery, createNetworkChangeMonitor } from './network-recovery'
import { createNetworkStartupGate } from './network-startup'
import { createBrowserNetworkGate } from './browser-network'
import { createChromiumFetch } from './system-fetch'
import { createSystemNetworkService } from './system-network-service'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('网络启动门禁', () => {
  test('Given 策略未就绪 When 登记任务 Then 不执行；就绪后按序执行', () => {
    const ran: string[] = []
    const gate = createNetworkStartupGate((name) => ran.push(`error:${name}`))
    gate.add('a', () => {
      ran.push('a')
    })
    gate.add('b', () => {
      ran.push('b')
    })
    expect(ran).toEqual([])
    gate.setReady(true)
    return Promise.resolve().then(() => {
      expect(ran).toEqual(['a', 'b'])
    })
  })

  test('Given 已登记或已就绪 When 再次登记 Then 去重且立即执行', () => {
    const ran: string[] = []
    const gate = createNetworkStartupGate((name) => ran.push(`error:${name}`))
    gate.add('a', () => {
      ran.push('a')
    })
    gate.setReady(true)
    gate.add('a', () => {
      ran.push('a2')
    })
    return Promise.resolve().then(() => {
      expect(ran).toEqual(['a'])
      gate.add('b', () => {
        ran.push('b')
      })
      return Promise.resolve().then(() => expect(ran).toEqual(['a', 'b']))
    })
  })

  test('Given 任务失败 When 执行 Then 回调错误名且不阻断后续任务', async () => {
    const events: string[] = []
    const gate = createNetworkStartupGate((name) => events.push(`error:${name}`))
    gate.add('bad', () => {
      throw new Error('boom')
    })
    gate.add('good', () => {
      events.push('good')
    })
    gate.setReady(true)
    await sleep(5)
    expect(events).toEqual(['good', 'error:bad'])
  })
})

describe('网络恢复调度', () => {
  test('Given 可恢复传输错误 When 连续通知 Then 合并为一次恢复', async () => {
    const reasons: string[] = []
    const recovery = createNetworkRecovery({
      debounceMs: 1,
      cooldownMs: 0,
      recover: async (reason) => {
        reasons.push(reason)
      },
    })
    recovery.notify('transport-error', Object.assign(new Error('x'), { code: 'ERR_CONNECTION_REFUSED' }))
    recovery.notify('transport-error', Object.assign(new Error('x'), { code: 'ERR_CONNECTION_REFUSED' }))
    await sleep(20)
    expect(reasons).toEqual(['transport-error'])
    recovery.dispose()
  })

  test('Given 不可恢复错误 When 通知 Then 不触发恢复', async () => {
    const reasons: string[] = []
    const recovery = createNetworkRecovery({
      debounceMs: 1,
      recover: async (reason) => {
        reasons.push(reason)
      },
    })
    recovery.notify('transport-error', new NetworkRequestError('cancelled'))
    await sleep(15)
    expect(reasons).toEqual([])
    recovery.dispose()
  })

  test('Given dispose When 通知 Then 不再恢复', async () => {
    const reasons: string[] = []
    const recovery = createNetworkRecovery({
      debounceMs: 1,
      recover: async (reason) => {
        reasons.push(reason)
      },
    })
    recovery.dispose()
    recovery.notify('online')
    await sleep(15)
    expect(reasons).toEqual([])
  })
})

describe('网络变化监测', () => {
  test('Given 指纹变化 When 采样 Then 触发一次 onChange', async () => {
    let value = 'a'
    let changes = 0
    const stop = createNetworkChangeMonitor({
      intervalMs: 5,
      sample: async () => value,
      onChange: () => {
        changes += 1
      },
    })
    await sleep(15)
    value = 'b'
    await sleep(20)
    stop()
    expect(changes).toBe(1)
  })
})

describe('系统网络服务', () => {
  function createService(options: {
    failFetch?: Error
    policyTimeoutMs?: number
    configure?: () => Promise<void>
  } = {}) {
    const calls: string[] = []
    const sessions = new Map<string, {
      setProxy: (config: { mode: 'system' }) => Promise<void>
      forceReloadProxyConfig: () => Promise<void>
      clearHostResolverCache: () => Promise<void>
      fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    }>()
    const service = createSystemNetworkService({
      configureUtility: options.configure ?? (async () => {
        calls.push('configure')
      }),
      policyTimeoutMs: options.policyTimeoutMs,
      createSession(scope) {
        const target = {
          setProxy: async () => {
            calls.push(`proxy:${scope}`)
          },
          forceReloadProxyConfig: async () => {
            calls.push(`reload:${scope}`)
          },
          clearHostResolverCache: async () => {
            calls.push(`dns:${scope}`)
          },
          fetch: async () => {
            if (options.failFetch) throw options.failFetch
            return new Response('ok')
          },
        }
        sessions.set(scope, target)
        return target
      },
    })
    return { service, calls, sessions }
  }

  test('Given 初始化 When 完成 Then 五个作用域都设置系统代理并广播 ready', async () => {
    const { service, calls } = createService()
    const snapshots: string[] = []
    service.subscribe((snapshot) => snapshots.push(snapshot.status))
    expect(service.snapshot()).toEqual({ policy: 'system', networkEpoch: 0, status: 'recovering' })
    await service.initialize()
    expect(service.snapshot().status).toBe('ready')
    expect(calls.filter((call) => call.startsWith('proxy:'))).toHaveLength(5)
    expect(snapshots).toEqual(['ready'])
  })

  test('Given 策略超时 When 初始化 Then 状态 unreachable 且抛 timeout', async () => {
    const { service } = createService({
      policyTimeoutMs: 5,
      configure: () => new Promise<void>(() => {}),
    })
    await expect(service.initialize()).rejects.toMatchObject({ kind: 'timeout' })
    expect(service.snapshot().status).toBe('unreachable')
  })

  test('Given 已就绪 When fetch Then 走对应 session 且 credentials omit', async () => {
    const { service, sessions } = createService()
    await service.initialize()
    let received: RequestInit | undefined
    sessions.get('model')!.fetch = async (_input, init) => {
      received = init
      return new Response('model-ok')
    }
    const response = await service.getFetch('model')('https://example.com/v1')
    expect(await response.text()).toBe('model-ok')
    expect(received?.credentials).toBe('omit')
  })

  test('Given 未初始化 When fetch Then 自动初始化后请求', async () => {
    const { service } = createService()
    const response = await service.getFetch('mcp')('https://example.com')
    expect(await response.text()).toBe('ok')
    expect(service.snapshot().status).toBe('ready')
  })

  test('Given 传输失败 When fetch Then 归一为 NetworkRequestError 并上报', async () => {
    const failures: unknown[] = []
    const service = createSystemNetworkService({
      configureUtility: async () => undefined,
      onTransportFailure: (error) => failures.push(error),
      createSession: () => ({
        setProxy: async () => undefined,
        forceReloadProxyConfig: async () => undefined,
        clearHostResolverCache: async () => undefined,
        fetch: async () => {
          throw Object.assign(new Error('proxy down'), { code: 'ERR_PROXY_CONNECTION_FAILED' })
        },
      }),
    })
    await service.initialize()
    await expect(service.getFetch('cloud')('https://example.com')).rejects.toMatchObject({
      kind: 'proxy-unreachable',
      scope: 'cloud',
      causeCode: 'ERR_PROXY_CONNECTION_FAILED',
    })
    expect(failures).toHaveLength(1)
  })

  test('Given 恢复 When 完成 Then 刷新代理与 DNS 并递增 epoch', async () => {
    const { service, calls } = createService()
    await service.initialize()
    const snapshot = await service.recover('user-reconnect')
    expect(snapshot.networkEpoch).toBe(1)
    expect(snapshot.status).toBe('ready')
    expect(calls.filter((call) => call.startsWith('reload:'))).toHaveLength(5)
    expect(calls.filter((call) => call.startsWith('dns:'))).toHaveLength(5)
  })

  test('Given 已取消信号 When ensureReady Then 抛 AbortError', async () => {
    const { service } = createService()
    const controller = new AbortController()
    controller.abort()
    await expect(service.ensureReady(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('Chromium 系统 fetch', () => {
  test('Given 非 http(s) 或带凭据 When 请求 Then 拒绝', async () => {
    const transport = createChromiumFetch(async () => new Response('ok'))
    await expect(transport('file:///tmp/a')).rejects.toBeInstanceOf(NetworkRequestError)
    await expect(transport('https://user:pass@example.com')).rejects.toBeInstanceOf(NetworkRequestError)
  })

  test('Given 自定义凭据头 When 请求 Then redirect error 且 credentials omit', async () => {
    let init: RequestInit | undefined
    const transport = createChromiumFetch(async (_input, options) => {
      init = options
      return new Response('ok')
    })
    await transport('https://example.com/api', { headers: { Authorization: 'Bearer x' } })
    expect(init?.redirect).toBe('error')
    expect(init?.credentials).toBe('omit')
    expect((init as RequestInit & { bypassCustomProtocolHandlers?: boolean }).bypassCustomProtocolHandlers)
      .toBe(true)
  })

  test('Given 公开 GET When 请求 Then 允许默认重定向策略', async () => {
    let init: RequestInit | undefined
    const transport = createChromiumFetch(async (_input, options) => {
      init = options
      return new Response('ok')
    })
    await transport('https://example.com/')
    expect(init?.redirect).toBeUndefined()
  })

  test('Given 响应 When 读取 Then 保留 url/status 与响应体', async () => {
    const transport = createChromiumFetch(async () => new Response('body', {
      status: 201,
      headers: { 'x-test': '1' },
    }))
    const response = await transport('https://example.com/')
    expect(response.status).toBe(201)
    expect(response.headers.get('x-test')).toBe('1')
    expect(await response.text()).toBe('body')
  })

})

describe('浏览器系统网络门禁', () => {
  test('Given 首次与同 epoch When 进入 Then 只设置一次系统代理', async () => {
    let epoch = 0
    let proxy = 0
    let reload = 0
    const gate = createBrowserNetworkGate({
      ensureReady: async () => undefined,
      snapshot: () => ({ networkEpoch: epoch }),
    })
    const session = {
      setProxy: async () => {
        proxy += 1
      },
      forceReloadProxyConfig: async () => {
        reload += 1
      },
    }
    await gate(session)
    await gate(session)
    expect(proxy).toBe(1)
    expect(reload).toBe(0)
    epoch = 1
    await gate(session)
    expect(reload).toBe(1)
  })
})

describe('网络诊断', () => {
  test('Given 成功与失败请求 When 记录 Then 目标只保留 HMAC 前缀', async () => {
    let now = 0
    const diagnostics = createNetworkDiagnostics({
      fetch: async () => new Response('ok'),
      snapshot: () => ({ policy: 'system', networkEpoch: 2, status: 'ready' }),
      clientVersion: '0.22.0',
      platform: 'win32',
      now: () => now,
    })
    const success = diagnostics.wrapFetch(async () => {
      now = 12
      return new Response('ok', { status: 204 })
    }, 'model')
    await success('https://api.example.com/v1?token=secret')
    const failing = diagnostics.wrapFetch(async () => {
      throw Object.assign(new Error('dns'), { code: 'ERR_NAME_NOT_RESOLVED' })
    }, 'mcp')
    await expect(failing('https://other.example.com')).rejects.toThrow()
    const report = diagnostics.preview()
    expect(report.records).toHaveLength(2)
    expect(report.records[0]).toMatchObject({ outcome: 'response', status: 204, durationMs: 12, epoch: 2 })
    expect(report.records[0]?.targetId).toMatch(/^[a-f0-9]{16}$/)
    expect(report.records[0]?.targetId).not.toContain('example')
    expect(report.records[1]).toMatchObject({
      outcome: 'failed',
      failure: 'dns',
      errorCode: 'ERR_NAME_NOT_RESOLVED',
    })
  })

  test('Given 预览 ID When 导出 Then 5 分钟内可读取，过期后失效', () => {
    let now = 0
    const diagnostics = createNetworkDiagnostics({
      fetch: async () => new Response('ok'),
      snapshot: () => ({ policy: 'system', networkEpoch: 0, status: 'ready' }),
      clientVersion: '0.22.0',
      platform: 'win32',
      now: () => now,
    })
    const report = diagnostics.preview()
    expect(diagnostics.reportForExport(report.id)?.id).toBe(report.id)
    now = 300_001
    expect(diagnostics.reportForExport(report.id)).toBeUndefined()
  })

  test('Given 无效或过期报告 When 导出 Then 拒绝', async () => {
    const exporter = createNetworkDiagnosticExporter({
      reportForExport: () => undefined,
      chooseFile: async () => ({ canceled: false, filePath: 'x.json' }),
      write: () => undefined,
    })
    await expect(exporter('x'.repeat(81))).rejects.toThrow('诊断预览无效')
    await expect(exporter('missing')).rejects.toThrow('诊断预览已过期')
  })

  test('Given 用户取消 When 导出 Then 返回未保存且不写文件', async () => {
    let writes = 0
    const exporter = createNetworkDiagnosticExporter({
      reportForExport: () => ({
        id: 'r1',
        schemaVersion: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        clientVersion: '0.22.0',
        platform: 'win32',
        network: { policy: 'system', networkEpoch: 0, status: 'ready' },
        records: [],
      }),
      chooseFile: async () => ({ canceled: true }),
      write: () => {
        writes += 1
      },
    })
    await expect(exporter('r1')).resolves.toEqual({ saved: false })
    expect(writes).toBe(0)
  })

  test('Given 保存成功 When 导出 Then 写入同一份报告', async () => {
    let written: string | undefined
    const report = {
      id: 'r1',
      schemaVersion: 1 as const,
      generatedAt: '2026-01-01T00:00:00.000Z',
      clientVersion: '0.22.0',
      platform: 'win32',
      network: { policy: 'system' as const, networkEpoch: 0, status: 'ready' as const },
      records: [],
    }
    const exporter = createNetworkDiagnosticExporter({
      reportForExport: () => report,
      chooseFile: async () => ({ canceled: false, filePath: 'report.json' }),
      write: (path, value) => {
        written = `${path}:${value.id}`
      },
    })
    await expect(exporter('r1')).resolves.toEqual({ saved: true })
    expect(written).toBe('report.json:r1')
  })

  test('Given 主动探测 When check Then 记录健康检查结果', async () => {
    const calls: string[] = []
    const diagnostics = createNetworkDiagnostics({
      fetch: async (input) => {
        calls.push(String(input))
        return new Response('ok', { status: 200 })
      },
      snapshot: () => ({ policy: 'system', networkEpoch: 0, status: 'ready' }),
      clientVersion: '0.22.0',
      platform: 'win32',
    })
    const report = await diagnostics.check()
    expect(calls[0]).toBe('https://api.proma.cool/api/health')
    expect(report.probe).toMatchObject({ target: 'proma-public-health', outcome: 'response', status: 200 })
  })
})
