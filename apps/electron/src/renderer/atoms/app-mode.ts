/**
 * App Mode Atom - 应用模式状态
 *
 * - agent: Agent 模式（原 Flow）
 */

import { atom } from 'jotai'

export type AppMode = 'agent'

/** App 模式，自动持久化到 localStorage */
/** Chat 模式已移除入口：读取恒为 agent，写入被忽略（兼容忽略旧模式写入，磁盘历史不变）。 */
export const appModeAtom = atom<AppMode, [unknown], void>('agent', () => undefined)
