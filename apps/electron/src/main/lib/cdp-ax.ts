/**
 * CDP Accessibility 节点树的有界快照工具。
 *
 * Proma 自操作只通过主窗口内部的 webContents.debugger 读取 AX 树，不开放公共调试端口。
 * 本文件不依赖 Electron，输入输出都是普通对象，便于在 Bun 测试里直接验证。
 */

/** CDP AXValue 的最小结构。 */
export interface CdpAxValueLike {
  value?: unknown
}

/** CDP AXProperty 的最小结构。 */
export interface CdpAxPropertyLike {
  name?: string
  value?: CdpAxValueLike
}

/** CDP Accessibility.getFullAXTree 返回节点中本模块关心的字段。 */
export interface CdpAxNodeLike {
  backendDOMNodeId?: number
  ignored?: boolean
  role?: CdpAxValueLike
  name?: CdpAxValueLike
  value?: CdpAxValueLike
  properties?: CdpAxPropertyLike[]
}

export interface AxSnapshotOptions {
  /** 观察代次；每次 Observe/Find 递增，旧 ref 随之失效。 */
  generation: number
  /** 最多返回多少元素，默认 200，上限 400。 */
  maxElements?: number
  /** ref 前缀；主进程用会话令牌隔离不同会话的 ref。 */
  refPrefix?: string
  /** 单个 name 的最大长度，避免超长文本撑爆结果。 */
  maxNameLength?: number
  /** 单个 value 的最大长度。 */
  maxValueLength?: number
}

export interface AxSnapshotElement {
  /** 形如 `<prefix>r<generation>-<序号>`，同一代次内稳定。 */
  ref: string
  role: string
  name: string
  value: string
  disabled: boolean
  /** 用于后续 CDP DOM/Input 操作；没有它的节点不会进入快照。 */
  backendNodeId: number
}

export interface AxSnapshot {
  generation: number
  elements: AxSnapshotElement[]
  /** 候选节点是否被 maxElements 截断。 */
  truncated: boolean
  totalCandidates: number
}

export interface AxFindQuery {
  role?: string
  name?: string
  /** name 精确匹配；默认子串匹配。 */
  exact?: boolean
  /** 最多返回多少条，默认 20，上限 50。 */
  maxResults?: number
}

export const PROMA_SELF_AX_DEFAULT_MAX_ELEMENTS = 200
export const PROMA_SELF_AX_MAX_ELEMENTS = 400
export const PROMA_SELF_AX_MAX_RESULTS = 50
export const PROMA_SELF_AX_DEFAULT_RESULTS = 20

const AX_DEFAULT_DEPTH = 10
const AX_EXTENDED_DEPTH = 18

/** 交互角色优先；与浏览器观察一致，但不复制其业务类型。 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'gridcell',
  'row',
  'scrollbar',
])

/** 纯结构节点不进入快照，减少噪声。 */
const SKIPPED_ROLES = new Set([
  'none',
  'generic',
  'presentation',
  'ignored',
  'StaticText',
  'InlineTextBox',
  'LineBreak',
  'RootWebArea',
  'WebArea',
])

/** 深树会长时间阻塞 Chromium 序列化；按预算切换深度。 */
export function resolvePromaSelfAxDepth(maxElements: number): number {
  return maxElements > 240 ? AX_EXTENDED_DEPTH : AX_DEFAULT_DEPTH
}

