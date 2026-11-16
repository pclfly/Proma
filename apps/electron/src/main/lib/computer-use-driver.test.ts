import { describe, expect, test } from 'bun:test'
import { win32 } from 'node:path'
import {
  ComputerUseAuthorizationError,
  ComputerUseDriverError,
  ComputerUseDriverResolver,
  checkComputerUseDriverResponse,
  classifyComputerUseDriverError,
  createComputerUseDriverClient,
  parseComputerUseDriverPath,
  type ComputerUseDriverEnvironment,
  type ComputerUseDriverRunResult,
} from './computer-use-driver'

function createEnvironment(
  overrides: Partial<ComputerUseDriverEnvironment> = {},
): ComputerUseDriverEnvironment {
  const environment: ComputerUseDriverEnvironment = {
    platform: 'win32',
    home: 'C:\\Users\\tester',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
    path: 'C:\\Tools',
    recordVersion: () => '',
    readRecord: () => '',
    isFile: () => false,
  }
  Object.assign(environment, overrides)
  return environment
}

const defaultDriverPath = win32.join(
  'C:\\Users\\tester\\AppData\\Local',
  'Programs',
  'Cua',
  'cua-driver',
  'bin',
  'cua-driver.exe',
)

describe('Computer Use driver 路径解析', () => {
  test('Given driver_path 绝对路径 When 解析 Then 返回规范化路径', () => {
    const record = 'driver_path: C:\\Tools\\cua-driver.exe\n'
    expect(parseComputerUseDriverPath(record, 'win32')).toBe('C:\\Tools\\cua-driver.exe')
  })

  test('Given 中文“绝对路径”字段 When 解析 Then 同样识别', () => {
    const record = '- 绝对路径：C:\\Apps\\Cua\\cua-driver.exe\n'
    expect(parseComputerUseDriverPath(record, 'win32')).toBe('C:\\Apps\\Cua\\cua-driver.exe')
  })

  test('Given 路径带引号 When 解析 Then 去掉引号', () => {
    const record = 'Driver 路径: "C:\\Apps\\cua-driver.exe"\n'
    expect(parseComputerUseDriverPath(record, 'win32')).toBe('C:\\Apps\\cua-driver.exe')
  })

  test('Given 相对路径 When 解析 Then 忽略', () => {
    expect(parseComputerUseDriverPath('driver_path: .\\bin\\cua-driver.exe', 'win32')).toBeUndefined()
  })

  test('Given basename 不是 cua-driver.exe When 解析 Then 忽略', () => {
    expect(parseComputerUseDriverPath('driver_path: C:\\Tools\\other.exe', 'win32')).toBeUndefined()
  })

  test('Given 多个 driver_path When 解析 Then 无法唯一确定时返回 undefined', () => {
    const record = [
      'driver_path: C:\\A\\cua-driver.exe',
      'driver_path: C:\\B\\cua-driver.exe',
    ].join('\n')
    expect(parseComputerUseDriverPath(record, 'win32')).toBeUndefined()
  })

  test('Given driver_path 与绝对路径同时存在 When 解析 Then 显式 driver_path 优先', () => {
    const record = ['绝对路径: C:\\A\\cua-driver.exe', 'driver_path: C:\\B\\cua-driver.exe'].join(
      '\n',
    )
    expect(parseComputerUseDriverPath(record, 'win32')).toBe('C:\\B\\cua-driver.exe')
  })

  test('Given posix 平台 When 解析 Then 使用 posix basename 与绝对路径判定', () => {
    const record = 'driver_path: /opt/cua/bin/cua-driver'
    expect(parseComputerUseDriverPath(record, 'darwin')).toBe('/opt/cua/bin/cua-driver')
    expect(parseComputerUseDriverPath('driver_path: /opt/cua/bin/cua-driver.exe', 'darwin'))
      .toBeUndefined()
  })
})

