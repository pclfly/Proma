/**
 * 记忆条目的增删改。
 *
 * 官方 0.22.0：MemoryUpdate 优先用 operations 维护单条 `- ` 事实，
 * 保留无关正文；match 支持原文包含或归一化后精确匹配，多条命中时拒绝猜测。
 */

const BULLET = /^\s*[-*]\s+/

export type MemoryEntryOperation =
  | { op: 'add'; entry: string; after?: string }
  | { op: 'update'; match: string; entry: string }
  | { op: 'remove'; match: string }

export interface MemoryEntryChange {
  op: 'add' | 'update' | 'remove'
  entry: string
}

export interface MemoryEntrySkipped {
  op: 'add' | 'update' | 'remove'
  reason: 'duplicate' | 'not-found'
  entry: string
}

export interface MemoryEntryOperationResult {
  content: string
  changes: MemoryEntryChange[]
  skipped: MemoryEntrySkipped[]
}

function normalizeEntryText(line: string): string {
  const body = line.replace(BULLET, '').trim()
  const withoutMeta = body.replace(/[（(][^（）()]*[）)]\s*$/, '').trim()
  return withoutMeta.toLowerCase().replace(/[\s，。；、,.;:：！？!?'"“”‘’（）()\-—_]/g, '')
}

function entryLine(entry: string): string {
  const trimmed = entry.trim()
  if (!trimmed) throw new Error('条目内容不能为空。')
  if (/[\r\n]/.test(trimmed)) throw new Error('一次只能操作一个单行条目；多行事实请拆成多条。')
  return BULLET.test(trimmed) ? trimmed : `- ${trimmed}`
}

function indexOfMatches(lines: string[], match: string): number[] {
  const query = match.trim()
  if (!query) throw new Error('请提供用于定位条目的 match。')
  const normalized = normalizeEntryText(query)
  const found: number[] = []
  lines.forEach((line, index) => {
    if (!BULLET.test(line)) return
    if (line.includes(query) || (normalized.length > 0 && normalizeEntryText(line) === normalized)) {
      found.push(index)
    }
  })
  return found
}

function insertPosition(lines: string[], after?: string): number {
  if (after) {
    const anchors = indexOfMatches(lines, after)
    const anchor = anchors[0]
    if (anchors.length === 1 && anchor !== undefined) return anchor + 1
    if (anchors.length > 1) throw new Error(`after 匹配到多条条目，请写得更具体：${after}`)
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (BULLET.test(lines[index] ?? '')) return index + 1
  }
  return lines.length
}

export function applyMemoryEntryOperations(
  content: string,
  operations: readonly MemoryEntryOperation[],
): MemoryEntryOperationResult {
  if (operations.length === 0) throw new Error('请提供至少一条条目操作。')
  const lines = content.split(/\r?\n/)
  const changes: MemoryEntryChange[] = []
  const skipped: MemoryEntrySkipped[] = []
  const seen = new Set(lines.filter((line) => BULLET.test(line)).map((line) => normalizeEntryText(line)))

  for (const operation of operations) {
    if (operation.op === 'add') {
      const line = entryLine(operation.entry)
      const key = normalizeEntryText(line)
      if (key && seen.has(key)) {
        skipped.push({ op: 'add', reason: 'duplicate', entry: line })
        continue
      }
      lines.splice(insertPosition(lines, operation.after), 0, line)
      if (key) seen.add(key)
      changes.push({ op: 'add', entry: line })
      continue
    }

    const matches = indexOfMatches(lines, operation.match)
    if (matches.length === 0) {
      skipped.push({ op: operation.op, reason: 'not-found', entry: operation.match })
      continue
    }
    if (matches.length > 1) {
      throw new Error(`match 匹配到 ${matches.length} 条条目，无法唯一定位：${operation.match}`)
    }
    const at = matches[0]
    if (at === undefined) continue

    if (operation.op === 'remove') {
      const [removed] = lines.splice(at, 1)
      if (removed !== undefined) {
        seen.delete(normalizeEntryText(removed))
        changes.push({ op: 'remove', entry: removed })
      }
      continue
    }

    const line = entryLine(operation.entry)
    const key = normalizeEntryText(line)
    const previous = lines[at]
    if (previous !== undefined) seen.delete(normalizeEntryText(previous))
    lines[at] = line
    if (key) seen.add(key)
    changes.push({ op: 'update', entry: line })
  }

  return { content: lines.join('\n'), changes, skipped }
}
