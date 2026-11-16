/** Agent 与自动化共用的渠道缓存和模型选择器状态。 */
import { atom } from 'jotai'
import type { Channel } from '@proma/shared'

export const channelsAtom = atom<Channel[]>([])
export const channelsLoadedAtom = atom(false)
export const modelSelectorOpenAtom = atom(false)