describe('Computer Use driver resolver', () => {
  test('Given 记录文件指向存在的 driver When resolve Then 优先使用记录路径', () => {
    const recordPath = 'C:\\Tools\\cua-driver.exe'
    const resolver = new ComputerUseDriverResolver(
      createEnvironment({
        readRecord: () => `driver_path: ${recordPath}`,
        isFile: (path) => path.toLowerCase() === recordPath.toLowerCase(),
      }),
    )
    expect(resolver.resolve()).toBe(recordPath)
  })

  test('Given 无记录 When resolve Then 回退到 LocalAppData 默认安装目录', () => {
    const resolver = new ComputerUseDriverResolver(
      createEnvironment({
        isFile: (path) => path.toLowerCase() === defaultDriverPath.toLowerCase(),
      }),
    )
    expect(resolver.resolve()).toBe(defaultDriverPath)
  })

  test('Given PATH 中带引号的目录 When resolve Then 去引号后查找', () => {
    const toolsDir = 'D:\\Apps\\bin'
    const expected = win32.join(toolsDir, 'cua-driver.exe')
    const resolver = new ComputerUseDriverResolver(
      createEnvironment({
        path: `"${toolsDir}";E:\\other`,
        isFile: (path) => path.toLowerCase() === expected.toLowerCase(),
      }),
    )
    expect(resolver.resolve()).toBe(expected)
  })

  test('Given 记录版本未变化 When 连续 resolve Then 复用缓存', () => {
    let version = 'a'
    let reads = 0
    const resolver = new ComputerUseDriverResolver(
      createEnvironment({
        recordVersion: () => version,
        readRecord: () => {
          reads += 1
          return 'driver_path: C:\\Tools\\cua-driver.exe'
        },
        isFile: () => true,
      }),
    )
    resolver.resolve()
    resolver.resolve()
    expect(reads).toBe(1)
    version = 'b'
    resolver.resolve()
    expect(reads).toBe(2)
  })

  test('Given 缓存文件被删除 When resolve Then 重新解析', () => {
    let exists = true
    let reads = 0
    const resolver = new ComputerUseDriverResolver(
      createEnvironment({
        readRecord: () => {
          reads += 1
          return 'driver_path: C:\\Tools\\cua-driver.exe'
        },
        isFile: () => exists,
      }),
    )
    resolver.resolve()
    exists = false
    expect(() => resolver.resolve()).toThrow(ComputerUseDriverError)
    expect(reads).toBe(2)
  })

  test('Given 所有候选都不存在 When resolve Then 抛出 driver_not_found', () => {
    const resolver = new ComputerUseDriverResolver(createEnvironment())
    try {
      resolver.resolve()
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerUseDriverError)
      expect((error as ComputerUseDriverError).code).toBe('driver_not_found')
    }
  })
})

describe('Computer Use driver 错误归一化', () => {
  test('Given 窗口失效细节 When 分类 Then window_unavailable', () => {
    expect(classifyComputerUseDriverError('window_owner_pid_mismatch').code).toBe(
      'window_unavailable',
    )
    expect(classifyComputerUseDriverError('stale hwnd 0x80070578').code).toBe('window_unavailable')
  })

  test('Given 桌面锁屏 When 分类 Then desktop_unavailable', () => {
    expect(classifyComputerUseDriverError('screen_locked').code).toBe('desktop_unavailable')
  })

  test('Given 前台激活被拒 When 分类 Then activation_blocked', () => {
    expect(classifyComputerUseDriverError('"landed_on_target": false').code).toBe(
      'activation_blocked',
    )
  })

  test('Given 权限错误 When 分类 Then permission_denied', () => {
    expect(classifyComputerUseDriverError('EACCES: permission denied').code).toBe(
      'permission_denied',
    )
    expect(classifyComputerUseDriverError('UIPI blocked').code).toBe('permission_denied')
  })

  test('Given 超时 When 分类 Then timeout 且优先于采集失败', () => {
    expect(classifyComputerUseDriverError('timed out').code).toBe('timeout')
    expect(classifyComputerUseDriverError('timeout while screenshot failed').code).toBe('timeout')
  })

  test('Given 采集失败 When 分类 Then capture_failed', () => {
    expect(classifyComputerUseDriverError('px_frame_mismatch').code).toBe('capture_failed')
  })

  test('Given 未知细节 When 分类 Then driver_error 且带中文文案', () => {
    const error = classifyComputerUseDriverError('unexpected boom')
    expect(error.code).toBe('driver_error')
    expect(error.message).toContain('Cua Driver')
  })
})

