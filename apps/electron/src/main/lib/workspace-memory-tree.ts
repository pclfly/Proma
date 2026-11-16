import { closeSync, openSync, opendirSync, readSync } from 'node:fs'
import type { WorkspaceKnowledgeAccessState, WorkspaceMemoryFileNode } from '@proma/shared'
import { KnowledgeAccessError, knowledgePathKey, resolveWorkspaceKnowledgePath, type KnowledgeAccessPolicy, type KnowledgePathResolution } from './workspace-knowledge-access'

export interface WorkspaceMemoryTreeLimits { maxDepth?: number; maxDirectories?: number; maxFiles?: number; maxNodes?: number; maxEntries?: number; inspectText?: boolean }
export interface WorkspaceMemoryTreeFile { relativePath: string; target: KnowledgePathResolution; isText?: boolean }
export interface WorkspaceMemoryTreeDirectory { relativePath: string; target: KnowledgePathResolution }
export interface WorkspaceMemoryTreeSnapshot {
  nodes: WorkspaceMemoryFileNode[]
  files: WorkspaceMemoryTreeFile[]
  directories: WorkspaceMemoryTreeDirectory[]
  rootAccess: WorkspaceKnowledgeAccessState
  truncated: boolean
}

export function knowledgeAccessState(error: unknown): WorkspaceKnowledgeAccessState {
  const code = error instanceof KnowledgeAccessError ? error.code : undefined
  return { isSymbolicLink: code === 'unauthorized_link' || code === 'broken_link' || code === 'cycle' || undefined,
    linkState: code === 'cycle' ? 'cycle' : code === 'missing' || code === 'broken_link' ? 'broken' : 'unauthorized',
    blockedReason: error instanceof KnowledgeAccessError ? error.message : '无法安全访问此知识路径，请刷新或检查目录授权' }
}
function isTextFile(path: string, size: number): boolean {
  if (size === 0) return true
  let file: number | undefined
  try {
    file = openSync(path, 'r')
    const buffer = Buffer.alloc(Math.min(8192, size))
    return !buffer.subarray(0, readSync(file, buffer, 0, buffer.length, 0)).includes(0)
  } catch { return false } finally { if (file !== undefined) closeSync(file) }
}

/** 有界、按逻辑别名展示的树；目录流可提前停止，隐藏/失败项也消耗枚举预算。 */
export function scanWorkspaceMemoryTree(policy: KnowledgeAccessPolicy, limits: WorkspaceMemoryTreeLimits = {}): WorkspaceMemoryTreeSnapshot {
  const maxDepth = limits.maxDepth ?? 6, maxDirectories = limits.maxDirectories ?? 128, maxFiles = limits.maxFiles ?? 512, maxNodes = limits.maxNodes ?? 2048, maxEntries = limits.maxEntries ?? 4096
  const snapshot: WorkspaceMemoryTreeSnapshot = { nodes: [], files: [], directories: [], rootAccess: {}, truncated: false }
  let nodes = 0, inspectedEntries = 0
  const visit = (relativePath: string, depth: number, ancestors: ReadonlySet<string>): WorkspaceMemoryFileNode[] => {
    if (depth > maxDepth || snapshot.directories.length >= maxDirectories || nodes >= maxNodes || inspectedEntries >= maxEntries || snapshot.files.length >= maxFiles) { snapshot.truncated = true; return [] }
    const directory = resolveWorkspaceKnowledgePath(policy, relativePath, { allowRoot: true, allowMissing: true })
    if (directory.kind === 'missing') return []
    if (directory.kind !== 'directory') throw new KnowledgeAccessError('not_directory', '长期记忆根不是目录')
    const key = knowledgePathKey(directory.physicalPath)
    if (ancestors.has(key)) throw new KnowledgeAccessError('cycle', '知识目录链接返回当前分支祖先，已停止展开')
    const nextAncestors = new Set(ancestors).add(key)
    snapshot.directories.push({ relativePath, target: directory })
    const result: WorkspaceMemoryFileNode[] = []
    const stream = opendirSync(directory.physicalPath, { bufferSize: Math.max(1, Math.min(32, maxEntries - inspectedEntries)) })
    try {
      while (true) {
        if (nodes >= maxNodes || inspectedEntries >= maxEntries || snapshot.files.length >= maxFiles) { snapshot.truncated = true; break }
        const entry = stream.readSync()
        if (!entry) break
        inspectedEntries += 1
        if (entry.name.startsWith('.')) continue
        nodes += 1
        const path = relativePath ? `${relativePath}/${entry.name}` : entry.name
        try {
          const target = resolveWorkspaceKnowledgePath(policy, path)
          const access: WorkspaceKnowledgeAccessState = target.linked ? { isSymbolicLink: true, linkState: 'authorized' } : {}
          if (target.kind === 'directory') {
            const node: WorkspaceMemoryFileNode = { relativePath: path, name: entry.name, type: 'directory', ...access, children: [] }
            try { node.children = visit(path, depth + 1, nextAncestors) } catch (error) { Object.assign(node, knowledgeAccessState(error)) }
            result.push(node) // 已确定目录的循环/访问错误不能降成file。
          } else if (target.kind === 'file') {
            const isText = limits.inspectText === false ? undefined : isTextFile(target.physicalPath, target.size)
            snapshot.files.push({ relativePath: path, target, isText })
            result.push({ relativePath: path, name: entry.name, type: 'file', size: target.size, modifiedAt: target.modifiedAt, isText, ...access })
          }
        } catch (error) {
          result.push({ relativePath: path, name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', isText: false, ...knowledgeAccessState(error) })
        }
      }
    } finally { stream.closeSync() }
    return result.sort((a, b) => a.type !== b.type ? a.type === 'directory' ? -1 : 1 : a.relativePath === 'MEMORY.md' ? -1 : b.relativePath === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
  try {
    const root = resolveWorkspaceKnowledgePath(policy, '', { allowRoot: true, allowMissing: true })
    snapshot.rootAccess = root.linked ? { isSymbolicLink: true, linkState: 'authorized' } : {}
    snapshot.nodes = visit('', 0, new Set())
  } catch (error) {
    snapshot.rootAccess = knowledgeAccessState(error)
    snapshot.nodes = [{ relativePath: '', name: 'memory', type: 'directory', children: [], ...snapshot.rootAccess }]
  }
  return snapshot
}
