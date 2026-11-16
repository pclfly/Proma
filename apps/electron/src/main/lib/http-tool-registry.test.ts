import { describe, expect, mock, test } from 'bun:test'
import type { ChatToolsFileConfig } from '@proma/shared'

const fixture: ChatToolsFileConfig = {
  toolStates: { 'legacy-agent-recommend': { enabled: true }, query: { enabled: true }, incomplete: { enabled: false } },
  toolCredentials: { legacy: { key: 'synthetic-retained-value' } },
  customTools: [
    { id: 'query', name: '查询资料', description: '合成工具，不执行网络请求', params: [], category: 'custom', executorType: 'http', httpConfig: { method: 'GET', urlTemplate: 'https://invalid.example/{{query}}' } },
    { id: 'incomplete', name: '未完成配置', description: '没有endpoint', params: [], category: 'custom', executorType: 'http' },
  ],
}
mock.module('./chat-tool-config', () => ({ getChatToolsConfig: () => fixture }))
const { getHttpToolInfos } = await import('./http-tool-registry')

describe('HTTP工具管理能力保留', () => {
  test('Given 旧内置开关和自定义工具 When 投影管理列表 Then 仅返回自定义资料和原开关', () => {
    expect(getHttpToolInfos().map(info => ({ id: info.meta.id, enabled: info.enabled, available: info.available }))).toEqual([
      { id: 'query', enabled: true, available: true },
      { id: 'incomplete', enabled: false, available: false },
    ])
  })
  test('Given 兼容凭据与工具定义 When 加载列表 Then 不修改配置或注册执行能力', () => {
    const before = JSON.stringify(fixture)
    getHttpToolInfos()
    expect(JSON.stringify(fixture)).toBe(before)
    expect(fixture.toolCredentials.legacy?.key).toBe('synthetic-retained-value')
  })
})
