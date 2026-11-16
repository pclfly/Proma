import { StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'

/** 仅供没有事务信息的降级路径恢复连续变化范围之外的换行。正常编辑使用下面的ChangeSet状态字段。 */
export function preserveMarkdownLineEndings(previous: string, nextValue: string): string {
  const next = nextValue.replace(/\r\n?/g, '\n')
  const separators = new Map<number, string>()
  const counts = new Map<string, number>()
  let normal = '', offset = 0
  for (const match of previous.matchAll(/\r\n|\n|\r/g)) {
    const index = match.index
    normal += previous.slice(offset, index)
    separators.set(normal.length, match[0])
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
    normal += '\n'
    offset = index + match[0].length
  }
  normal += previous.slice(offset)
  if (normal === next) return previous
  let prefix = 0, suffix = 0
  while (prefix < normal.length && prefix < next.length && normal[prefix] === next[prefix]) prefix += 1
  while (suffix < normal.length - prefix && suffix < next.length - prefix && normal[normal.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1
  let preferred = '\n', maximum = 0
  for (const [separator, count] of counts) if (count > maximum) { preferred = separator; maximum = count }
  const delta = normal.length - next.length
  let result = '', start = 0
  for (let index = next.indexOf('\n'); index !== -1; index = next.indexOf('\n', index + 1)) {
    const previousIndex = index < prefix ? index : index >= next.length - suffix ? index + delta : undefined
    result += next.slice(start, index) + (previousIndex === undefined ? preferred : separators.get(previousIndex) ?? preferred)
    start = index + 1
  }
  return result + next.slice(start)
}

interface MarkdownRawDocument { source: string; separators: string }
export interface MarkdownRawSourceController {
  extension: Extension
  getSource: () => string
  synchronize: (source: string) => StateEffect<string>
}
const restoreSeparators = StateEffect.define<string>()
const synchronizeRawSource = StateEffect.define<string>()

function encodeSeparators(source: string): string {
  return Array.from(source.matchAll(/\r\n|\n|\r/g), (match) => match[0] === '\r\n' ? 'C' : match[0] === '\r' ? 'R' : 'L').join('')
}

function applySeparators(normal: string, separators: string): string | null {
  let index = 0
  const source = normal.replace(/\n/g, () => {
    const code = separators[index++]
    return code === 'C' ? '\r\n' : code === 'R' ? '\r' : '\n'
  })
  return index === separators.length ? source : null
}

function mapRawChanges(before: string, transaction: Transaction): string {
  const counts = new Map<string, number>()
  for (const match of before.matchAll(/\r\n|\n|\r/g)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
  let preferred = '\n', maximum = 0
  for (const [eol, count] of counts) if (count > maximum) { preferred = eol; maximum = count }
  let logical = 0, raw = 0, previousEnd = 0, result = ''
  const rawOffset = (position: number): number => {
    while (logical < position && raw < before.length) {
      if (before[raw] === '\r' && before[raw + 1] === '\n') raw += 2
      else raw += 1
      logical += 1
    }
    return raw
  }
  transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    const start = rawOffset(from), end = rawOffset(to)
    result += before.slice(previousEnd, start) + inserted.toString().replace(/\n/g, preferred)
    previousEnd = end
  })
  return result + before.slice(previousEnd)
}

/**
 * 逐事务映射原文，保留多光标/多区域变更之间的EOL；历史只保存紧凑分隔符编码，
 * 不为每次键入复制整篇文档。inverse effects使Undo/Redo还原被删行的原分隔符。
 */
export function createMarkdownRawSource(initialSource: string, externalSource: () => string | null = () => null): MarkdownRawSourceController {
  let latest = initialSource
  const field = StateField.define<MarkdownRawDocument>({
    create: () => ({ source: initialSource, separators: encodeSeparators(initialSource) }),
    update: (value, transaction) => {
      const effects = transaction.effects.filter((effect) => effect.is(restoreSeparators))
      const restored = effects.length ? applySeparators(transaction.state.doc.toString(), effects.at(-1)!.value) : null
      const synchronized = transaction.effects.filter((effect) => effect.is(synchronizeRawSource)).at(-1)?.value
      const external = synchronized ?? externalSource()
      const source = restored ?? (external !== null && external.replace(/\r\n?/g, '\n') === transaction.state.doc.toString()
        ? external : transaction.docChanged ? mapRawChanges(value.source, transaction) : value.source)
      latest = source
      return source === value.source ? value : { source, separators: encodeSeparators(source) }
    },
  })
  return {
    getSource: () => latest,
    synchronize: (source) => synchronizeRawSource.of(source),
    extension: [field, invertedEffects.of((transaction) => {
      const before = transaction.startState.field(field), after = transaction.state.field(field)
      return before.separators === after.separators ? [] : [restoreSeparators.of(before.separators)]
    })],
  }
}
