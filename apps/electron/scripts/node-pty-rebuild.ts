#!/usr/bin/env bun
/**
 * node-pty prebuilds 准备脚本（替代 electron-rebuild 的宽松分支）。
 *
 * node-pty 1.1.0 是 node-addon-api (N-API) 模块，npm 安装时会随包分发
 * 各平台的 prebuilds（prebuilds/{platform}-{arch}/*.node）。N-API 的 ABI
 * 是跨 Node/Electron 大版本稳定的，因此通常不需要为每个 Electron 版本
 * 重新编译。
 *
 * 但一些 CI / 新机器上，MSVC BuildTools 可能缺少 Spectre-mitigated 库，
 * 导致 node-gyp / electron-rebuild 编译 node-pty 时直接失败（MSB8040），
 * 进而中断整条打包链（dist:win 用 && 连接，rebuild 失败则不会生成 out）。
 *
 * 这里的策略：
 *   1. 先尝试按 node-pty 的加载顺序（build/Release -> build/Debug ->
 *      prebuilds/{platform}-{arch}）加载当前进程能用的 .node 二进制。
 *   2. 若能加载，说明 prebuilds 已可用，直接走 ensure:node-pty-helper
 *      并返回 0（跳过 electron-rebuild，避免无谓的 Spectre 编译失败）。
 *   3. 若不能加载，回退到 electron-rebuild 编译（保留兜底能力）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')
const nodePtyRoot = join(repoRoot, 'node_modules', 'node-pty')
const electronDir = join(repoRoot, 'apps', 'electron')

const nativeName = 'pty.node'
const dirs = [
  'build/Release',
  'build/Debug',
  `prebuilds/${process.platform}-${process.arch}`,
]

/** 尝试按 node-pty 的加载顺序找一个能加载的 .node 二进制。 */
function findLoadableNative(): string | null {
  for (const dir of dirs) {
    const candidate = join(nodePtyRoot, dir, nativeName)
    if (!existsSync(candidate)) continue
    try {
      // 仅做加载性探针，非空 require 会触发 N-API 初始化；失败抛异常。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(candidate)
      return candidate
    } catch {
      // 二进制与当前进程 ABI 不匹配，尝试下一个目录。
    }
  }
  return null
}

function run(cwd: string, command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env },
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  return result.status ?? 1
}

function main(): number {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    const loaded = findLoadableNative()
    if (loaded) {
      console.log(`[node-pty] 使用预构建二进制：${loaded}`)
      console.log('[node-pty] 跳过 electron-rebuild（prebuilds 已可加载，N-API 跨版本稳定）')
      return run(electronDir, 'bun', ['run', 'ensure:node-pty-helper'])
    }
    console.log('[node-pty] 未找到可加载的 prebuilds，回退 electron-rebuild 编译…')
    const rebuilt = run(electronDir, 'electron-rebuild', ['-f', '-w', 'node-pty'])
    if (rebuilt !== 0) return rebuilt
  }
  return run(electronDir, 'bun', ['run', 'ensure:node-pty-helper'])
}

if (import.meta.main) {
  process.exit(main())
}
