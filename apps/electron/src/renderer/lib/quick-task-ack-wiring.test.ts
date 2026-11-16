import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * QuickTask 提交确认契约的源码级回归（四层契约：settings 常量/类型 + main + preload + renderer）。
 *
 * 说明：这里断言的是真实接线与关键分支存在，不是真实 Electron 窗口时序；
 * 真实窗口行为由 e2e 脚本与人工验证补充，本测试不替代它们。
 */
// 路径相对本文件所在目录（src/renderer/lib），跨到 src/ 再取目标。
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const settings = read('types/settings.ts')
const ipc = read('main/ipc.ts')
const preload = read('preload/index.ts')
const shortcuts = read('renderer/components/shortcuts/GlobalShortcuts.tsx')
const quickTaskApp = read('renderer/components/quick-task/QuickTaskApp.tsx')

const sliceBetween = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start)
  expect(from).toBeGreaterThanOrEqual(0)
  const to = text.indexOf(end, from + start.length)
  expect(to).toBeGreaterThan(from)
  return text.slice(from, to)
}

describe('QuickTask 提交需经主窗口确认', () => {
  test('Given 四层契约 When 提交快速任务 Then 存在 requestId 与 ACK 通道', () => {
    expect(settings).toContain("ACK_OPEN_SESSION: 'quick-task:ack-open-session'")
    expect(settings).toContain('export interface QuickTaskSubmitResult')
    expect(settings).toContain('export interface QuickTaskOpenSessionAck')
    expect(settings).toContain('requestId: string')
    expect(ipc).toContain('QUICK_TASK_IPC_CHANNELS.ACK_OPEN_SESSION')
    expect(preload).toContain('ackQuickTaskOpenSession')
    expect(preload).toContain('Promise<QuickTaskSubmitResult>')
  })

  test('Given 主窗口未确认 When 提交 Then 先不隐藏窗口且返回未接收', () => {
    const handler = sliceBetween(ipc, 'QUICK_TASK_IPC_CHANNELS.SUBMIT,', 'QUICK_TASK_IPC_CHANNELS.ACK_OPEN_SESSION')
    // 隐藏必须发生在 await 确认之后；没有“先 hide 后转发”的旧顺序。
    const hideIndex = handler.indexOf('hideQuickTaskWindow()')
    const awaitIndex = handler.indexOf('const result = await accepted')
    expect(awaitIndex).toBeGreaterThanOrEqual(0)
    expect(hideIndex).toBeGreaterThan(awaitIndex)
    expect(handler).toContain('accepted: false')
    expect(handler).not.toContain('await import(\'./lib/quick-task-window\')\n      hideQuickTaskWindow()\n\n      const mainWin')
  })

  test('Given 快速任务提交 When 主窗口未接受 Then 保留文字与附件并显示可重试原因', () => {
    const submit = sliceBetween(quickTaskApp, 'const handleSubmit = useCallback(async () => {', '// Enter 提交')
    expect(submit).toContain('if (result.accepted) {')
    // 清空必须在 accepted 分支内。
    const acceptedIndex = submit.indexOf('if (result.accepted) {')
    const clearText = submit.indexOf("setText('')", acceptedIndex)
    expect(clearText).toBeGreaterThan(acceptedIndex)
    expect(submit).toContain('setSubmitError')
    // 旧的“提交即清空”写法必须消失。
    expect(submit).not.toContain("await window.electronAPI.submitQuickTask({\n        text: trimmed,\n        files: attachments.map(({ filename, mediaType, base64, sourcePath, size }) => ({\n          filename, mediaType, base64, sourcePath, size,\n        })),\n      })\n      setText('')")
  })

  test('Given 主窗口收到提交 When 有附件但无项目 Then 明确回报未接收且不自动发送纯文字', () => {
    const handler = sliceBetween(shortcuts, 'onQuickTaskOpenSession(async (data) => {', '// ===== 语音输入')
    expect(handler).toContain('ackQuickTaskOpenSession({')
    expect(handler).toContain('accepted: false')
    expect(handler).toContain('accepted: true')
    // 无项目/保存失败分支必须在设置 pending 之前 return。
    const noWorkspace = handler.indexOf('请先选择项目后再发送附件')
    const pendingSet = handler.indexOf('store.set(agentPendingPromptAtom, {')
    expect(noWorkspace).toBeGreaterThanOrEqual(0)
    expect(pendingSet).toBeGreaterThan(noWorkspace)
    const saveFailure = handler.indexOf('附件保存失败，未发送')
    expect(saveFailure).toBeGreaterThanOrEqual(0)
    expect(saveFailure).toBeLessThan(pendingSet)
  })

  test('Given 搜索命中归档会话 When 打开 Then 按目标补齐 metadata 再切项目', () => {
    const open = sliceBetween(read('renderer/hooks/useOpenSession.ts'), '// 同步 workspaceId', 'options?.onOpened?.()')
    expect(open).toContain('listAgentSessions()')
    expect(open).toContain('prev.some((s) => s.id === target.id)')
    expect(open).toContain('setCurrentAgentWorkspaceId(target.workspaceId)')
  })

  test('Given 回填在途时用户已切走会话或项目 When 迟到 metadata 到达 Then 不覆盖也不写持久化设置', () => {
    const hook = read('renderer/hooks/useOpenSession.ts')
    // 所有导航路径（含同步命中 active 会话）都推进代际，旧回填必然失效。
    expect(hook).toContain('const navigationGeneration = ++navigationGenerationRef.current')
    const open = sliceBetween(hook, '// 同步 workspaceId', 'options?.onOpened?.()')
    // 代际：发起回填时保存的编号，迟到响应必须先比对最新一次导航。
    expect(open).toContain('if (navigationGenerationRef.current !== navigationGeneration) return')
    // 只有当当前会话仍是目标、且项目未被用户改动时才允许切换。
    expect(open).toContain("if (store.get(currentAgentSessionIdAtom) !== sessionId) return")
    expect(open).toContain('openedWorkspaceIdRef.current !== currentWorkspaceId')
    // 仍要先 upsert metadata，再决定是否切项目。
    const upsert = open.indexOf('store.set(agentSessionsAtom')
    const guard = open.indexOf('if (store.get(currentAgentSessionIdAtom) !== sessionId) return')
    expect(upsert).toBeGreaterThanOrEqual(0)
    expect(guard).toBeGreaterThan(upsert)
  })
})
