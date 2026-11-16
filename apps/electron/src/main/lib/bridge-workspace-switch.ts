import { existsSync, readFileSync } from 'node:fs'
import { writeJsonFileAtomic } from './safe-file'

/** 两个 JSON 文件不能一起 rename；以小型意图记录防止半提交在重启后自动发往另一项目。 */
export interface BridgeWorkspaceSwitchJournal {
  isPending(): boolean
  begin(): void
  complete(): void
}

export function createBridgeWorkspaceSwitchJournal(bindingsPath: string): BridgeWorkspaceSwitchJournal {
  const path = `${bindingsPath}.workspace-switch.json`
  return {
    isPending() {
      if (!existsSync(path)) return false
      try {
        const record: unknown = JSON.parse(readFileSync(path, 'utf-8'))
        return !record || typeof record !== 'object' || !('pending' in record) || record.pending !== false
      } catch {
        return true
      }
    },
    begin: () => writeJsonFileAtomic(path, { pending: true }),
    complete: () => writeJsonFileAtomic(path, { pending: false }),
  }
}

export class BridgeWorkspaceSwitchError extends Error {
  constructor(readonly requiresRepair: boolean) {
    super(requiresRepair
      ? '项目切换未能完成回滚，已暂停自动处理。请用 /workspace 重新选择项目后再试。'
      : '项目切换保存失败，未切换会话。请稍后重试。')
  }
}

interface BridgeWorkspaceSwitchInput {
  workspaceId: string
  getDefaultWorkspaceId(): string | undefined
  persistDefaultWorkspaceId(workspaceId: string | undefined): void | Promise<void>
  /** await 后确认目标和原绑定快照没有被删除或替换。 */
  validate(): boolean
  persistBindings(): void
  restoreBindings(): void
  commitMemory(): void
  restoreMemory(): void
  journal?: BridgeWorkspaceSwitchJournal
}

/**
 * 默认配置先落盘，再提交绑定。失败时补偿；无法证明补偿成功则保留 pending 记录。
 * 调用方须串行化本平台的切换，并在 pending/需修复时拒绝自动创建和消息派发。
 * 这是可恢复的补偿事务，不宣称多文件原子提交或断电后的 fsync 持久性。
 */
export async function commitBridgeWorkspaceSwitch(input: BridgeWorkspaceSwitchInput): Promise<void> {
  const previousDefault = input.getDefaultWorkspaceId()
  const previouslyPending = input.journal?.isPending() ?? false
  let started = false
  let bindingsAttempted = false
  let memoryAttempted = false
  try {
    if (!input.validate()) throw new Error('切换目标已变化')
    input.journal?.begin()
    started = true
    await input.persistDefaultWorkspaceId(input.workspaceId)
    if (!input.validate() || input.getDefaultWorkspaceId() !== input.workspaceId) {
      throw new Error('切换期间项目或绑定已变化')
    }
    bindingsAttempted = true
    input.persistBindings()
    memoryAttempted = true
    input.commitMemory()
    input.journal?.complete()
  } catch {
    let requiresRepair = previouslyPending
    // 在任何补偿 await 前恢复内存，避免随后覆盖合法的会话/项目删除事件。
    if (memoryAttempted) {
      try { input.restoreMemory() } catch { requiresRepair = true }
    }
    if (bindingsAttempted) {
      try { input.restoreBindings() } catch { requiresRepair = true }
    }
    if (started) {
      try {
        const currentDefault = input.getDefaultWorkspaceId()
        if (currentDefault !== previousDefault) {
          // 不覆盖并发设置为第三个项目的用户操作。
          if (currentDefault !== input.workspaceId) requiresRepair = true
          else await input.persistDefaultWorkspaceId(previousDefault)
        }
        if (input.getDefaultWorkspaceId() !== previousDefault) requiresRepair = true
      } catch {
        requiresRepair = true
      }
      if (!requiresRepair) {
        try { input.journal?.complete() } catch { requiresRepair = true }
      }
    }
    throw new BridgeWorkspaceSwitchError(requiresRepair)
  }
}
