import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { getDefaultReasoningProfileConfigData, resolveReasoningProfile, setReasoningProfileConfig } from '@proma/shared'
import { applyReasoningProfilesAtom, reasoningProfilesRevisionAtom } from './reasoning-profiles'

afterEach(() => setReasoningProfileConfig(null))

describe('推理配置保存后的 renderer 刷新', () => {
  test('Given 保存和广播返回相同列表 When 应用 Then 仅更新一次 revision', () => {
    const store = createStore()
    const defaults = getDefaultReasoningProfileConfigData()
    store.set(applyReasoningProfilesAtom, defaults)
    const revision = store.get(reasoningProfilesRevisionAtom)
    store.set(applyReasoningProfilesAtom, structuredClone(defaults))
    expect(store.get(reasoningProfilesRevisionAtom)).toBe(revision)
  })
  test('Given 配置已有默认规则 When 保存空列表 Then 清空 resolver 且使 capability 缓存失效', () => {
    const store = createStore()
    store.set(applyReasoningProfilesAtom, getDefaultReasoningProfileConfigData())
    const before = store.get(reasoningProfilesRevisionAtom)
    store.set(applyReasoningProfilesAtom, [])
    expect(store.get(reasoningProfilesRevisionAtom)).toBe(before + 1)
    expect(resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'anthropic-messages' })).toBeUndefined()
  })
})
