import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildPresentTools,
  type PresentToolResult,
  type PresentToolsContext,
} from './pi-present-tools'

interface TestToolResult {
  content: Array<{ text: string }>
  details: unknown
}

interface TestTool {
  name: string
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<TestToolResult>
}

interface PresentFixture {
  root: string
  agentCwd: string
  extraRoot: string
  outsideDir: string
  hasEscapeJunction: boolean
  cleanup: () => void
}

function createFixture(): PresentFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-present-'))
  const agentCwd = join(root, 'agent-cwd')
  const extraRoot = join(root, 'extra-root')
  const outsideDir = join(root, 'outside')
  mkdirSync(agentCwd, { recursive: true })
  mkdirSync(extraRoot, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(join(agentCwd, 'folder'), { recursive: true })
  writeFileSync(join(agentCwd, 'report.md'), '# 报告\n')
  writeFileSync(join(agentCwd, 'data.csv'), 'a,b\n')
  writeFileSync(join(extraRoot, 'asset.bin'), 'asset')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')

  let hasEscapeJunction = false
  try {
    symlinkSync(outsideDir, join(agentCwd, 'escape'), 'junction')
    hasEscapeJunction = true
  } catch {
    // 平台或权限不支持创建目录链接时跳过逃逸用例。
  }

  return {
    root,
    agentCwd,
    extraRoot,
    outsideDir,
    hasEscapeJunction,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  }
}

function canCreateJunction(): boolean {
  const probeRoot = mkdtempSync(join(tmpdir(), 'proma-present-probe-'))
  try {
    mkdirSync(join(probeRoot, 'target'))
    symlinkSync(join(probeRoot, 'target'), join(probeRoot, 'link'), 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(probeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}

const junctionSupported = canCreateJunction()

function presentTool(ctx: PresentToolsContext): TestTool {
  const sdk = {
    defineTool: (tool: TestTool) => tool,
  } as unknown as typeof import('@earendil-works/pi-coding-agent')
  const tools = buildPresentTools(sdk, ctx) as unknown as TestTool[]
  const tool = tools.find((candidate) => candidate.name === 'Present')
  if (!tool) throw new Error('缺少 Present 工具')
  return tool
}

async function declare(tool: TestTool, files: unknown): Promise<PresentToolResult> {
  const result = await tool.execute('present-call', { files })
  return JSON.parse(result.content[0]!.text) as PresentToolResult
}

function canonical(path: string): string {
  return realpathSync(path)
}

describe('Present 交付物声明工具', () => {
  test('Given 工作目录内文件 When 声明 Then 返回 realpath 绝对路径、文件名与去空白说明', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      const result = await declare(tool, [
        { path: 'report.md', description: '  最终报告  ' },
        { path: join(fixture.agentCwd, 'data.csv') },
      ])

      expect(result.files).toHaveLength(2)
      expect(result.files[0]).toEqual({
        path: canonical(join(fixture.agentCwd, 'report.md')),
        name: 'report.md',
        description: '最终报告',
      })
      expect(result.files[1]).toEqual({
        path: canonical(join(fixture.agentCwd, 'data.csv')),
        name: 'data.csv',
      })
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 额外授权根内文件 When 声明 Then 允许', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd, allowedRoots: [fixture.extraRoot] })
      const result = await declare(tool, [{ path: join(fixture.extraRoot, 'asset.bin') }])
      expect(result.files[0]?.path).toBe(canonical(join(fixture.extraRoot, 'asset.bin')))
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 授权根之外的文件 When 声明 Then 拒绝', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      await expect(tool.execute('call', {
        files: [{ path: join(fixture.outsideDir, 'secret.txt') }],
      })).rejects.toThrow('超出授权目录')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 目录或根目录本身 When 声明 Then 拒绝非普通文件', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      await expect(tool.execute('call', {
        files: [{ path: 'folder' }],
      })).rejects.toThrow('不是普通文件')
      await expect(tool.execute('call', {
        files: [{ path: fixture.agentCwd }],
      })).rejects.toThrow('不是普通文件')
    } finally {
      fixture.cleanup()
    }
  })

  test.skipIf(!junctionSupported)('Given 目录链接指向根外 When 声明链接内文件 Then 拒绝链接逃逸', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      await expect(tool.execute('call', {
        files: [{ path: join('escape', 'secret.txt') }],
      })).rejects.toThrow('超出授权目录')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 同一文件的不同写法 When 声明 Then 按 realpath 去重', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      const result = await declare(tool, [
        { path: 'report.md' },
        { path: join(fixture.agentCwd, 'report.md') },
        { path: 'report.md', description: '重复项应被忽略' },
      ])
      expect(result.files).toHaveLength(1)
      expect(result.files[0]?.description).toBeUndefined()
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 超过 8 个交付物 When 声明 Then 拒绝整次声明', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      const files: Array<{ path: string }> = []
      for (let index = 0; index < 9; index += 1) {
        const path = join(fixture.agentCwd, `deliverable-${index}.txt`)
        writeFileSync(path, String(index))
        files.push({ path })
      }
      await expect(declare(tool, files)).rejects.toThrow('最多声明 8 个交付物文件')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 空路径、空数组或不存在文件 When 声明 Then 拒绝并给出明确原因', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      await expect(tool.execute('call', { files: [{ path: '   ' }] })).rejects.toThrow('不能为空')
      await expect(tool.execute('call', { files: [] })).rejects.toThrow('至少声明 1 个交付物文件')
      await expect(tool.execute('call', { files: [{ path: 'missing.md' }] })).rejects.toThrow('不存在或无法访问')
      await expect(tool.execute('call', { files: [{ path: 42 }] })).rejects.toThrow('路径必须是字符串')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 非法参数结构 When 声明 Then 拒绝而不是抛出未捕获异常', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: fixture.agentCwd })
      await expect(tool.execute('call', { files: 'report.md' })).rejects.toThrow('至少声明 1 个交付物文件')
      await expect(tool.execute('call', { files: [null] })).rejects.toThrow('每一项都必须是')
    } finally {
      fixture.cleanup()
    }
  })

  test('Given 授权根不可用 When 声明 Then 拒绝所有路径', async () => {
    const fixture = createFixture()
    try {
      const tool = presentTool({ agentCwd: join(fixture.root, 'not-exists') })
      await expect(tool.execute('call', {
        files: [{ path: join(fixture.agentCwd, 'report.md') }],
      })).rejects.toThrow('没有可用的授权目录')
    } finally {
      fixture.cleanup()
    }
  })
})
