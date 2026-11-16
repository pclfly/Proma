import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { writeJsonFileAtomic } from '../safe-file'

interface ScopeRecord { anchorId: string; snapshot: unknown }
interface ScopeFile { version: 1; records: ScopeRecord[] }
export interface ProjectScopeState {
  load: () => unknown
  save: (snapshot: object) => void
}
export interface ScopeStorage {
  /** null只代表明确ENOENT；不可读/损坏必须抛错。 */
  read: (path: string) => unknown
  write: (path: string, value: ScopeFile) => void
}
const defaultStorage: ScopeStorage = {
  read: (path) => {
    try {
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (value === null) throw new Error('项目指令范围记录不能为null')
      return value
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  },
  write: writeJsonFileAtomic,
}
function validateScopeFile(value: unknown): ScopeFile {
  if (value === null) return { version: 1, records: [] }
  if (!value || typeof value !== 'object') throw new Error('项目指令范围记录格式非法')
  const file = value as Partial<ScopeFile>
  if (file.version !== 1 || !Array.isArray(file.records) || file.records.length > 1000 || file.records.some((record) => {
    if (!record || typeof record.anchorId !== 'string' || !record.anchorId || !record.snapshot || typeof record.snapshot !== 'object') return true
    const snapshot = record.snapshot as { version?: unknown; projectRoot?: unknown; directories?: unknown }
    return snapshot.version !== 1 || typeof snapshot.projectRoot !== 'string' || !Array.isArray(snapshot.directories) || snapshot.directories.length > 200 || snapshot.directories.some((path) => typeof path !== 'string')
  })) throw new Error('项目指令范围记录格式非法')
  return file as ScopeFile
}
function scopeFilePath(file: string): string { return `${file}.proma-project-scopes.json` }

/** fork/rewind只迁移新artifact保留的锚点范围，不迁移已投递凭据。先写成功再提交会话metadata。 */
export function copyProjectScopeState(sourceFile: string, destinationFile: string, retainedIds: string[], storage: ScopeStorage = defaultStorage): void {
  const source = storage.read(scopeFilePath(sourceFile))
  if (source === null) return
  const ids = new Set(retainedIds)
  const current = validateScopeFile(source)
  storage.write(scopeFilePath(destinationFile), { version: 1, records: current.records.filter((record) => ids.has(record.anchorId)) })
}

/** 不追加Pi树节点：SDK append先改内存再落盘，失败会令后续entry指向不存在的parent。 */
export function createProjectScopeState(
  session: Pick<SessionManager, 'getBranch' | 'getLeafId' | 'getSessionFile'>,
  storage: ScopeStorage = defaultStorage,
): ProjectScopeState {
  let memory: ScopeFile = { version: 1, records: [] }
  const file = session.getSessionFile()
  const path = file ? scopeFilePath(file) : undefined
  const read = (): ScopeFile => validateScopeFile(path ? storage.read(path) : memory)
  return {
    load: () => {
      const ids = new Set(session.getBranch().map((entry) => entry.id))
      return [...read().records].reverse().find((entry) => entry && ids.has(entry.anchorId))?.snapshot
    },
    save: (snapshot) => {
      const anchorId = session.getLeafId()
      if (!anchorId) throw new Error('项目指令范围必须绑定当前会话分支')
      const current = read()
      // 同一assistant的多个工具可共享锚点；只替换该锚点的快照，保留其他分支。
      const records = current.records.filter((entry) => entry.anchorId !== anchorId)
      if (records.length >= 1000) throw new Error('项目指令分支记录已达上限')
      const next = validateScopeFile({ version: 1, records: [...records, { anchorId, snapshot }] })
      if (path) storage.write(path, next)
      else memory = next
    },
  }
}
