#!/usr/bin/env bun
/** Windows 一键打包流程。 */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface PackageStep {
  name: string
  cwd: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export function createWindowsPackageSteps(repoRoot: string): PackageStep[] {
  const electronDir = join(repoRoot, 'apps', 'electron')
  return [
    {
      name: '安装锁定依赖',
      cwd: repoRoot,
      command: 'bun',
      args: ['install', '--frozen-lockfile'],
    },
    {
      name: 'TypeScript 类型检查',
      cwd: repoRoot,
      command: 'bun',
      args: ['run', 'typecheck'],
    },
    {
      name: '运行测试',
      cwd: repoRoot,
      command: 'bun',
      args: ['test'],
    },
    {
      name: '生成 Windows 安装包',
      cwd: electronDir,
      command: 'bun',
      args: ['run', 'dist:win'],
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    },
  ]
}

export function cleanWindowsPackageOutput(repoRoot: string): string {
  const outputDir = join(repoRoot, 'apps', 'electron', 'out')
  rmSync(outputDir, { recursive: true, force: true })
  return outputDir
}

function runStep(step: PackageStep, index: number, total: number): boolean {
  console.log(`\n[${index}/${total}] ${step.name}`)
  console.log('='.repeat(64))
  const startedAt = Date.now()
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: { ...process.env, ...step.env },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (result.status === 0) {
    console.log(`[完成] ${step.name} (${seconds}s)`)
    return true
  }
  if (result.error) console.error(`[错误] ${result.error.message}`)
  console.error(`[失败] ${step.name}，退出码: ${result.status ?? 'unknown'}`)
  return false
}

export function runWindowsPackage(repoRoot: string): number {
  if (process.platform !== 'win32') {
    console.error('该脚本只用于 Windows 打包。')
    return 1
  }

  const steps = createWindowsPackageSteps(repoRoot)
  const outputDir = join(repoRoot, 'apps', 'electron', 'out')
  console.log('\nProma Windows 一键打包')
  console.log(`项目目录: ${repoRoot}`)

  for (const [index, step] of steps.entries()) {
    if (index === steps.length - 1) {
      cleanWindowsPackageOutput(repoRoot)
      console.log(`\n已清理旧产物: ${outputDir}`)
    }
    if (!runStep(step, index + 1, steps.length)) return 1
  }

  console.log('\n打包成功。')
  console.log(`安装包目录: ${outputDir}`)
  return 0
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..', '..', '..')
  process.exit(runWindowsPackage(repoRoot))
}
