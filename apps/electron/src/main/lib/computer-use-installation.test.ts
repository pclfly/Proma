import { describe, expect, test } from 'bun:test'
import { ComputerUseDriverError } from './computer-use-driver'
import {
  createComputerUseInstallationProbe,
  detectComputerUseInstallation,
  normalizeComputerUseDriverVersion,
  resolveComputerUsePlatform,
} from './computer-use-installation'

describe('Computer Use 平台映射', () => {
  test('Given 支持的平台 When 映射 Then 返回安装状态平台名', () => {
    expect(resolveComputerUsePlatform('darwin')).toBe('macos')
    expect(resolveComputerUsePlatform('win32')).toBe('windows')
    expect(resolveComputerUsePlatform('linux')).toBe('linux')
  })

  test('Given 未知平台 When 映射 Then unsupported', () => {
    expect(resolveComputerUsePlatform('freebsd')).toBe('unsupported')
  })
})

describe('Computer Use 版本行校验', () => {
  test('Given 标准版本行 When 归一化 Then 去除首尾空白', () => {
    expect(normalizeComputerUseDriverVersion('  cua-driver 1.2.3 \r\n')).toBe('cua-driver 1.2.3')
  })

  test('Given 带后缀的版本行 When 归一化 Then 保留完整行', () => {
    expect(normalizeComputerUseDriverVersion('cua-driver 0.9.12 (build 42)')).toBe(
      'cua-driver 0.9.12 (build 42)',
    )
  })

  test('Given 缺失补丁号 When 归一化 Then undefined', () => {
    expect(normalizeComputerUseDriverVersion('cua-driver 1.2')).toBeUndefined()
  })

  test('Given 多行输出 When 归一化 Then undefined', () => {
    expect(normalizeComputerUseDriverVersion('cua-driver 1.2.3\nmore')).toBeUndefined()
  })

  test('Given 超长输出 When 归一化 Then undefined', () => {
    expect(normalizeComputerUseDriverVersion(`cua-driver 1.2.3 ${'x'.repeat(130)}`)).toBeUndefined()
  })

  test('Given 空输出 When 归一化 Then undefined', () => {
    expect(normalizeComputerUseDriverVersion('   ')).toBeUndefined()
  })
})

describe('Computer Use 安装探测', () => {
  test('Given 平台不支持 When 探测 Then unsupported 且不解析路径', async () => {
    let resolved = false
    const summary = await detectComputerUseInstallation({
      platform: 'freebsd',
      resolvePath: () => {
        resolved = true
        return '/usr/bin/cua-driver'
      },
      readVersion: async () => 'cua-driver 1.0.0',
    })
    expect(summary).toEqual({ platform: 'unsupported', status: 'unsupported' })
    expect(resolved).toBe(false)
  })

  test('Given 未安装 When 探测 Then not_installed', async () => {
    const summary = await detectComputerUseInstallation({
      platform: 'win32',
      resolvePath: () => {
        throw new ComputerUseDriverError('driver_not_found')
      },
      readVersion: async () => '',
    })
    expect(summary).toEqual({ platform: 'windows', status: 'not_installed' })
  })

  test('Given 解析抛非驱动错误 When 探测 Then 继续抛出', async () => {
    await expect(
      detectComputerUseInstallation({
        platform: 'win32',
        resolvePath: () => {
          throw new Error('EACCES')
        },
        readVersion: async () => '',
      }),
    ).rejects.toThrow('EACCES')
  })

  test('Given 版本合法 When 探测 Then installed 且带路径与版本', async () => {
    const summary = await detectComputerUseInstallation({
      platform: 'darwin',
      resolvePath: () => '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      readVersion: async () => 'cua-driver 2.1.0\n',
    })
    expect(summary).toEqual({
      platform: 'macos',
      status: 'installed',
      driverPath: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      version: 'cua-driver 2.1.0',
    })
  })

  test('Given 版本输出异常 When 探测 Then needs_attention 但保留路径', async () => {
    const summary = await detectComputerUseInstallation({
      platform: 'linux',
      resolvePath: () => '/home/u/.local/bin/cua-driver',
      readVersion: async () => 'unknown',
    })
    expect(summary).toEqual({
      platform: 'linux',
      status: 'needs_attention',
      driverPath: '/home/u/.local/bin/cua-driver',
    })
  })

  test('Given 版本命令失败 When 探测 Then needs_attention 但保留路径', async () => {
    const summary = await detectComputerUseInstallation({
      platform: 'win32',
      resolvePath: () => 'C:\\Cua\\cua-driver.exe',
      readVersion: async () => {
        throw new Error('spawn failed')
      },
    })
    expect(summary).toEqual({
      platform: 'windows',
      status: 'needs_attention',
      driverPath: 'C:\\Cua\\cua-driver.exe',
    })
  })

  test('Given 并发探测 When 同时调用 Then 只解析一次并共享结果', async () => {
    let resolvePathCalls = 0
    let releaseVersion: ((value: string) => void) | undefined
    const probe = createComputerUseInstallationProbe({
      platform: 'win32',
      resolvePath: () => {
        resolvePathCalls += 1
        return 'C:\\Cua\\cua-driver.exe'
      },
      readVersion: () =>
        new Promise<string>((resolve) => {
          releaseVersion = resolve
        }),
    })

    const first = probe.getStatus()
    const second = probe.getStatus()
    expect(resolvePathCalls).toBe(1)
    releaseVersion?.('cua-driver 1.0.0')
    expect((await first).status).toBe('installed')
    expect((await second).status).toBe('installed')
  })
})
