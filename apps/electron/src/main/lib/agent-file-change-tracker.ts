/**
 * Agent 非 Git 文件改动跟踪器。
 *
 * 在写入类工具首次触碰文件时保存基线，之后按会话比较基线与磁盘内容。
 * 快照保存在 Proma 配置目录，不向用户项目写入隐藏文件。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { diffLines } from 'diff'
import type { ChangedFileEntry } from '@proma/shared'
import { getConfigDir } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

const MANIFEST_VERSION = 1
const MAX_TRACKED_FILE_SIZE_BYTES = 10 * 1024 * 1024
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update'])
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.ps1', '.sh', '.rb', '.php'])
const MAX_SCRIPT_INSPECTION_BYTES = 1024 * 1024

interface FileBaselineEntry {
  absolutePath: string
  basePath: string
  existed: boolean
  snapshotFileName: string | null
  unsupportedFingerprint?: string
}

interface FileBaselineManifest {
  version: number
  entries: Record<string, FileBaselineEntry>
}

interface TextFileReadResult {
  state: 'missing' | 'text' | 'unsupported'
  content: string
  fingerprint?: string
}

interface ChangeScope {
  path: string
  key: string
  fileOnly: boolean
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

function normalizePathKey(filePath: string): string {
  const normalized = resolve(filePath).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function toDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function safeSessionDirName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function countChangedLines(content: string): number {
  if (!content) return 0
  const lines = content.split('\n')
  return content.endsWith('\n') ? lines.length - 1 : lines.length
}

function calculateLineStats(oldContent: string, newContent: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const part of diffLines(oldContent, newContent)) {
    const count = part.count ?? countChangedLines(part.value)
    if (part.added) additions += count
    if (part.removed) deletions += count
  }
  return { additions, deletions }
}

function readTextFile(filePath: string): TextFileReadResult {
  if (!existsSync(filePath)) return { state: 'missing', content: '' }
  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > MAX_TRACKED_FILE_SIZE_BYTES) {
      return { state: 'unsupported', content: '', fingerprint: `${stats.size}:${stats.mtimeMs}` }
    }
    const buffer = readFileSync(filePath)
    if (buffer.includes(0)) {
      return { state: 'unsupported', content: '', fingerprint: `${stats.size}:${stats.mtimeMs}` }
    }
    return { state: 'text', content: normalizeLineEndings(buffer.toString('utf-8')) }
  } catch {
    return { state: 'unsupported', content: '' }
  }
}

async function readTextFileAsync(filePath: string): Promise<TextFileReadResult> {
  try {
    const stats = await stat(filePath)
    if (!stats.isFile() || stats.size > MAX_TRACKED_FILE_SIZE_BYTES) {
      return { state: 'unsupported', content: '', fingerprint: `${stats.size}:${stats.mtimeMs}` }
    }
    const buffer = await readFile(filePath)
    if (buffer.includes(0)) {
      return { state: 'unsupported', content: '', fingerprint: `${stats.size}:${stats.mtimeMs}` }
    }
    return { state: 'text', content: normalizeLineEndings(buffer.toString('utf-8')) }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing', content: '' }
      : { state: 'unsupported', content: '' }
  }
}

function resolveStructuredToolFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (!WRITE_TOOLS.has(toolName)) return null
  const targetPath = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path
  return typeof targetPath === 'string' && targetPath.length > 0 ? targetPath : null
}

function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 1000 || trimmed.includes('\n')) return false
  return /[\\/]/.test(trimmed) || /\.[a-zA-Z0-9]{1,12}$/.test(trimmed)
}

function extractPathCandidates(text: string): string[] {
  const candidates = new Set<string>()
  const quotedPattern = /["']([^"'\r\n]+)["']/g
  for (const match of text.matchAll(quotedPattern)) {
    if (match[1] && looksLikeFilePath(match[1])) candidates.add(match[1].trim())
  }
  const absoluteWindowsPattern = /[a-zA-Z]:\\[^\s"'|;&<>]+/g
  for (const match of text.matchAll(absoluteWindowsPattern)) candidates.add(match[0])
  const redirectPattern = /(?:^|\s)(?:>>?|2>)\s*(?:["']([^"']+)["']|([^\s|;&]+))/g
  for (const match of text.matchAll(redirectPattern)) {
    const candidate = match[1] ?? match[2]
    if (candidate) candidates.add(candidate.trim())
  }
  const fileTokenPattern = /(?:^|\s)([^\s"'|;&<>]+\.[a-zA-Z0-9]{1,12})(?=\s|$)/g
  for (const match of text.matchAll(fileTokenPattern)) {
    if (match[1]) candidates.add(match[1].trim())
  }
  return [...candidates]
}

function resolveCandidate(candidate: string, basePaths: string[]): string {
  if (isAbsolute(candidate)) return resolve(candidate)
  for (const basePath of basePaths) {
    const resolved = resolve(basePath, candidate)
    if (existsSync(resolved)) return resolved
  }
  return resolve(basePaths[0]!, candidate)
}

async function resolveBashFilePaths(command: string, sessionBasePath: string): Promise<string[]> {
  const candidates = extractPathCandidates(command)
  const basePaths = [sessionBasePath]

  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, basePaths)
    try {
      if (statSync(resolved).isDirectory()) basePaths.push(resolved)
    } catch {
      // 不存在的候选路径仍会按文件基线处理。
    }
  }

  const resolvedPaths = new Set(candidates.map((candidate) => resolveCandidate(candidate, basePaths)))
  for (const candidatePath of [...resolvedPaths]) {
    let isInspectableScript = false
    try {
      const stats = statSync(candidatePath)
      const extension = candidatePath.slice(candidatePath.lastIndexOf('.')).toLowerCase()
      isInspectableScript = stats.isFile() &&
        stats.size <= MAX_SCRIPT_INSPECTION_BYTES &&
        SCRIPT_EXTENSIONS.has(extension)
    } catch {
      continue
    }
    if (!isInspectableScript) continue
    try {
      const script = await readFile(candidatePath, 'utf-8')
      for (const nested of extractPathCandidates(script)) {
        resolvedPaths.add(resolveCandidate(nested, [dirname(candidatePath), ...basePaths]))
      }
    } catch {
      // 脚本不可读时保留命令中已提取的显式路径。
    }
  }

  return [...resolvedPaths].filter((filePath) => {
    try {
      return !statSync(filePath).isDirectory()
    } catch {
      return true
    }
  })
}

function createChangeScope(scope: string): ChangeScope {
  const path = resolve(scope)
  let fileOnly = false
  try {
    fileOnly = statSync(path).isFile()
  } catch {
    // 不存在的附加路径按单文件处理，避免扩大匹配范围。
    fileOnly = true
  }
  return { path, key: normalizePathKey(path), fileOnly }
}

export class AgentFileChangeTracker {
  private readonly captureQueues = new Map<string, Promise<void>>()
  private readonly sessionGenerations = new Map<string, number>()

  constructor(private readonly storageRoot: string) {}

  async captureApprovedToolBaseline(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    sessionBasePath: string,
    options?: { captureBashTargets?: boolean },
  ): Promise<void> {
    const structuredPath = resolveStructuredToolFilePath(toolName, input)
    if (!structuredPath && !(toolName === 'Bash' && options?.captureBashTargets)) return
    const generation = this.sessionGenerations.get(sessionId) ?? 0
    const previous = this.captureQueues.get(sessionId) ?? Promise.resolve()
    const capture = previous.catch(() => undefined).then(async () => {
      const targetPaths = structuredPath
        ? [structuredPath]
        : await resolveBashFilePaths(String(input.command ?? ''), sessionBasePath)
      for (const targetPath of targetPaths) {
        await this.captureBaseline(sessionId, targetPath, sessionBasePath, generation)
      }
    })
    this.captureQueues.set(sessionId, capture)
    try {
      await capture
    } finally {
      if (this.captureQueues.get(sessionId) === capture) this.captureQueues.delete(sessionId)
    }
  }

  async captureBaseline(
    sessionId: string,
    targetPath: string,
    sessionBasePath: string,
    expectedGeneration = this.sessionGenerations.get(sessionId) ?? 0,
  ): Promise<void> {
    if ((this.sessionGenerations.get(sessionId) ?? 0) !== expectedGeneration) return
    const absolutePath = isAbsolute(targetPath) ? resolve(targetPath) : resolve(sessionBasePath, targetPath)
    const pathKey = normalizePathKey(absolutePath)
    const sessionDir = this.getSessionDir(sessionId)
    const manifest = this.readManifest(sessionId)
    if (manifest.entries[pathKey]) return

    const current = await readTextFileAsync(absolutePath)

    mkdirSync(sessionDir, { recursive: true })
    const basePath = isPathInside(sessionBasePath, absolutePath)
      ? resolve(sessionBasePath)
      : dirname(absolutePath)
    const snapshotFileName = current.state === 'text'
      ? `${createHash('sha256').update(pathKey).digest('hex')}.txt`
      : null

    if (snapshotFileName) {
      await writeFile(join(sessionDir, snapshotFileName), current.content, 'utf-8')
    }
    if ((this.sessionGenerations.get(sessionId) ?? 0) !== expectedGeneration) {
      rmSync(sessionDir, { recursive: true, force: true })
      return
    }

    manifest.entries[pathKey] = {
      absolutePath,
      basePath,
      existed: current.state !== 'missing',
      snapshotFileName,
      ...(current.state === 'unsupported' && current.fingerprint
        ? { unsupportedFingerprint: current.fingerprint }
        : {}),
    }
    writeJsonFileAtomic(this.getManifestPath(sessionId), manifest)
  }

  getChanges(sessionId: string, scopePaths: string[]): ChangedFileEntry[] {
    const manifest = this.readManifest(sessionId)
    const scopes = scopePaths
      .filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
      .map(createChangeScope)
    const changes: ChangedFileEntry[] = []

    for (const entry of Object.values(manifest.entries)) {
      if (scopes.length > 0 && !scopes.some((scope) => scope.fileOnly
        ? scope.key === normalizePathKey(entry.absolutePath)
        : isPathInside(scope.path, entry.absolutePath))) continue

      const current = readTextFile(entry.absolutePath)
      const oldContent = this.readBaselineContent(sessionId, entry)
      if (current.state === 'unsupported' || oldContent === null) {
        if (
          current.state === 'unsupported' &&
          entry.unsupportedFingerprint &&
          current.fingerprint === entry.unsupportedFingerprint
        ) continue
        changes.push({
          filePath: toDisplayPath(relative(entry.basePath, entry.absolutePath)),
          status: current.state === 'missing' ? 'deleted' : 'modified',
          additions: 0,
          deletions: 0,
          source: 'none',
          gitRoot: toDisplayPath(entry.basePath),
          baseline: 'session',
          previewable: false,
        })
        continue
      }
      const newContent = current.state === 'text' ? current.content : ''
      if (oldContent === newContent) continue

      const status = !entry.existed
        ? 'untracked'
        : current.state === 'missing'
          ? 'deleted'
          : 'modified'
      const stats = calculateLineStats(oldContent, newContent)
      changes.push({
        filePath: toDisplayPath(relative(entry.basePath, entry.absolutePath)),
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        source: 'none',
        gitRoot: toDisplayPath(entry.basePath),
        baseline: 'session',
        previewable: true,
      })
    }

    return changes.sort((a, b) => a.filePath.localeCompare(b.filePath))
  }

  getDiffContents(
    sessionId: string,
    basePath: string,
    filePath: string,
  ): { oldContent: string; newContent: string } | null {
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(basePath, filePath)
    if (!isPathInside(basePath, absolutePath)) return null
    const entry = this.readManifest(sessionId).entries[normalizePathKey(absolutePath)]
    if (!entry || !isPathInside(basePath, entry.absolutePath)) return null

    const oldContent = this.readBaselineContent(sessionId, entry)
    if (oldContent === null) return null
    const current = readTextFile(entry.absolutePath)
    if (current.state === 'unsupported') return null
    return {
      oldContent,
      newContent: current.state === 'text' ? current.content : '',
    }
  }

  clearSession(sessionId: string): void {
    this.sessionGenerations.set(sessionId, (this.sessionGenerations.get(sessionId) ?? 0) + 1)
    rmSync(this.getSessionDir(sessionId), { recursive: true, force: true })
  }

  private getSessionDir(sessionId: string): string {
    return join(this.storageRoot, safeSessionDirName(sessionId))
  }

  private getManifestPath(sessionId: string): string {
    return join(this.getSessionDir(sessionId), 'manifest.json')
  }

  private readManifest(sessionId: string): FileBaselineManifest {
    const manifest = readJsonFileSafe<FileBaselineManifest>(this.getManifestPath(sessionId))
    if (manifest?.version === MANIFEST_VERSION && manifest.entries && typeof manifest.entries === 'object') {
      return manifest
    }
    return {
      version: MANIFEST_VERSION,
      entries: {},
    }
  }

  private readBaselineContent(sessionId: string, entry: FileBaselineEntry): string | null {
    if (!entry.existed) return ''
    if (!entry.snapshotFileName) return null
    try {
      return normalizeLineEndings(readFileSync(join(this.getSessionDir(sessionId), entry.snapshotFileName), 'utf-8'))
    } catch {
      return null
    }
  }
}

let defaultTracker: AgentFileChangeTracker | null = null

export function getAgentFileChangeTracker(): AgentFileChangeTracker {
  defaultTracker ??= new AgentFileChangeTracker(join(getConfigDir(), 'agent-file-snapshots'))
  return defaultTracker
}
