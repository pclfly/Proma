import { describe, expect, test } from 'bun:test'
import {
  PROMA_SELF_AX_DEFAULT_RESULTS,
  PROMA_SELF_AX_MAX_ELEMENTS,
  buildAxSnapshot,
  findAxNodes,
  resolvePromaSelfAxDepth,
  type CdpAxNodeLike,
} from './cdp-ax'

const nodes: CdpAxNodeLike[] = [
  { backendDOMNodeId: 1, role: { value: 'button' }, name: { value: '设置' } },
  { backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: '项目名称' }, value: { value: 'Proma' } },
  {
    backendDOMNodeId: 3,
    role: { value: 'button' },
    name: { value: '删除项目' },
    properties: [{ name: 'disabled', value: { value: true } }],
  },
  { backendDOMNodeId: 4, role: { value: 'generic' }, name: { value: '普通容器' } },
  { backendDOMNodeId: 0, role: { value: 'button' }, name: { value: '缺少节点 id' } },
  { ignored: true, backendDOMNodeId: 5, role: { value: 'button' }, name: { value: '被忽略' } },
  { backendDOMNodeId: 6, role: { value: 'heading' }, name: { value: '  标题   文本  ' } },
  { backendDOMNodeId: 7, role: { value: 'button' }, name: { value: '' } },
  { backendDOMNodeId: 8, role: { value: 'button' } },
]

describe('buildAxSnapshot', () => {
  test('跳过 ignored、结构节点与缺少 backendNodeId 的节点', () => {
    const snapshot = buildAxSnapshot(nodes, { generation: 1 })
    expect(snapshot.elements.map((element) => element.backendNodeId)).toEqual([1, 2, 3, 7, 8, 6])
    expect(snapshot.totalCandidates).toBe(6)
    expect(snapshot.truncated).toBe(false)
  })

  test('按 maxElements 截断，交互元素优先', () => {
    const snapshot = buildAxSnapshot(nodes, { generation: 1, maxElements: 2 })
    expect(snapshot.elements).toHaveLength(2)
    expect(snapshot.elements.map((element) => element.role)).toEqual(['button', 'textbox'])
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.totalCandidates).toBe(6)
  })

  test('ref 在同一代次内稳定，代次变化后重建', () => {
    const first = buildAxSnapshot(nodes, { generation: 1, maxElements: 3 })
    const second = buildAxSnapshot(nodes, { generation: 1, maxElements: 3 })
    expect(first.elements.map((element) => element.ref)).toEqual(second.elements.map((element) => element.ref))
    expect(first.elements[0]?.ref).toBe('r1-1')

    const next = buildAxSnapshot(nodes, { generation: 2, maxElements: 3 })
    expect(next.elements[0]?.ref).toBe('r2-1')
  })

  test('会话前缀进入 ref，跨会话文本可区分', () => {
    const first = buildAxSnapshot(nodes, { generation: 1, maxElements: 1, refPrefix: 'pa-' })
    const second = buildAxSnapshot(nodes, { generation: 1, maxElements: 1, refPrefix: 'pb-' })
    expect(first.elements[0]?.ref).toBe('pa-r1-1')
    expect(second.elements[0]?.ref).toBe('pb-r1-1')
  })

  test('缺失字段使用空值，disabled 从 AX 属性读取', () => {
    const snapshot = buildAxSnapshot(nodes, { generation: 1 })
    const disabled = snapshot.elements.find((element) => element.backendNodeId === 3)
    expect(disabled?.disabled).toBe(true)
    const emptyName = snapshot.elements.find((element) => element.backendNodeId === 8)
    expect(emptyName?.name).toBe('')
    expect(emptyName?.value).toBe('')
    expect(snapshot.elements.find((element) => element.backendNodeId === 7)?.name).toBe('')
  })

  test('name/value 折叠空白并按长度上限截断', () => {
    const snapshot = buildAxSnapshot(nodes, { generation: 1, maxNameLength: 4 })
    expect(snapshot.elements.find((element) => element.backendNodeId === 6)?.name).toBe('标题 文')
    const withValue = snapshot.elements.find((element) => element.backendNodeId === 2)
    expect(withValue?.value).toBe('Proma')
  })

  test('maxElements 被限制在合法范围', () => {
    expect(buildAxSnapshot(nodes, { generation: 1, maxElements: 10_000 }).elements.length).toBeLessThanOrEqual(PROMA_SELF_AX_MAX_ELEMENTS)
    expect(buildAxSnapshot(nodes, { generation: 1, maxElements: 0 }).elements).toHaveLength(1)
  })

  test('AX 深度按预算切换', () => {
    expect(resolvePromaSelfAxDepth(200)).toBe(10)
    expect(resolvePromaSelfAxDepth(400)).toBe(18)
  })
})

describe('findAxNodes', () => {
  const snapshot = buildAxSnapshot(nodes, { generation: 1 })

  test('按 role 查找', () => {
    const matches = findAxNodes(snapshot, { role: 'button' })
    expect(matches.map((element) => element.backendNodeId)).toEqual([1, 3, 7, 8])
  })

  test('按 name 子串查找且大小写无关', () => {
    expect(findAxNodes(snapshot, { name: '项目' }).map((element) => element.backendNodeId)).toEqual([2, 3])
    expect(findAxNodes(snapshot, { name: '设置' })).toHaveLength(1)
  })

  test('role 与 name 同时限定', () => {
    expect(findAxNodes(snapshot, { role: 'button', name: '删除' }).map((element) => element.backendNodeId)).toEqual([3])
    expect(findAxNodes(snapshot, { role: 'textbox', name: '删除' })).toHaveLength(0)
  })

  test('exact 只接受完整名称', () => {
    expect(findAxNodes(snapshot, { name: '设置', exact: true })).toHaveLength(1)
    expect(findAxNodes(snapshot, { name: '设', exact: true })).toHaveLength(0)
    expect(findAxNodes(snapshot, { name: '设置', exact: false })).toHaveLength(1)
  })

  test('maxResults 限制结果数量，默认 20', () => {
    expect(findAxNodes(snapshot, { role: 'button', maxResults: 2 })).toHaveLength(2)
    expect(findAxNodes(snapshot, { role: 'button' }).length).toBeLessThanOrEqual(PROMA_SELF_AX_DEFAULT_RESULTS)
  })

  test('缺少查询条件或非法 maxResults 时给出中文错误', () => {
    expect(() => findAxNodes(snapshot, {})).toThrow('至少需要 role 或 name')
    expect(() => findAxNodes(snapshot, { role: 'button', maxResults: 0 })).toThrow('maxResults')
    expect(() => findAxNodes(snapshot, { role: 'button', maxResults: 51 })).toThrow('maxResults')
  })
})
