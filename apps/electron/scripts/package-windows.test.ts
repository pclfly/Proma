import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanWindowsPackageOutput, createWindowsPackageSteps } from './package-windows'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Windows 一键打包流程', () => {
  test('Given 项目根目录 When 生成步骤 Then 先校验代码再生成 Windows 安装包', () => {
    const repoRoot = 'D:\\Proma'
    const steps = createWindowsPackageSteps(repoRoot)

    expect(steps.map((step) => [step.command, ...step.args])).toEqual([
      ['bun', 'install', '--frozen-lockfile'],
      ['bun', 'run', 'typecheck'],
      ['bun', 'test'],
      ['bun', 'run', 'dist:win'],
    ])
    expect(steps[3]).toEqual(expect.objectContaining({
      cwd: join(repoRoot, 'apps', 'electron'),
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    }))
  })

  test('Given 输出目录存在旧安装包 When 开始打包 Then 只清理当前项目输出目录', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'proma-package-'))
    const outputDir = join(repoRoot, 'apps', 'electron', 'out')
    const keepFile = join(repoRoot, 'keep.txt')
    tempDirs.push(repoRoot)
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(join(outputDir, 'old-installer.exe'), 'old')
    writeFileSync(keepFile, 'keep')

    expect(cleanWindowsPackageOutput(repoRoot)).toBe(outputDir)
    expect(existsSync(outputDir)).toBe(false)
    expect(existsSync(keepFile)).toBe(true)
  })
})
