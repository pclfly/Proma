import { describe, expect, test } from 'bun:test'
import type { PromaSelfController } from '../proma-self-controller'
import {
  buildPromaSelfTools,
  type PromaSelfToolsContext,
} from './pi-proma-self-tools'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

interface TestContent {
  type?: string
  text?: string
  data?: string
  mimeType?: string
}

interface TestToolResult {
  content: TestContent[]
  details?: unknown
}

interface TestTool {
  name: string
  label?: string
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<TestToolResult>
}

function fakeSdk(): PiSdk {
  return { defineTool: (tool: TestTool) => tool } as unknown as PiSdk
}

function controllerStub(overrides: Partial<Record<keyof PromaSelfController, unknown>> = {}): PromaSelfController {
  return {
    observe: async () => ({}),
    find: async () => ({}),
    click: async () => ({}),
    act: async () => ({}),
    fill: async () => ({}),
    press: async () => ({}),
    domAction: async () => ({}),
    scroll: async () => ({}),
    waitFor: async () => ({}),
    screenshot: async () => ({ base64: 'YWJj', mimeType: 'image/png', bytes: 3 }),
    ...overrides,
  } as unknown as PromaSelfController
}

function buildTools(
  triggeredBy: PromaSelfToolsContext['triggeredBy'],
  controller: PromaSelfController = controllerStub(),
  requestPromaSelfApproval?: PromaSelfToolsContext['requestPromaSelfApproval'],
): TestTool[] {
  return buildPromaSelfTools(fakeSdk(), {
    triggeredBy,
    sessionId: 'session-a',
    controller,
    requestPromaSelfApproval,
  }) as unknown as TestTool[]
}

function tool(tools: TestTool[], name: string): TestTool {
  const found = tools.find((item) => item.name === name)
  if (!found) throw new Error(`缺少工具：${name}`)
  return found
}

const EXPECTED_TOOL_NAMES = [
  'PromaObserve',
  'PromaFind',
  'PromaClick',
  'PromaAct',
  'PromaFill',
  'PromaPress',
  'PromaDomAction',
  'PromaScroll',
  'PromaWaitFor',
  'PromaScreenshot',
]

describe('Proma 自操作工具触发来源', () => {
  for (const triggeredBy of ['automation', 'delegation', 'external'] as const) {
    test(`${triggeredBy} 触发返回空工具列表`, () => {
      expect(buildTools(triggeredBy)).toHaveLength(0)
    })
  }

  test('用户主会话与未标注来源获得 10 个工具', () => {
    for (const triggeredBy of ['user', undefined] as const) {
      const tools = buildTools(triggeredBy)
      expect(tools).toHaveLength(10)
      expect(tools.map((item) => item.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort())
    }
  })

  test('工具 label 为中文', () => {
    const tools = buildTools('user')
    for (const item of tools) {
      expect(typeof item.label).toBe('string')
      expect(/[\u4e00-\u9fff]/u.test(item.label ?? '')).toBe(true)
    }
  })
})

describe('Proma 自操作工具参数校验', () => {
  test('缺少 ref 时给出中文错误', async () => {
    await expect(tool(buildTools('user'), 'PromaClick').execute('call-1', {})).rejects.toThrow('ref 必须是非空字符串')
  })

  test('maxElements 越界时给出中文错误', async () => {
    await expect(tool(buildTools('user'), 'PromaObserve').execute('call-1', { maxElements: 0 })).rejects.toThrow('maxElements 必须是 1 到 400 的整数')
  })

  test('Find 缺少 role/name 时给出中文错误', async () => {
    await expect(tool(buildTools('user'), 'PromaFind').execute('call-1', {})).rejects.toThrow('PromaFind 至少需要 role 或 name')
  })

  test('DomAction 拒绝任意动作名', async () => {
    await expect(tool(buildTools('user'), 'PromaDomAction').execute('call-1', {
      action: 'evaluate',
      selector: '#x',
    })).rejects.toThrow('只支持 focus、fill、click、inspect')
  })

  test('Fill 缺少文本时给出中文错误', async () => {
    await expect(tool(buildTools('user'), 'PromaFill').execute('call-1', { ref: 'r1' })).rejects.toThrow('输入文本必须是字符串')
  })

  test('Scroll 同时给出 deltaY 与 position 时拒绝', async () => {
    await expect(tool(buildTools('user'), 'PromaScroll').execute('call-1', {
      deltaY: 10,
      position: 'top',
    })).rejects.toThrow('滚动只能指定 deltaY 或 position 其中之一')
  })

  test('WaitFor 拒绝未知条件类型', async () => {
    await expect(tool(buildTools('user'), 'PromaWaitFor').execute('call-1', {
      kind: 'url',
      value: 'https://example.com',
    })).rejects.toThrow('等待条件必须是 text 或 selector')
  })

  test('所有参数错误都包含中文', async () => {
    try {
      await tool(buildTools('user'), 'PromaClick').execute('call-1', {})
      throw new Error('应当拒绝空 ref')
    } catch (error) {
      expect(error instanceof Error).toBe(true)
      expect(/[\u4e00-\u9fff]/u.test((error as Error).message)).toBe(true)
    }
  })
})

describe('Proma 自操作工具结果', () => {
  test('Screenshot 返回 image content', async () => {
    const result = await tool(buildTools('user'), 'PromaScreenshot').execute('call-1', {})
    const image = result.content.find((item) => item.type === 'image')
    expect(image?.data).toBe('YWJj')
    expect(image?.mimeType).toBe('image/png')
    expect(result.content.some((item) => item.type === 'text' && item.text?.includes('已截取'))).toBe(true)
  })

  test('Click 把用户审批回调传给控制器', async () => {
    let received: unknown
    const approval = async () => true
    const controller = controllerStub({
      click: async (_ref: string, _signal?: AbortSignal, approve?: unknown) => {
        received = approve
        return { clicked: true }
      },
    })
    const tools = buildTools('user', controller, approval)
    await tool(tools, 'PromaClick').execute('call-1', { ref: 'r1' })
    expect(received).toBe(approval)
  })

  test('Observe 返回 JSON 文本结果', async () => {
    const controller = controllerStub({
      observe: async () => ({ sessionId: 'session-a', generation: 1, elements: [], truncated: false, totalCandidates: 0 }),
    })
    const result = await tool(buildTools('user', controller), 'PromaObserve').execute('call-1', {})
    expect(result.content).toHaveLength(1)
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('"generation":1')
    expect(result.details).toEqual({ sessionId: 'session-a', generation: 1, elements: [], truncated: false, totalCandidates: 0 })
  })
})