describe('Computer Use driver 响应校验', () => {
  test('Given 非 JSON When 校验 Then 不抛错', () => {
    expect(() => checkComputerUseDriverResponse('not json')).not.toThrow()
  })

  test('Given success true When 校验 Then 通过', () => {
    expect(() => checkComputerUseDriverResponse('{"success":true}')).not.toThrow()
  })

  test('Given success false When 校验 Then driver_error', () => {
    expect(() => checkComputerUseDriverResponse('{"success":false}')).toThrow(ComputerUseDriverError)
  })

  test('Given structuredContent.isError When 校验 Then 抛错', () => {
    expect(() =>
      checkComputerUseDriverResponse('{"structuredContent":{"isError":true}}'),
    ).toThrow(ComputerUseDriverError)
  })

  test('Given landed_on_target false When 校验 Then activation_blocked', () => {
    try {
      checkComputerUseDriverResponse('{"landed_on_target":false}')
      throw new Error('expected throw')
    } catch (error) {
      expect((error as ComputerUseDriverError).code).toBe('activation_blocked')
    }
  })

  test('Given error 字段包含采集失败 When 校验 Then capture_failed', () => {
    try {
      checkComputerUseDriverResponse('{"error":"px_frame_mismatch"}')
      throw new Error('expected throw')
    } catch (error) {
      expect((error as ComputerUseDriverError).code).toBe('capture_failed')
    }
  })
})

describe('Computer Use driver client 授权闸门', () => {
  test('Given 未授权 When call Then 拒绝且不执行驱动', async () => {
    let invoked = false
    const client = createComputerUseDriverClient({
      authorization: 'unrequested',
      resolvePath: () => 'C:\\Tools\\cua-driver.exe',
      invoke: async () => {
        invoked = true
        return { stdout: '{}', stderr: '' }
      },
    })
    await expect(client.call('get_window_state', { pid: 1 })).rejects.toBeInstanceOf(
      ComputerUseAuthorizationError,
    )
    expect(invoked).toBe(false)
  })

  test('Given 已授权 When call Then 组装 call 参数并返回 stdout', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const client = createComputerUseDriverClient({
      authorization: 'granted',
      resolvePath: () => 'C:\\Tools\\cua-driver.exe',
      invoke: async (file, args): Promise<ComputerUseDriverRunResult> => {
        calls.push({ file, args })
        return { stdout: '{"success":true}', stderr: '' }
      },
    })
    const stdout = await client.call('get_window_state', { pid: 7 })
    expect(stdout).toBe('{"success":true}')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['call', 'get_window_state', '{"pid":7}'])
  })

  test('Given 首次 ENOENT When call Then invalidate 后重试一次成功', async () => {
    let attempts = 0
    let invalidated = 0
    const client = createComputerUseDriverClient({
      authorization: 'granted',
      resolvePath: () => 'C:\\Tools\\cua-driver.exe',
      invalidate: () => {
        invalidated += 1
      },
      invoke: async () => {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { stdout: '{"success":true}', stderr: '' }
      },
    })
    await client.call('list_windows', {})
    expect(attempts).toBe(2)
    expect(invalidated).toBe(1)
  })

  test('Given 持续 ENOENT When call Then driver_not_found', async () => {
    let attempts = 0
    const client = createComputerUseDriverClient({
      authorization: 'granted',
      resolvePath: () => 'C:\\Tools\\cua-driver.exe',
      invoke: async () => {
        attempts += 1
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
    })
    try {
      await client.call('list_windows', {})
      throw new Error('expected throw')
    } catch (error) {
      expect((error as ComputerUseDriverError).code).toBe('driver_not_found')
    }
    expect(attempts).toBe(2)
  })

  test('Given 进程被 kill When call Then timeout', async () => {
    const client = createComputerUseDriverClient({
      authorization: 'granted',
      resolvePath: () => 'C:\\Tools\\cua-driver.exe',
      invoke: async () => {
        throw Object.assign(new Error('killed'), { killed: true })
      },
    })
    try {
      await client.call('get_desktop_state', {})
      throw new Error('expected throw')
    } catch (error) {
      expect((error as ComputerUseDriverError).code).toBe('timeout')
    }
  })

  test('Given 驱动返回 success false When call Then 抛出归一化错误', async () => {
    const client = createComputerUseDriverClient({
      authorization: 'granted',
      resolvePath: () => 'C:\\Tools\\cua-driver.exe',
      invoke: async () => ({ stdout: '{"success":false}', stderr: '' }),
    })
    await expect(client.call('get_window_state', {})).rejects.toBeInstanceOf(ComputerUseDriverError)
  })
})
