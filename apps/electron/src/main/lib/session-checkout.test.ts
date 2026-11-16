import { describe, expect, test } from 'bun:test'
import {
  MAX_CHECKOUT_HISTORY,
  appendCheckoutEntry,
  isCaseInsensitivePlatform,
  isCurrentCheckout,
  normalizeCheckoutPathForCompare,
  resolveSessionCheckout,
  type CheckoutHistoryEntry,
} from './session-checkout'

function recorded(
  path: string,
  recordedAt: number,
  extra: Partial<CheckoutHistoryEntry> = {},
): CheckoutHistoryEntry {
  return { path, recordedAt, ...extra }
}

function existingDirectories(...paths: string[]): (path: string) => boolean {
  const existing = new Set(paths)
  return (path) => existing.has(path)
}

const noDirectory = (): boolean => false

describe('会话检出解析', () => {
  test('Given 最近的历史检出仍存在 When 解析 Then 命中该目录且不回退', () => {
    const checkout = resolveSessionCheckout({
      history: [recorded('/work/old', 1), recorded('/work/recent', 2)],
      agentCwdMode: 'project',
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, existingDirectories('/work/old', '/work/recent'))

    expect(checkout).toEqual({ path: '/work/recent', isFallback: false, fellBack: false })
  })

  test('Given 最近的历史目录已被删除 When 解析 Then 使用更早仍存在的检出', () => {
    const checkout = resolveSessionCheckout({
      history: [recorded('/work/old', 1), recorded('/work/removed', 2)],
      agentCwdMode: 'project',
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, existingDirectories('/work/old'))

    expect(checkout).toEqual({ path: '/work/old', isFallback: false, fellBack: false })
  })

  test('Given 历史全部失效且 activeWorktree 仍存在 When 解析 Then 使用 activeWorktree 且不标记回退', () => {
    const checkout = resolveSessionCheckout({
      history: [recorded('/work/removed', 1)],
      activeWorktree: { path: '/work/active' },
      agentCwdMode: 'project',
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, existingDirectories('/work/active'))

    expect(checkout).toEqual({ path: '/work/active', isFallback: false, fellBack: false })
  })

  test('Given 历史与 activeWorktree 全部失效 When 解析 Then 回退项目目录并标记 fellBack', () => {
    const checkout = resolveSessionCheckout({
      history: [recorded('/work/removed', 1)],
      activeWorktree: { path: '/work/also-removed' },
      agentCwdMode: 'project',
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, noDirectory)

    expect(checkout).toEqual({ path: '/project', isFallback: true, fellBack: true })
  })

  test('Given 仅 activeWorktree 失效且无历史 When 解析 Then 回退并标记 fellBack', () => {
    const checkout = resolveSessionCheckout({
      activeWorktree: { path: '/work/removed' },
      agentCwdMode: 'session',
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, noDirectory)

    expect(checkout).toEqual({ path: '/workbench', isFallback: true, fellBack: true })
  })

  test('Given 没有任何检出记录且为 session 模式 When 解析 Then 回退工作台目录且不标记 fellBack', () => {
    const checkout = resolveSessionCheckout({
      agentCwdMode: 'session',
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, noDirectory)

    expect(checkout).toEqual({ path: '/workbench', isFallback: true, fellBack: false })
  })

  test('Given 缺少 agentCwdMode When 解析 Then 按旧版 session 语义回退工作台目录', () => {
    const checkout = resolveSessionCheckout({
      projectPath: '/project',
      workbenchPath: '/workbench',
    }, noDirectory)

    expect(checkout).toEqual({ path: '/workbench', isFallback: true, fellBack: false })
  })

  test('Given 项目模式缺少项目路径 When 解析 Then 抛出可读错误', () => {
    expect(() => resolveSessionCheckout({
      agentCwdMode: 'project',
      projectPath: '',
      workbenchPath: '/workbench',
    }, noDirectory)).toThrow('缺少可回退的会话工作目录')
  })
})

describe('检出历史维护', () => {
  test('Given 同一路径再次检出 When 追加 Then 去重并移到末尾', () => {
    const history = [recorded('/work/a', 1), recorded('/work/b', 2)]

    const next = appendCheckoutEntry(history, recorded('/work/a', 3, { branch: 'feature' }))

    expect(next.map((entry) => entry.path)).toEqual(['/work/b', '/work/a'])
    expect(next[1]?.branch).toBe('feature')
    expect(history).toHaveLength(2)
  })

  test('Given 仅分隔符与大小写不同 When 追加 Then 视为同一路径去重', () => {
    const history = [recorded('C:/Work/WT', 1)]

    const next = appendCheckoutEntry(history, recorded('C:\\work\\wt\\', 2), {
      caseInsensitive: true,
    })

    expect(next).toHaveLength(1)
    expect(next[0]?.path).toBe('C:\\work\\wt\\')
  })

  test('Given 历史达到上限 When 追加 Then 只保留最近 20 条', () => {
    let history: CheckoutHistoryEntry[] = []
    for (let index = 1; index <= MAX_CHECKOUT_HISTORY + 5; index += 1) {
      history = appendCheckoutEntry(history, recorded(`/work/${index}`, index))
    }

    expect(history).toHaveLength(MAX_CHECKOUT_HISTORY)
    expect(history[0]?.path).toBe('/work/6')
    expect(history[MAX_CHECKOUT_HISTORY - 1]?.path).toBe(`/work/${MAX_CHECKOUT_HISTORY + 5}`)
  })

  test('Given 空路径 When 追加 Then 历史保持不变', () => {
    const history = [recorded('/work/a', 1)]

    expect(appendCheckoutEntry(history, recorded('', 2))).toEqual(history)
  })

  test('Given 路径就是最新检出 When 判断 Then 分隔符差异不影响结论', () => {
    const history = [recorded('/work/a', 1), recorded('/work/b', 2)]

    expect(isCurrentCheckout(history, '/work/b')).toBe(true)
    expect(isCurrentCheckout(history, '/work/a')).toBe(false)
    expect(isCurrentCheckout(history, '\\work\\b\\')).toBe(true)
    expect(isCurrentCheckout([], '/work/b')).toBe(false)
  })
})

describe('检出路径归一', () => {
  test('Given Windows 分隔符 When 归一 Then 统一为正斜杠并去掉末尾分隔符', () => {
    expect(normalizeCheckoutPathForCompare('C:\\Work\\WT\\', false)).toBe('C:/Work/WT')
  })

  test('Given 大小写不敏感平台 When 归一 Then 统一小写', () => {
    expect(normalizeCheckoutPathForCompare('C:\\Work\\WT', true)).toBe('c:/work/wt')
  })

  test('Given 相对路径 When 归一 Then 不按 cwd resolve', () => {
    expect(normalizeCheckoutPathForCompare('../wt', false)).toBe('../wt')
  })

  test('Given 平台 When 判断大小写敏感性 Then 按 win32/darwin 不敏感处理', () => {
    expect(isCaseInsensitivePlatform('win32')).toBe(true)
    expect(isCaseInsensitivePlatform('darwin')).toBe(true)
    expect(isCaseInsensitivePlatform('linux')).toBe(false)
    expect(isCaseInsensitivePlatform()).toBe(isCaseInsensitivePlatform(process.platform))
  })
})
