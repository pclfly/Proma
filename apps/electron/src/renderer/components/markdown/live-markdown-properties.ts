import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from 'yaml'

export type MarkdownPropertyPath = readonly (string | number)[]
export type MarkdownScalarType = 'string' | 'number' | 'boolean' | 'null'

export interface MarkdownPropertyNode {
  path: MarkdownPropertyPath
  label: string
  kind: 'mapping' | 'sequence' | 'scalar' | 'raw'
  from: number
  to: number
  end: number
  itemFrom?: number
  keyFrom?: number
  keyTo?: number
  value?: string
  scalarType?: MarkdownScalarType
  flow: boolean
  children: MarkdownPropertyNode[]
  reason?: string
}

export interface MarkdownPropertiesDocument {
  mode: 'none' | 'editable' | 'raw'
  /** 精确首部快照，不包括结束围栏后的换行或正文。 */
  source: string
  contentFrom: number
  contentTo: number
  endLine: number
  root?: MarkdownPropertyNode
  reason?: string
}

export interface MarkdownPropertyEdit {
  kind: 'set' | 'rename' | 'remove' | 'insert'
  expectedFrontmatter: string
  path: MarkdownPropertyPath
  scalarType?: MarkdownScalarType
  value?: string
  key?: string
  /** 只用于新建的一个值，不会序列化既有集合。 */
  valueSource?: string
}

export interface MarkdownPropertyChange {
  status: 'changed' | 'unchanged' | 'conflict' | 'raw-required'
  change: { from: number; to: number; insert: string }
  reason?: string
}

const YAML_OPTIONS = { keepSourceTokens: true, strict: true, uniqueKeys: true, version: '1.2', intAsBigInt: true } as const

/** 围栏必须位于列0；block scalar里缩进的---不是结束围栏。 */
function scanFrontmatter(source: string): MarkdownPropertiesDocument {
  const first = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/.exec(source)
  const none: MarkdownPropertiesDocument = { mode: 'none', source: '', contentFrom: 0, contentTo: 0, endLine: 0 }
  if (!first) return none
  let cursor = first[0].length
  let endLine = 2
  while (cursor <= source.length) {
    const match = /\r\n|\n|\r/.exec(source.slice(cursor))
    const end = match ? cursor + match.index : source.length
    if (/^---[ \t]*$/.test(source.slice(cursor, end))) {
      return { mode: 'raw', source: source.slice(0, end), contentFrom: first[0].length, contentTo: cursor, endLine }
    }
    if (!match) break
    cursor = end + match[0].length
    endLine += 1
  }
  return none
}

function scalarType(value: unknown): MarkdownScalarType | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'bigint') return 'number'
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return 'number'
  return undefined
}

