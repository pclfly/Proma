import { describe, expect, test } from 'bun:test'
import {
  PROMA_SELF_CONTROL_ERRORS,
  type PromaSelfGuardDescription,
} from './proma-self-control-policy'
import type { CdpAxNodeLike } from './cdp-ax'
import {
  buildPromaSelfActiveElementExpression,
  buildPromaSelfDomActionExpression,
  buildPromaSelfScrollExpression,
  buildPromaSelfWaitExpression,
  type PromaSelfDomActionInput,
} from './proma-self-dom-scripts'
import {
  createPromaSelfController,
  type PromaSelfController,
  type PromaSelfSendCommand,
} from './proma-self-controller'

interface FakeCall {
  method: string
  params: Record<string, unknown>
}

interface HarnessOptions {
  nodes?: CdpAxNodeLike[]
  guard?: Partial<PromaSelfGuardDescription>
  guardFor?: (backendNodeId: number) => Partial<PromaSelfGuardDescription> | undefined
  evaluate?: () => unknown
  screenshotData?: string
  delayMs?: number
  sessionId?: string
}

interface Harness {
  controller: PromaSelfController
  calls: FakeCall[]
  stats: { active: number; maxActive: number }
  mouseEvents: () => FakeCall[]
  runtimeExpressions: () => string[]
}

const BASE_GUARD: PromaSelfGuardDescription = {
  protected: false,
  protectedSelector: null,
  projectCreation: false,
  label: '',
  tagName: 'button',
  editable: false,
  disabled: false,
}

const fixtureNodes: CdpAxNodeLike[] = [
  { backendDOMNodeId: 101, role: { value: 'button' }, name: { value: '设置' } },
  { backendDOMNodeId: 102, role: { value: 'button' }, name: { value: '删除项目' } },
  { backendDOMNodeId: 103, role: { value: 'button' }, name: { value: '新建项目' } },
  { backendDOMNodeId: 104, role: { value: 'textbox' }, name: { value: '密码' } },
  { backendDOMNodeId: 105, role: { value: 'tab' }, name: { value: '外观' } },
]

function createHarness(options: HarnessOptions = {}): Harness {
  const calls: FakeCall[] = []
  const stats = { active: 0, maxActive: 0 }
  const nodes = options.nodes ?? fixtureNodes
  let lastResolvedNodeId = 0

  const sendCommand: PromaSelfSendCommand = async (method, params) => {
    stats.active += 1
    stats.maxActive = Math.max(stats.maxActive, stats.active)
    calls.push({ method, params })
    try {
      if (options.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, options.delayMs))
      if (method === 'Accessibility.getFullAXTree') return { nodes }
      if (method === 'DOM.resolveNode') {
        lastResolvedNodeId = typeof params.backendNodeId === 'number' ? params.backendNodeId : 0
        return { object: { objectId: `object-${lastResolvedNodeId}` } }
      }
      if (method === 'Runtime.callFunctionOn') {
        const description = options.guardFor?.(lastResolvedNodeId) ?? options.guard
        return { result: { value: { ...BASE_GUARD, ...description } } }
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } }
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: options.evaluate ? options.evaluate() : null } }
      }
      if (method === 'Page.captureScreenshot') {
        return { data: options.screenshotData ?? 'iVBORw0KGgo=' }
      }
      return {}
    } finally {
      stats.active -= 1
    }
  }

  return {
    controller: createPromaSelfController({
      sendCommand,
      sessionId: options.sessionId ?? 'session-a',
      pollIntervalMs: 5,
    }),
    calls,
    stats,
    mouseEvents: () => calls.filter((call) => call.method === 'Input.dispatchMouseEvent'),
    runtimeExpressions: () => calls
      .filter((call) => call.method === 'Runtime.evaluate')
      .map((call) => call.params.expression)
      .filter((value): value is string => typeof value === 'string'),
  }
}

function refOf(observation: Awaited<ReturnType<PromaSelfController['observe']>>, name: string): string {
  const element = observation.elements.find((item) => item.name === name)
  if (!element) throw new Error(`fixture 缺少元素：${name}`)
  return element.ref
}

