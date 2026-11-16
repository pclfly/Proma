/**
 * 轮次基线捕获。
 *
 * 工具执行前直接读磁盘；工具执行后才首次登记时，只有在轮次开始时 Git
 * 干净、HEAD 可读的前提下，才用 HEAD 内容还原执行前基线，否则退化为
 * 当前磁盘状态（该文件本轮不产生 diff）。
 */

import { createHash } from 'node:crypto'
import type { TurnChangeBaselineSource } from '@proma/shared'
import type { CapturedFileSnapshot } from './capture'
import type { GitReaderLike, GitRepositorySnapshot } from './git'
import { relativeToRoot } from './paths'
import type { TurnCaptureFile, TurnChangeLimits } from './types'

export interface BaselineEntry {
  absolutePath: string
  filePath: string
  before: CapturedFileSnapshot
  capturedAt: number
  baselineSource: TurnChangeBaselineSource
}

export interface BaselineCaptureContext {
  limits: Required<TurnChangeLimits>
  usedBytes: number
  captureFile: TurnCaptureFile
  clock: () => number
}

export interface AfterBaselineContext extends BaselineCaptureContext {
  gitReader: GitReaderLike | null
  gitSnapshot?: Promise<GitRepositorySnapshot | null>
  turnStartedAt: number
}

function contentSignature(content: string): string {
  return `git-head:${createHash('sha256').update(content).digest('hex')}`
}

export function captureBeforeBaseline(
  absolutePath: string,
  filePath: string,
  context: BaselineCaptureContext,
): BaselineEntry {
  const remainingBytes = Math.max(0, context.limits.maxTotalBytes - context.usedBytes)
  const before = context.captureFile(absolutePath, {
    maxFileBytes: context.limits.maxFileBytes,
    remainingBytes,
  })
  return {
    absolutePath,
    filePath,
    before,
    capturedAt: context.clock(),
    baselineSource: before.kind === 'missing' ? 'missing' : 'file',
  }
}

export async function captureAfterBaseline(
  absolutePath: string,
  filePath: string,
  context: AfterBaselineContext,
): Promise<BaselineEntry | undefined> {
  const gitSnapshot = await context.gitSnapshot
  if (gitSnapshot?.isGitRepository && context.gitReader) {
    const repoRelative = relativeToRoot(gitSnapshot.rootPath, absolutePath)
    const cleanAtStart = !gitSnapshot.dirtyPaths.includes(filePath)
      && (!repoRelative || !gitSnapshot.dirtyPaths.includes(repoRelative))
    if (repoRelative && cleanAtStart) {
      const content = await context.gitReader.readFileAtHead(repoRelative).catch(() => null)
      if (typeof content === 'string') {
        return {
          absolutePath,
          filePath,
          before: {
            kind: 'text',
            signature: contentSignature(content),
            size: Buffer.byteLength(content, 'utf8'),
            mtimeMs: context.turnStartedAt,
            text: content,
          },
          capturedAt: context.clock(),
          baselineSource: 'git-head',
        }
      }
    }
  }
  return captureBeforeBaseline(absolutePath, filePath, context)
}