/** 不调用toJS，不展开alias。所有位置直接指向输入的UTF-16原串。 */
export function parseMarkdownProperties(source: string): MarkdownPropertiesDocument {
  const result = scanFrontmatter(source)
  if (result.mode === 'none') return result
  if (result.contentTo - result.contentFrom > 128 * 1024) return { ...result, reason: '属性区域过大，请编辑 YAML 源码' }
  const yaml = source.slice(result.contentFrom, result.contentTo)
  try {
    const document = parseDocument(yaml, YAML_OPTIONS)
    if (document.errors.length || document.warnings.length || /^\s*(?:%|\.\.\.)/m.test(yaml)) throw new Error('YAML 包含错误、指令或未支持标签')
    if (document.contents !== null && !isMap(document.contents)) throw new Error('Properties 顶层必须是映射')
    let budget = 2000
    const build = (node: Node, path: MarkdownPropertyPath, label: string, depth: number): MarkdownPropertyNode => {
      if (--budget < 0 || depth > 16) throw new Error('属性层级或数量过多，请编辑 YAML 源码')
      if (isAlias(node) || node.tag || ('anchor' in node && node.anchor)) throw new Error('带标签、anchor 或 alias 的 YAML 保持源码')
      const range = node.range
      if (!range) throw new Error('无法安全定位 YAML 源码')
      const from = range[0] + result.contentFrom, to = range[1] + result.contentFrom, end = range[2] + result.contentFrom
      const base: MarkdownPropertyNode = { path, label, kind: 'raw', from, to, end, flow: false, children: [] }
      if (isMap(node)) {
        base.kind = 'mapping'; base.flow = node.flow === true
        base.children = node.items.map((pair) => {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<' || pair.key.tag || pair.key.anchor || !pair.key.range || !isNode(pair.value)) throw new Error('仅支持无歧义的字符串键映射')
          const child = build(pair.value, [...path, pair.key.value], pair.key.value, depth + 1)
          child.itemFrom = pair.key.range[0] + result.contentFrom
          child.keyFrom = pair.key.range[0] + result.contentFrom
          child.keyTo = pair.key.range[1] + result.contentFrom
          return child
        })
      } else if (isSeq(node)) {
        base.kind = 'sequence'; base.flow = node.flow === true
        base.children = node.items.map((item, index) => {
          if (!isNode(item)) throw new Error('无法安全定位列表项')
          const child = build(item, [...path, index], `[${index + 1}]`, depth + 1)
          if (node.srcToken?.type === 'block-seq') {
            const marker = node.srcToken.items[index]?.start.find((token) => token.type === 'seq-item-ind')
            if (marker) child.itemFrom = marker.offset + result.contentFrom
          }
          return child
        })
      } else if (isScalar(node)) {
        const type = scalarType(node.value)
        if (!type || node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED' || /[\r\n]/.test(source.slice(from, to))) base.reason = '多行或特殊数值请编辑 YAML 源码'
        else { base.kind = 'scalar'; base.scalarType = type; base.value = node.value === null ? '' : String(node.value) }
      }
      return base
    }
    result.root = document.contents === null
      ? { path: [], label: 'Properties', kind: 'mapping', from: result.contentTo, to: result.contentTo, end: result.contentTo, flow: false, children: [] }
      : build(document.contents, [], 'Properties', 0)
    result.mode = 'editable'
    return result
  } catch (error) {
    return { ...result, reason: error instanceof Error ? error.message : '无法安全解析 YAML，请编辑源码' }
  }
}

function nodeAt(root: MarkdownPropertyNode, path: MarkdownPropertyPath): MarkdownPropertyNode | undefined {
  let node = root
  for (let index = 0; index < path.length; index += 1) {
    const next = node.children.find((child) => child.path[index] === path[index])
    if (!next) return undefined
    node = next
  }
  return node
}

function quotedString(value: string, original = ''): string {
  if (original.startsWith("'")) return `'${value.replace(/'/g, "''")}'`
  if (original.startsWith('"')) return JSON.stringify(value)
  // 只让不会改变YAML类型/上下文的plain字符串继续保持plain。
  if (value && !/[\r\n]/.test(value) && value.trim() === value && !/[:\[\]{},#&*!|>'"%@`]/.test(value) && !/^[?\-]/.test(value)) {
    const parsed = parseDocument(`value: ${value}\n`, YAML_OPTIONS)
    const pair = isMap(parsed.contents) ? parsed.contents.items[0] : undefined
    if (!parsed.errors.length && !parsed.warnings.length && isScalar(pair?.value) && pair.value.value === value) return value
  }
  return JSON.stringify(value)
}

function lineStart(source: string, position: number): number {
  for (let cursor = position - 1; cursor >= 0; cursor -= 1) if (source[cursor] === '\n' || source[cursor] === '\r') return cursor + 1
  return 0
}

function encodeScalar(edit: MarkdownPropertyEdit, original: string): string {
  const value = edit.value ?? ''
  if (edit.scalarType === 'string') return quotedString(value, original)
  if (edit.scalarType === 'null') return 'null'
  if (edit.scalarType === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error('布尔属性只能为 true 或 false')
    return value
  }
  if (edit.scalarType === 'number') {
    const document = parseDocument(value, YAML_OPTIONS)
    if (document.errors.length || document.warnings.length || !isScalar(document.contents) || scalarType(document.contents.value) !== 'number' || /[\r\n#]/.test(value)) throw new Error('请输入有限且精度可保留的 YAML 数字')
    return value
  }
  throw new Error('请选择属性类型')
}

interface PropertySignature {
  kind: MarkdownPropertyNode['kind']
  scalarType?: MarkdownScalarType
  value?: string
  children?: Array<{ key?: string; value: PropertySignature }>
}

function signature(node: MarkdownPropertyNode, source: string): PropertySignature {
  if (node.kind === 'raw') return { kind: 'raw', value: source.slice(node.from, node.to) }
  if (node.kind === 'scalar') return { kind: 'scalar', scalarType: node.scalarType, value: node.value }
  return { kind: node.kind, children: node.children.map((child) => ({ ...(node.kind === 'mapping' ? { key: child.label } : {}), value: signature(child, source) })) }
}

/** YAML仍合法不等于修改正确：验证精确意图与每个非目标子树，不把解析成功当作提交许可。 */
function verifyOperation(before: MarkdownPropertyNode, source: string, after: MarkdownPropertyNode, candidate: string, edit: MarkdownPropertyEdit): boolean {
  const samePath = (path: MarkdownPropertyPath): boolean => path.length === edit.path.length && path.every((part, index) => part === edit.path[index])
  const expected = (node: MarkdownPropertyNode): PropertySignature => {
    if (samePath(node.path) && edit.kind === 'set') {
      const encoded = encodeScalar(edit, source.slice(node.from, node.to)).trim()
      const scalar = parseDocument(encoded, YAML_OPTIONS).contents
      if (!isScalar(scalar)) throw new Error('新值不是scalar')
      return { kind: 'scalar', scalarType: edit.scalarType, value: scalar.value === null ? '' : String(scalar.value) }
    }
    const result = signature(node, source)
    if (node.kind === 'mapping' || node.kind === 'sequence') {
      result.children = node.children.flatMap((child) => samePath(child.path) && edit.kind === 'remove' ? [] : [{
        ...(node.kind === 'mapping' ? { key: samePath(child.path) && edit.kind === 'rename' ? edit.key : child.label } : {}), value: expected(child),
      }])
      if (samePath(node.path) && edit.kind === 'insert') {
        const added = parseMarkdownProperties(`---\nvalue: ${edit.valueSource ?? '""'}\n---`)
        const value = added.root?.children[0]
        if (!value) throw new Error('缺少新子项')
        result.children.push({ ...(node.kind === 'mapping' ? { key: edit.key } : {}), value: signature(value, added.source) })
      }
    }
    return result
  }
  return JSON.stringify(expected(before)) === JSON.stringify(signature(after, candidate))
}

/** 单操作、精确首部CAS、单个source patch；其他字段和正文没有序列化路径。 */
export function planMarkdownPropertyEdit(current: string, edit: MarkdownPropertyEdit): MarkdownPropertyChange {
  const noChange = { from: 0, to: 0, insert: '' }
  const fail = (reason: string, status: 'conflict' | 'raw-required' = 'raw-required'): MarkdownPropertyChange => ({ status, reason, change: noChange })
  const model = parseMarkdownProperties(current)
  if (model.source !== edit.expectedFrontmatter) return fail('属性已在别处更改，请重新打开当前字段后再编辑', 'conflict')
  if (model.mode !== 'editable' || !model.root) return fail(model.reason ?? '此 YAML 需要源码编辑')
  const target = nodeAt(model.root, edit.path)
  if (!target) return fail('目标属性已不存在', 'conflict')
  const parent = edit.path.length ? nodeAt(model.root, edit.path.slice(0, -1)) : undefined
  let change: MarkdownPropertyChange['change']
  try {
    if (edit.kind === 'set') {
      if (target.kind !== 'scalar') throw new Error(target.reason ?? '集合或复杂属性请编辑子项或源码')
      if (target.scalarType === edit.scalarType && target.value === (edit.value ?? '')) return { status: 'unchanged', change: noChange }
      change = { from: target.from, to: target.to, insert: encodeScalar(edit, current.slice(target.from, target.to)) }
      // 空值没有token；需要在冒号和新值之间补上分隔空格。
      if (target.from === target.to) {
        if (current[target.from - 1] === ':' || current[target.from - 1] === '-') change.insert = ` ${change.insert}`
        if (current[target.to] === '#') change.insert += ' '
      }
    } else if (edit.kind === 'rename') {
      if (!parent || parent.kind !== 'mapping' || target.keyFrom === undefined || target.keyTo === undefined) throw new Error('列表项不能重命名')
      const key = edit.key ?? ''
      if (!key || /[\r\n]/.test(key) || key === '<<') throw new Error('请输入单行、非合并键的名称')
      if (key === target.label) return { status: 'unchanged', change: noChange }
      if (parent.children.some((child) => child !== target && child.label === key)) throw new Error('同级属性名称已存在')
      change = { from: target.keyFrom, to: target.keyTo, insert: quotedString(key, current.slice(target.keyFrom, target.keyTo)) }
    } else if (edit.kind === 'remove') {
      if (!parent) throw new Error('不能删除整个 Properties 区域')
      const index = parent.children.indexOf(target)
      const start = target.keyFrom ?? target.from
      if (parent.flow) {
        const inside = current.slice(parent.from, parent.to)
        if (/[\r\n#]/.test(inside)) throw new Error('含折行或注释的 flow 集合请在源码中删除')
        const next = parent.children[index + 1], previous = parent.children[index - 1]
        change = next ? { from: start, to: next.keyFrom ?? next.from, insert: '' }
          : previous ? { from: previous.to, to: target.to, insert: '' }
            : { from: start, to: target.to, insert: '' }
      } else if (parent.children.length === 1 && parent.path.length > 0) {
        // 仅改最后一个子项所属的集合，保留header、外部注释与其他字段。
        if (/#/.test(current.slice(parent.from, parent.end))) throw new Error('带注释的最后一项请在源码中删除')
        change = { from: parent.from, to: parent.to, insert: parent.kind === 'sequence' ? '[]\n' : '{}\n' }
      } else {
        const itemStart = target.itemFrom ?? start
        const from = lineStart(current, itemStart)
        const prefix = current.slice(from, itemStart)
        if (!/^[ \t]*$/.test(prefix)) throw new Error('紧凑的复合项请在源码中删除，避免改变评论归属')
        const lastLine = lineStart(current, target.end)
        const to = /^[ \t]*$/.test(current.slice(lastLine, target.end)) ? lastLine : target.end
        change = { from, to, insert: '' }
      }
    } else {
      if (target.kind !== 'mapping' && target.kind !== 'sequence') throw new Error('只能向映射或列表添加子项')
      let valueSource = edit.valueSource ?? '""'
      // 新值也经过同一安全模型校验；只生成新项，不重写既有内容。
      if (/[\r\n]/.test(valueSource)) throw new Error('新增项请先使用单行值，再编辑其子项或源码')
      const newValue = parseMarkdownProperties(`---\nvalue: ${valueSource}\n---`)
      if (newValue.mode !== 'editable' || newValue.root?.children[0]?.kind === 'raw') throw new Error('新增值不是可安全编辑的 YAML 值')
      const added = newValue.root?.children[0]
      if (added?.kind === 'scalar') {
        valueSource = encodeScalar({ ...edit, scalarType: added.scalarType, value: added.value }, valueSource)
      }
      let item = valueSource
      if (target.kind === 'mapping') {
        const key = edit.key ?? ''
        if (!key || /[\r\n]/.test(key) || key === '<<' || target.children.some((child) => child.label === key)) throw new Error('请输入未重复的单行属性名')
        item = `${quotedString(key)}: ${valueSource}`
      }
      if (target.flow) {
        change = { from: target.to - 1, to: target.to - 1, insert: `${target.children.length ? ', ' : ''}${item}` }
      } else {
        const position = target.from
        const indent = current.slice(lineStart(current, position), position)
        if (!/^[ \t]*$/.test(indent)) throw new Error('紧凑的复合项请在源码中添加')
        const eol = /\r\n|\n|\r/.exec(current)?.[0] ?? '\n'
        change = { from: target.to, to: target.to, insert: `${indent}${target.kind === 'sequence' ? '- ' : ''}${item}${eol}` }
      }
    }
    if (current.slice(change.from, change.to) === change.insert) return { status: 'unchanged', change: noChange }
    const candidate = current.slice(0, change.from) + change.insert + current.slice(change.to)
    const after = parseMarkdownProperties(candidate)
    if (after.mode !== 'editable' || !after.root) throw new Error('此修改无法保持 YAML 结构，请改用源码编辑')
    if (!verifyOperation(model.root, current, after.root, candidate, edit)) throw new Error('此布局无法安全保持操作目标与其他属性，请改用源码编辑')
    return { status: 'changed', change }
  } catch (error) {
    return fail(error instanceof Error ? error.message : '无法安全修改，请编辑 YAML 源码')
  }
}
