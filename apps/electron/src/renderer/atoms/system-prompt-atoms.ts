/**
 * System Prompt Atoms - 系统提示词状态管理
 *
 * 保留可复用提示词资料库配置，不自动注入Agent或改写项目指令：
 * - 提示词列表和配置
 * - 当前选中的提示词
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { BUILTIN_DEFAULT_ID, BUILTIN_DEFAULT_PROMPT } from '@proma/shared'
import type { SystemPromptConfig, SystemPrompt } from '@proma/shared'


/** 完整提示词配置（从主进程加载） */
export const promptConfigAtom = atom<SystemPromptConfig>({
  prompts: [BUILTIN_DEFAULT_PROMPT],
  defaultPromptId: BUILTIN_DEFAULT_ID,
  appendDateTimeAndUserName: true,
})

/** 当前选中的提示词 ID（持久化到 localStorage） */
export const selectedPromptIdAtom = atomWithStorage<string>(
  'proma-selected-system-prompt-id',
  BUILTIN_DEFAULT_ID
)

/** 提示词列表（派生只读） */
export const promptListAtom = atom<SystemPrompt[]>(
  (get) => get(promptConfigAtom).prompts
)

/** 默认提示词 ID（派生只读） */
export const defaultPromptIdAtom = atom<string | undefined>(
  (get) => get(promptConfigAtom).defaultPromptId
)
