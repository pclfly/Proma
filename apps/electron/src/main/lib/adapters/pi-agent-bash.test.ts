import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  appendWindowsBaseModeInstruction,
  buildWslBashArgs,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MAX_BASH_TIMEOUT_SECONDS,
  resolvePromaBashTimeoutSeconds,
  terminateProcessTree,
  windowsPathToWslPath,
  withPromaBashTimeout,
} from './pi-agent-adapter'

/** 只构造本条用得到的字段（env 空对象即可，提示词不读它）。 */
const gitBashEnv = { env: {}, shellKind: 'git-bash' } as const
const wslEnv = { env: {}, shellKind: 'wsl' } as const

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

})

describe('Windows Bash 工具的系统提示约束', () => {
  test('Given Windows + Git Bash When 拼提示 Then 明确它是 Git Bash 并禁止 cmd 语法', () => {
    const prompt = appendWindowsBaseModeInstruction('BASE', gitBashEnv, 'win32')

    expect(prompt).toContain('BASE')
    expect(prompt).toContain('Git Bash')
    // 三条最容易踩的 cmd 写法都要点名
    expect(prompt).toContain('cd /d')
    expect(prompt).toContain('dir /b')
    expect(prompt).toContain('%VAR%')
    // 并且给出 bash 侧的替代写法
    expect(prompt).toContain('ls')
  })

  test('Given Windows + WSL When 拼提示 Then 点名的是 WSL 里的 bash', () => {
    const prompt = appendWindowsBaseModeInstruction('BASE', wslEnv, 'win32')

    expect(prompt).toContain('WSL')
    expect(prompt).toContain('bash')
    expect(prompt).not.toContain('由 **Git Bash** 执行')
  })

  test('Given 非 Windows When 拼提示 Then 原样返回不加运行时说明', () => {
    expect(appendWindowsBaseModeInstruction('BASE', undefined, 'linux')).toBe('BASE')
    expect(appendWindowsBaseModeInstruction('BASE', undefined, 'darwin')).toBe('BASE')
  })

  test('Given Windows 无 Git Bash 也无 WSL When 拼提示 Then 走 PowerShell / 安装引导分支', () => {
    const prompt = appendWindowsBaseModeInstruction('BASE', undefined, 'win32')

    // 无任何 shell 配置时 selectWindowsShell 返回 null ⇒ 暴露 PowerShell 工具
    expect(prompt).toContain('PowerShell')
    expect(prompt).toContain('Get-ChildItem')
    // 不能把 bash 语法约束错贴到这个分支上
    expect(prompt).not.toContain('Git Bash** 执行')
  })
})

describe('Shell 工具超时兜底', () => {
  test('Given 未传 timeout When 解析 Then 使用 300 秒默认值', () => {
    expect(resolvePromaBashTimeoutSeconds(undefined)).toBe(DEFAULT_BASH_TIMEOUT_SECONDS)
  })

  test('Given 显式 timeout When 解析 Then 保留原值但封顶 3600 秒', () => {
    expect(resolvePromaBashTimeoutSeconds(30)).toBe(30)
    expect(resolvePromaBashTimeoutSeconds(MAX_BASH_TIMEOUT_SECONDS + 1)).toBe(MAX_BASH_TIMEOUT_SECONDS)
  })

  test('Given 非正数或非有限值 When 解析 Then 原样交给底层工具决定', () => {
    expect(resolvePromaBashTimeoutSeconds(0)).toBe(0)
    expect(resolvePromaBashTimeoutSeconds(-1)).toBe(-1)
    expect(resolvePromaBashTimeoutSeconds(Number.NaN)).toBeNaN()
    expect(resolvePromaBashTimeoutSeconds(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })

  test('Given 未传 timeout When 包装后的工具执行 Then 注入默认 300 秒', async () => {
    const calls: Array<{ params: unknown }> = []
    const definition = {
      name: 'bash',
      label: 'Bash',
      description: 'run shell',
      parameters: {},
      execute: async (_toolCallId: string, params: unknown) => {
        calls.push({ params })
        return { content: [] }
      },
    }
    const wrapped = withPromaBashTimeout(definition as unknown as ToolDefinition)

    await wrapped.execute('call-1', {}, undefined, undefined, {} as never)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toMatchObject({ timeout: DEFAULT_BASH_TIMEOUT_SECONDS })
    expect(wrapped.description).toContain('defaults to 300 seconds')
    expect(wrapped.description).toContain('capped at 3600 seconds')
  })

  test('Given 显式超上限 timeout When 包装后的工具执行 Then 传入 3600 秒', async () => {
    const calls: Array<{ params: unknown }> = []
    const definition = {
      name: 'bash',
      label: 'Bash',
      description: 'run shell',
      parameters: {},
      execute: async (_toolCallId: string, params: unknown) => {
        calls.push({ params })
        return { content: [] }
      },
    }
    const wrapped = withPromaBashTimeout(definition as unknown as ToolDefinition)

    await wrapped.execute('call-2', { timeout: 9_999 }, undefined, undefined, {} as never)

    expect(calls[0]?.params).toMatchObject({ timeout: MAX_BASH_TIMEOUT_SECONDS })
  })

  test('Given 未提供 pid When 终止进程树 Then 安全返回', () => {
    expect(() => terminateProcessTree(undefined)).not.toThrow()
  })
})
