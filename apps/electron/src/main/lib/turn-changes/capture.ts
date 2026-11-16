/**
 * 轮次文件快照读取。
 *
 * 只读普通文件，单文件默认上限 2 MiB、单轮最多 500 个文件、基线文本总量
 * 默认 64 MiB。符号链接、二进制与超限文件只记录签名与元数据，不把正文
 * 留在内存。任何读取错误都降级为 unreadable，不影响轮次结算。
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import {
  TURN_CHANGES_MAX_FILE_BYTES,
  TURN_CHANGES_MAX_FILES,
  TURN_CHANGES_MAX_TOTAL_BYTES,
} from '@proma/shared'

export type CapturedFileKind = 'missing' | 'text' | 'binary' | 'symlink' | 'too-large' | 'unreadable'

export interface CapturedFileSnapshot {
  kind: CapturedFileKind
  /** 内容或元数据签名；相同签名视为文件未变化。 */
  signature: string
  size?: number
  mtimeMs?: number
  text?: string
  error?: string
}

export interface CaptureFileOptions {
  maxFileBytes?: number
  /** 本轮剩余可用文本预算；不足时按超限处理。 */
  remainingBytes?: number
}

export const TURN_CHANGE_CAPTURE_LIMITS = {
  maxFileBytes: TURN_CHANGES_MAX_FILE_BYTES,
  maxFiles: TURN_CHANGES_MAX_FILES,
  maxTotalBytes: TURN_CHANGES_MAX_TOTAL_BYTES,
} as const

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function missingSnapshot(): CapturedFileSnapshot {
  return { kind: 'missing', signature: 'missing' }
}

function unreadableSnapshot(error: unknown): CapturedFileSnapshot {
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'unreadable', signature: `unreadable:${message}`, error: message }
}

/** 读取单文件快照；符号链接不跟随，超大/二进制不保留正文。 */
export function captureFileSnapshot(
  absolutePath: string,
  options: CaptureFileOptions = {},
): CapturedFileSnapshot {
  let stat
  try {
    stat = lstatSync(absolutePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return missingSnapshot()
    }
    return unreadableSnapshot(error)
  }

  if (stat.isSymbolicLink()) {
    return {
      kind: 'symlink',
      signature: `symlink:${stat.size}:${stat.mtimeMs}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  }
  if (!stat.isFile()) {
    return {
      kind: 'unreadable',
      signature: `unreadable:not-file:${stat.size}:${stat.mtimeMs}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  }

  const maxFileBytes = options.maxFileBytes ?? TURN_CHANGE_CAPTURE_LIMITS.maxFileBytes
  if (stat.size > maxFileBytes) {
    return {
      kind: 'too-large',
      signature: `large:${stat.size}:${stat.mtimeMs}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  }
  if (options.remainingBytes !== undefined && stat.size > options.remainingBytes) {
    return {
      kind: 'too-large',
      signature: `budget:${stat.size}:${stat.mtimeMs}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  }

  let raw: Buffer
  try {
    raw = readFileSync(absolutePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return missingSnapshot()
    }
    return unreadableSnapshot(error)
  }
  if (raw.includes(0)) {
    return { kind: 'binary', signature: `binary:${sha256(raw)}`, size: raw.length, mtimeMs: stat.mtimeMs }
  }
  return {
    kind: 'text',
    signature: `text:${sha256(raw)}`,
    size: raw.length,
    mtimeMs: stat.mtimeMs,
    text: raw.toString('utf8'),
  }
}

/** 是否为可直接参与行级 diff 的文本快照。 */
export function isTextSnapshot(snapshot: CapturedFileSnapshot): snapshot is CapturedFileSnapshot & { text: string } {
  return snapshot.kind === 'text' && typeof snapshot.text === 'string'
}