function readText(value: CdpAxValueLike | undefined): string {
  if (!value || typeof value !== 'object') return ''
  const raw = value.value
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return ''
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isDisabledNode(node: CdpAxNodeLike): boolean {
  if (!Array.isArray(node.properties)) return false
  for (const property of node.properties) {
    if (!property || typeof property !== 'object') continue
    const name = typeof property.name === 'string' ? property.name.toLowerCase() : ''
    if (name !== 'disabled' && name !== 'unavailable') continue
    if (property.value?.value === true) return true
  }
  return false
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 把 CDP AX 节点列表压平成有界快照。
 *
 * - 跳过 ignored/结构节点，以及没有 backendDOMNodeId 的节点（无法后续操作）；
 * - 有 name/value 或属于交互角色的节点才保留；
 * - 交互角色排在前面，保证 maxElements 较小时优先返回可操作元素；
 * - ref 由 generation 与结果序号生成，同一代次内稳定，动作前会校验代次。
 */
export function buildAxSnapshot(nodes: readonly CdpAxNodeLike[], options: AxSnapshotOptions): AxSnapshot {
  const generation = Number.isInteger(options.generation) && options.generation > 0 ? options.generation : 1
  const maxElements = clampInteger(options.maxElements, PROMA_SELF_AX_DEFAULT_MAX_ELEMENTS, 1, PROMA_SELF_AX_MAX_ELEMENTS)
  const maxNameLength = clampInteger(options.maxNameLength, 200, 1, 2_000)
  const maxValueLength = clampInteger(options.maxValueLength, 200, 1, 2_000)
  const refPrefix = typeof options.refPrefix === 'string' ? options.refPrefix : ''

  const interactive: Array<Omit<AxSnapshotElement, 'ref'>> = []
  const other: Array<Omit<AxSnapshotElement, 'ref'>> = []

  for (const node of nodes) {
    if (!node || typeof node !== 'object' || node.ignored === true) continue
    const backendNodeId = typeof node.backendDOMNodeId === 'number' && node.backendDOMNodeId > 0 ? node.backendDOMNodeId : 0
    if (!backendNodeId) continue
    const role = readText(node.role).trim()
    if (!role || SKIPPED_ROLES.has(role)) continue
    const name = collapseWhitespace(readText(node.name)).slice(0, maxNameLength)
    const value = collapseWhitespace(readText(node.value)).slice(0, maxValueLength)
    const isInteractive = INTERACTIVE_ROLES.has(role)
    if (!name && !value && !isInteractive) continue
    const element: Omit<AxSnapshotElement, 'ref'> = {
      role,
      name,
      value,
      disabled: isDisabledNode(node),
      backendNodeId,
    }
    if (isInteractive) interactive.push(element)
    else other.push(element)
  }

  const totalCandidates = interactive.length + other.length
  const selected = [...interactive, ...other].slice(0, maxElements)
  const elements: AxSnapshotElement[] = selected.map((element, index) => ({
    ...element,
    ref: `${refPrefix}r${generation}-${index + 1}`,
  }))

  return {
    generation,
    elements,
    truncated: totalCandidates > elements.length,
    totalCandidates,
  }
}

/** 在快照内按 role 与 name 查找；name 默认子串匹配。 */
export function findAxNodes(snapshot: AxSnapshot, query: AxFindQuery): AxSnapshotElement[] {
  const role = typeof query.role === 'string' ? query.role.trim().toLowerCase() : ''
  const name = typeof query.name === 'string' ? collapseWhitespace(query.name).toLowerCase() : ''
  if (!role && !name) throw new Error('语义定位至少需要 role 或 name。')
  const requestedMax = query.maxResults
  if (requestedMax !== undefined && (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > PROMA_SELF_AX_MAX_RESULTS)) {
    throw new Error(`maxResults 必须是 1 到 ${PROMA_SELF_AX_MAX_RESULTS} 的整数。`)
  }
  const maxResults = requestedMax ?? PROMA_SELF_AX_DEFAULT_RESULTS
  const exact = query.exact === true

  const matches: AxSnapshotElement[] = []
  for (const element of snapshot.elements) {
    if (role && element.role.toLowerCase() !== role) continue
    if (name) {
      const candidate = element.name.toLowerCase()
      if (exact ? candidate !== name : !candidate.includes(name)) continue
    }
    matches.push(element)
    if (matches.length >= maxResults) break
  }
  return matches
}
