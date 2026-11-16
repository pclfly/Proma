/**
 * 只读 Git 命令封装。
 *
 * 仅执行 rev-parse / status / diff --numstat / show 这类读取命令，并统一带
 * 超时与 `GIT_OPTIONAL_LOCKS=0`，避免 Agent 轮次记录反过来刷新索引或卡住
 * 主进程。任何失败都返回结构化结果，由调用方降级为非 Git 路径。
 */

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { parseGitNumstat, type GitNumstatEntry } from './numstat'
import { isSafeRelativePath, toPosixPath } from './paths'

const DEFAULT_GIT_TIMEOUT_MS = 3_000
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024

export interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

export type GitCommandRunner = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<GitCommandResult>

export interface GitRepositorySnapshot {
  isGitRepository: boolean
  rootPath: string
  head: string | null
  /** 轮次开始前已经处于变更状态的路径（相对仓库根、POSIX）。 */
  dirtyPaths: string[]
  numstat: GitNumstatEntry[]
}

export interface GitReaderOptions {
  timeoutMs?: number
  run?: GitCommandRunner
}

export interface GitReaderLike {
  getSnapshot: () => Promise<GitRepositorySnapshot>
  readFileAtHead: (relativePath: string) => Promise<string | null>
}

interface ExecFileError extends Error {
  code?: string
  stdout?: string
  stderr?: string
}

export const runGitCommand: GitCommandRunner = (args, cwd, timeoutMs) => {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as ExecFileError
          resolve({
            ok: false,
            stdout: typeof stdout === 'string' ? stdout : execError.stdout ?? '',
            stderr: typeof stderr === 'string' ? stderr : execError.stderr ?? '',
            error: error.message,
          })
          return
        }
        resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/** 解析 `git status --porcelain -z`，重命名条目跳过紧随其后的旧路径字段。 */
export function parseGitStatusZ(output: string): string[] {
  const paths: string[] = []
  const fields = output.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const status = field.slice(0, 2)
    const filePath = field.slice(3)
    if (!filePath) continue
    if (status.includes('R') || status.includes('C')) index += 1
    paths.push(toPosixPath(filePath))
  }
  return paths
}

export class GitReader implements GitReaderLike {
  private readonly timeoutMs: number
  private readonly run: GitCommandRunner

  constructor(
    private readonly rootPath: string,
    options: GitReaderOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    this.run = options.run ?? runGitCommand
  }

  /** 读取仓库根、HEAD、轮次开始时的脏文件与 numstat 汇总。 */
  async getSnapshot(): Promise<GitRepositorySnapshot> {
    const empty: GitRepositorySnapshot = {
      isGitRepository: false,
      rootPath: this.rootPath,
      head: null,
      dirtyPaths: [],
      numstat: [],
    }
    const topLevel = await this.run(['rev-parse', '--show-toplevel'], this.rootPath, this.timeoutMs)
    if (!topLevel.ok) return empty
    const repoRoot = topLevel.stdout.trim()
    if (!repoRoot) return empty

    const [headResult, statusResult, numstatResult] = await Promise.all([
      this.run(['rev-parse', '--verify', 'HEAD'], repoRoot, this.timeoutMs),
      this.run(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        repoRoot,
        this.timeoutMs,
      ),
      this.run(
        ['diff', 'HEAD', '--numstat', '-z', '--find-renames'],
        repoRoot,
        this.timeoutMs,
      ),
    ])

    return {
      isGitRepository: true,
      rootPath: repoRoot,
      head: headResult.ok ? headResult.stdout.trim() || null : null,
      dirtyPaths: statusResult.ok ? parseGitStatusZ(statusResult.stdout) : [],
      numstat: numstatResult.ok ? parseGitNumstat(numstatResult.stdout) : [],
    }
  }

  /** 读取 HEAD 中的文件正文；文件不在 HEAD 或 Git 失败时返回 null。 */
  async readFileAtHead(relativePath: string): Promise<string | null> {
    if (!isSafeRelativePath(relativePath) || isAbsolute(relativePath)) return null
    const result = await this.run(['show', `HEAD:${toPosixPath(relativePath)}`], this.rootPath, this.timeoutMs)
    return result.ok ? result.stdout : null
  }
}