describe('PromaSelfController 观察与 ref 生命周期', () => {
  test('观察返回受保护/项目创建标记，新观察使旧 ref 失效', async () => {
    const harness = createHarness()
    const first = await harness.controller.observe()
    expect(first.sessionId).toBe('session-a')
    expect(first.generation).toBe(1)
    expect(first.elements).toHaveLength(5)
    expect(first.elements.find((item) => item.name === '删除项目')?.protected).toBe(true)
    expect(first.elements.find((item) => item.name === '新建项目')?.projectCreation).toBe(true)
    expect(first.elements.find((item) => item.name === '密码')?.protected).toBe(true)

    const oldRef = first.elements[0]?.ref ?? ''
    expect(oldRef).not.toBe('')
    const second = await harness.controller.observe()
    expect(second.generation).toBe(2)
    expect(second.elements[0]?.ref).not.toBe(oldRef)
    await expect(harness.controller.click(oldRef)).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.refInvalid)
  })

  test('Find 同样递增 generation 并使旧 ref 失效', async () => {
    const harness = createHarness()
    const first = await harness.controller.observe()
    const found = await harness.controller.find({ role: 'button', name: '设置' })
    expect(found.generation).toBe(first.generation + 1)
    expect(found.elements).toHaveLength(1)
    expect(found.elements[0]?.protected).toBe(false)
    await expect(harness.controller.click(first.elements[0]?.ref ?? '')).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.refInvalid)
  })

  test('跨会话 ref 文本不同且互相拒绝', async () => {
    const firstHarness = createHarness({ sessionId: 'session-a' })
    const secondHarness = createHarness({ sessionId: 'session-b' })
    const first = await firstHarness.controller.observe()
    const second = await secondHarness.controller.observe()
    expect(first.elements[0]?.ref).not.toBe(second.elements[0]?.ref)
    await expect(secondHarness.controller.click(first.elements[0]?.ref ?? '')).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.refInvalid)
  })
})

describe('PromaSelfController 受保护控件', () => {
  test('删除按钮拒绝点击且不派发鼠标事件', async () => {
    const harness = createHarness()
    const observation = await harness.controller.observe()
    const before = harness.mouseEvents().length
    await expect(harness.controller.click(refOf(observation, '删除项目'))).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.protectedElement)
    expect(harness.mouseEvents()).toHaveLength(before)
  })

  test('密码字段拒绝填写', async () => {
    const harness = createHarness()
    const observation = await harness.controller.observe()
    await expect(harness.controller.fill(refOf(observation, '密码'), 'hunter2')).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.protectedElement)
    expect(harness.calls.some((call) => call.method === 'DOM.focus' || call.method === 'Input.insertText')).toBe(false)
  })

  test('AskUser 选项使用专用拒绝文案', async () => {
    const harness = createHarness({
      guardFor: (backendNodeId) => backendNodeId === 105
        ? { protected: true, protectedSelector: '[data-proma-ask-user-option]' }
        : undefined,
    })
    const observation = await harness.controller.observe()
    await expect(harness.controller.click(refOf(observation, '外观'))).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.askUserOption)
  })
})

describe('PromaSelfController 新建项目审批', () => {
  test('无肯定回答拒绝，有肯定回答只派发一次', async () => {
    const harness = createHarness()
    const observation = await harness.controller.observe()
    const projectRef = refOf(observation, '新建项目')
    let approvals = 0

    const deny = () => {
      approvals += 1
      return false
    }
    await expect(harness.controller.click(projectRef, undefined, deny)).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.projectApprovalRequired)
    expect(approvals).toBe(1)
    expect(harness.mouseEvents()).toHaveLength(0)

    const approve = () => {
      approvals += 1
      return true
    }
    await harness.controller.click(projectRef, undefined, approve)
    expect(approvals).toBe(2)
    expect(harness.mouseEvents().filter((call) => call.params.type === 'mousePressed')).toHaveLength(1)

    await expect(harness.controller.click(projectRef, undefined, approve)).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.projectAlreadyApproved)
    expect(approvals).toBe(2)
    expect(harness.mouseEvents().filter((call) => call.params.type === 'mousePressed')).toHaveLength(1)
  })

  test('DomAction 点击项目创建入口同样需要审批', async () => {
    let approvals = 0
    const harness = createHarness({
      evaluate: () => ({
        ok: true,
        protected: false,
        protectedSelector: null,
        projectCreation: true,
        label: '新建项目',
        tagName: 'button',
        editable: false,
        disabled: false,
      }),
    })
    await expect(harness.controller.domAction(
      { action: 'click', selector: '[data-proma-project-creation]' },
      undefined,
      () => {
        approvals += 1
        return false
      },
    )).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.projectApprovalRequired)
    expect(approvals).toBe(1)
    expect(harness.calls.some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false)
  })
})

describe('PromaSelfController DomAction 固定动作', () => {
  test('拒绝未知动作，不进入页面执行', async () => {
    const harness = createHarness()
    await expect(harness.controller.domAction({ action: 'evaluate' as never, selector: '#x' })).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.domActionUnsupported)
    expect(harness.runtimeExpressions()).toHaveLength(0)
  })

  test('额外 script 字段被丢弃，selector 以 JSON 数据嵌入', async () => {
    const harness = createHarness({ evaluate: () => ({ ok: true }) })
    const selector = `#x'; throw new Error('pwn'); //`
    await harness.controller.domAction({ action: 'inspect', selector, script: 'alert(1)' } as PromaSelfDomActionInput)
    const expressions = harness.runtimeExpressions()
    expect(expressions).toHaveLength(1)
    const expression = expressions[0] ?? ''
    expect(expression).toContain(JSON.stringify(selector))
    expect(expression).not.toContain('alert(1)')
  })

  test('固定的 DOM、滚动、等待与焦点脚本均可编译', () => {
    const expressions = [
      buildPromaSelfDomActionExpression({ action: 'inspect', selector: '#panel' }),
      buildPromaSelfDomActionExpression({ action: 'fill', selector: '#name', text: 'Proma' }),
      buildPromaSelfScrollExpression({ deltaY: 200 }),
      buildPromaSelfWaitExpression({ kind: 'text', value: '设置' }),
      buildPromaSelfActiveElementExpression(),
    ]
    for (const expression of expressions) {
      expect(() => new Function(`return ${expression}`)).not.toThrow()
    }
  })
})

