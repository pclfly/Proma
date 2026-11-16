/**
 * 记忆片段检索。
 *
 * 官方 0.22.0：按关键词/中文 bigram 扫描 profile 与项目 memory/*.md，
 * 返回行级片段、行号和分数；每个文件最多两条，避免长文件淹没结果。
 * 这里把“候选文件与读取方式”做成注入，便于后续接入 agent-memory 布局。
 */

import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const MAX_FILES = 200
const MAX_EXCERPT = 240
const SKIP_DIRS = new Set(['archive', 'history', 'migrations', 'reviews'])

export interface MemorySearchCandidate {
  path: string
  label: string
}

export interface MemorySearchHit {
  line: number
  score: number
  excerpt: string
}

export interface MemorySearchFileHit extends MemorySearchHit {
  path: string
  label: string
}

export interface MemorySearchResult {
  query: string
  scannedFiles: number
  hits: MemorySearchFileHit[]
}

export interface MemorySearchContext {
  candidates: readonly MemorySearchCandidate[]
  readContent: (path: string) => string | undefined
}

/** 递归列出 Markdown 记忆文件；跳过隐藏目录、归档目录与过深层级。 */
export function listMarkdownFiles(root: string, depth = 0): string[] {
  if (depth > 3) return []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listMarkdownFiles(path, depth + 1))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
    if (files.length >= MAX_FILES) break
  }
  return files
}

/** 英文按词、中文按二元组切分；单字中文保留单 token。 */
export function tokenizeMemoryQuery(text: string): string[] {
  const tokens = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue
    if (!CJK.test(word)) {
      if (word.length > 1) tokens.add(word)
      continue
    }
    if ([...word].length === 1) tokens.add(word)
    else {
      for (let index = 0; index < word.length - 1; index += 1) tokens.add(word.slice(index, index + 2))
    }
  }
  return [...tokens]
}

function lineScore(line: string, tokens: readonly string[], pathBonus: ReadonlySet<string>): number {
  const lower = line.toLowerCase()
  const heading = /^\s{0,3}#{1,6}\s/.test(line)
  let score = 0
  for (const token of tokens) {
    if (!lower.includes(token)) continue
    let occurrences = 0
    let index = lower.indexOf(token)
    while (index !== -1 && occurrences < 3) {
      occurrences += 1
      index = lower.indexOf(token, index + token.length)
    }
    score += (heading ? 2 : 1) + occurrences * 0.3
    if (pathBonus.has(token)) score += 0.8
  }
  return score
}

function excerptOf(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT)}…` : trimmed
}

function scoreMemoryLines(
  content: string,
  tokens: readonly string[],
  pathLabel: string,
  path: string,
): MemorySearchHit[] {
  const pathBonus = new Set(tokens.filter((token) =>
    pathLabel.toLowerCase().includes(token) || basename(path).toLowerCase().includes(token),
  ))
  return content.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return []
    const score = lineScore(line, tokens, pathBonus)
    return score > 0 ? [{ line: index + 1, score, excerpt: excerptOf(line) }] : []
  })
}

export function searchMemory(ctx: MemorySearchContext, query: string, limit = 8): MemorySearchResult {
  const trimmed = query.trim()
  if (!trimmed) throw new Error('请提供检索关键词。')
  const tokens = tokenizeMemoryQuery(trimmed)
  if (tokens.length === 0) return { query: trimmed, scannedFiles: 0, hits: [] }

  const hits: MemorySearchFileHit[] = []
  let scannedFiles = 0
  for (const candidate of ctx.candidates) {
    const content = ctx.readContent(candidate.path)
    if (!content?.trim()) continue
    scannedFiles += 1
    for (const hit of scoreMemoryLines(content, tokens, candidate.label, candidate.path)) {
      hits.push({ path: candidate.path, label: candidate.label, ...hit })
    }
  }

  const cap = Math.max(1, Math.min(limit, 20))
  hits.sort((left, right) => right.score - left.score)
  const perFile = new Map<string, number>()
  const selected = hits.filter((hit) => {
    const used = perFile.get(hit.path) ?? 0
    if (used >= 2) return false
    perFile.set(hit.path, used + 1)
    return true
  }).slice(0, cap)
  return { query: trimmed, scannedFiles, hits: selected }
}
