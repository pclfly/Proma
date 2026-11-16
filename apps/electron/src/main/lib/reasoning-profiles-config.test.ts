import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultReasoningProfileConfigData, normalizeReasoningLevel, resolveReasoningProfile, setReasoningProfileConfig } from '@proma/shared'
import { injectDeepSeekReasoningLevel } from './adapters/pi-deepseek-reasoning-request-settings'
import { getMergedReasoningProfiles, updateReasoningProfiles } from './reasoning-profiles-config'

const roots: string[] = []
function isolatedPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-reasoning-test-'))
  roots.push(root)
  return join(root, 'reasoning-profiles.json')
}
afterEach(() => {
  setReasoningProfileConfig(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('推理配置持久化', () => {
  test('Given 删除内置 profile When 保存并重新读取 Then 不再合并回来', () => {
    const path = isolatedPath()
    const remaining = getDefaultReasoningProfileConfigData().filter((p) => p.id !== 'glm-5.2')
    expect(updateReasoningProfiles(remaining, path)).toEqual(remaining)
    expect(getMergedReasoningProfiles(path)).toEqual(remaining)
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2)
  })
  test('Given 删除全部 When 保存空列表 Then 保持为空且可明确恢复默认', () => {
    const path = isolatedPath()
    expect(updateReasoningProfiles([], path)).toEqual([])
    expect(getMergedReasoningProfiles(path)).toEqual([])
    expect(updateReasoningProfiles(null, path)).toEqual(getDefaultReasoningProfileConfigData())
    expect(getMergedReasoningProfiles(path)).toEqual(getDefaultReasoningProfileConfigData())
  })
  test('Given v1 部分覆盖 When 加载 Then 保留旧版合并语义', () => {
    const path = isolatedPath()
    const defaults = getDefaultReasoningProfileConfigData()
    const override = { ...defaults[0]!, reasoning: false }
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [override] }))
    expect(getMergedReasoningProfiles(path)).toEqual(defaults.map((p) => p.id === override.id ? override : p))
  })
  test('Given v1 默认档位不在 levels When 迁移 Then 修复默认值但保留关闭设置', () => {
    const path = isolatedPath()
    const base = getDefaultReasoningProfileConfigData()[0]!
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [{ ...base, levels: ['off', 'high'], defaultLevel: 'max', reasoning: false }] }))
    const profile = getMergedReasoningProfiles(path).find((p) => p.id === base.id)!
    expect(profile.reasoning).toBe(false)
    expect(profile.defaultLevel).toBe('off')
  })
  test('Given v1 off:null When 迁移并发送 Then 仍然关闭而不是开启思考', () => {
    const path = isolatedPath()
    const profile = getDefaultReasoningProfileConfigData().find((p) => p.id === 'deepseek-v4-flash')!
    profile.levels = ['off', 'low']
    profile.defaultLevel = 'low'
    profile.encodings['anthropic-messages']!.effortMap = { off: null, low: 'low' }
    writeFileSync(path, JSON.stringify({ version: 1, profiles: [profile] }))
    const resolved = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages', profiles: getMergedReasoningProfiles(path) })!
    expect(normalizeReasoningLevel(resolved, 'off')).toBe('off')
    expect(injectDeepSeekReasoningLevel({ model: 'deepseek-v4-flash' }, { profile: resolved, thinkingLevel: 'off' })).toEqual({ model: 'deepseek-v4-flash', thinking: { type: 'disabled' } })
  })
  test('Given v1 曾保存旧内置匹配规则 When 迁移 Then 新别名生效且自定义字段保留', () => {
    const path = isolatedPath()
    const ids = ['openai-reasoning-astra', 'openai-reasoning-sol-luna', 'deepseek-flash', 'glm-5.3']
    const profiles = getDefaultReasoningProfileConfigData().filter((p) => ids.includes(p.id)).map((p) => ({
      ...p, reasoning: false, matchRules: [{ type: 'exact' as const, value: p.id }],
    }))
    writeFileSync(path, JSON.stringify({ version: 1, profiles }))
    const migrated = getMergedReasoningProfiles(path)
    for (const modelId of ['gpt-6-astra', 'gpt-6-sol', 'deepseek-flash-latest', 'glm-5.3-flashx']) {
      const result = resolveReasoningProfile({ modelId, transport: modelId.startsWith('gpt-') ? 'openai-responses' : 'anthropic-messages', profiles: migrated })
      expect(result).toBeDefined()
      expect(result?.reasoning).toBe(false)
    }
  })
  test('Given 重复 ID When 保存 Then 拒绝且不改写文件', () => {
    const path = isolatedPath()
    updateReasoningProfiles([], path)
    const original = readFileSync(path, 'utf8')
    const profile = getDefaultReasoningProfileConfigData()[0]!
    expect(() => updateReasoningProfiles([profile, profile], path)).toThrow('重复')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
})