describe('PromaSelfController 串行与取消', () => {
  test('并发动作按顺序执行，不重叠', async () => {
    const harness = createHarness({ delayMs: 5 })
    const observation = await harness.controller.observe()
    const first = harness.controller.click(refOf(observation, '设置'))
    const second = harness.controller.click(refOf(observation, '外观'))
    await Promise.all([first, second])
    expect(harness.stats.maxActive).toBe(1)
    expect(harness.mouseEvents().filter((call) => call.params.type === 'mousePressed')).toHaveLength(2)
  })

  test('已取消的动作不派发任何命令', async () => {
    const harness = createHarness()
    const observation = await harness.controller.observe()
    const before = harness.calls.length
    const aborted = new AbortController()
    aborted.abort()
    await expect(harness.controller.click(refOf(observation, '设置'), aborted.signal)).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.aborted)
    expect(harness.calls.length).toBe(before)
  })

  test('排队期间被取消的动作在轮到时也不派发', async () => {
    const harness = createHarness({ delayMs: 10 })
    const observing = harness.controller.observe()
    const aborted = new AbortController()
    aborted.abort()
    const queued = harness.controller.click('ignored-ref', aborted.signal)
    await observing
    await expect(queued).rejects.toThrow(PROMA_SELF_CONTROL_ERRORS.aborted)
    expect(harness.mouseEvents()).toHaveLength(0)
  })
})

describe('PromaSelfController 正常动作路径', () => {
  test('填写普通输入框会聚焦、全选并插入文本', async () => {
    const nodes: CdpAxNodeLike[] = [
      { backendDOMNodeId: 201, role: { value: 'textbox' }, name: { value: '项目名称' } },
    ]
    const harness = createHarness({ nodes, guard: { editable: true, tagName: 'input' } })
    const observation = await harness.controller.observe()
    const ref = observation.elements[0]?.ref ?? ''
    const result = await harness.controller.fill(ref, 'Proma 项目')
    expect(result.filled).toBe(true)
    expect(result.length).toBe('Proma 项目'.length)
    expect(harness.calls.some((call) => call.method === 'DOM.focus')).toBe(true)
    expect(harness.calls.filter((call) => call.method === 'Input.dispatchKeyEvent')).toHaveLength(2)
    expect(harness.calls.find((call) => call.method === 'Input.insertText')?.params.text).toBe('Proma 项目')
  })

  test('按键与文本输入走固定 CDP 通道', async () => {
    const harness = createHarness()
    const keyResult = await harness.controller.press('Enter')
    expect(keyResult.kind).toBe('key')
    expect(harness.calls.filter((call) => call.method === 'Input.dispatchKeyEvent')).toHaveLength(2)

    const textResult = await harness.controller.press('设置')
    expect(textResult.kind).toBe('text')
    expect(harness.calls.find((call) => call.method === 'Input.insertText')?.params.text).toBe('设置')
  })

  test('滚动返回页面内固定脚本结果', async () => {
    const harness = createHarness({ evaluate: () => ({ ok: true, moved: true }) })
    const result = await harness.controller.scroll({ deltaY: 200 })
    expect(result.selector).toBeNull()
    expect(result.result.moved).toBe(true)
    expect(harness.runtimeExpressions()[0]).toContain('"deltaY":200')
  })

  test('Act 在点击后等待条件命中', async () => {
    const harness = createHarness({ evaluate: () => true })
    const observation = await harness.controller.observe()
    const result = await harness.controller.act(refOf(observation, '设置'), { kind: 'text', value: '已打开设置' }, 500)
    expect(result.click.clicked).toBe(true)
    expect(result.wait?.matched).toBe(true)
    expect(result.wait?.kind).toBe('text')
  })
})

describe('PromaSelfController 等待与截图', () => {  test('waitFor 超时返回 matched:false 而不是抛出', async () => {
    const harness = createHarness({ evaluate: () => false })
    const result = await harness.controller.waitFor({ kind: 'text', value: '永不出现' }, 120)
    expect(result.matched).toBe(false)
    expect(result.kind).toBe('text')
    expect(result.value).toBe('永不出现')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(90)
    expect(harness.runtimeExpressions().length).toBeGreaterThan(1)
  })

  test('screenshot 返回 base64 与字节估算', async () => {
    const harness = createHarness({ screenshotData: 'YWJj' })
    const screenshot = await harness.controller.screenshot()
    expect(screenshot.base64).toBe('YWJj')
    expect(screenshot.mimeType).toBe('image/png')
    expect(screenshot.bytes).toBe(3)
  })
})
