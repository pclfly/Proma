/**
 * 每轮快照的 JSONL 持久化。
 *
 * 每会话一个 `<storage>/<session>.jsonl`，一行一个 TurnChangesSnapshot。
 * 写入走 safe-file 的原子重写，单行损坏不影响其它轮次；读取上限 8 MiB，
 * 超出时视为损坏并从空记录开始，避免主进程被异常文件拖垮。
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TurnChangesSnapshot } from '@proma/shared'
import { writeTextFileAtomic } from '../safe-file'

const MAX_PERSISTED_FILE_BYTES = 8 * 1024 * 1024
const SNAPSHOT_VERSION = 1

export interface TurnChangesStoreOptions {
  rootDir: string
  maxTurnsPerSession: number
}

function safeSessionFileName(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized || 'session'
}

export class TurnChangesStore {
  constructor(private readonly options: TurnChangesStoreOptions) {}

  filePath(sessionId: string): string {
    return join(this.options.rootDir, `${safeSessionFileName(sessionId)}.jsonl`)
  }

  /** 读取会话全部轮次（按写入顺序），损坏行与不兼容版本会被跳过。 */
  read(sessionId: string): TurnChangesSnapshot[] {
    let raw: string
    try {
      raw = readFileSync(this.filePath(sessionId), 'utf8')
    } catch {
      return []
    }
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_PERSISTED_FILE_BYTES) return []
    const turns: TurnChangesSnapshot[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as TurnChangesSnapshot
        if (parsed.version === SNAPSHOT_VERSION && typeof parsed.turnId === 'string' && Array.isArray(parsed.entries)) {
          turns.push(parsed)
        }
      } catch {
        // 单行损坏不影响其它轮次。
      }
    }
    return turns
  }

  /** 合并写入一轮快照：同 turnId 覆盖，按时间升序裁剪到每会话上限。 */
  write(snapshot: TurnChangesSnapshot): void {
    const filePath = this.filePath(snapshot.sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const merged = this.read(snapshot.sessionId)
      .filter((turn) => turn.turnId !== snapshot.turnId)
      .concat(snapshot)
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(-this.options.maxTurnsPerSession)
    const content = merged.map((turn) => JSON.stringify(turn)).join('\n')
    writeTextFileAtomic(filePath, content ? `${content}\n` : '')
  }

  clear(sessionId: string): void {
    rmSync(this.filePath(sessionId), { force: true })
  }
}
