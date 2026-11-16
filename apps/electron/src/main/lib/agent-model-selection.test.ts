import { describe, expect, mock, test } from 'bun:test'
mock.module('./channel-manager', () => ({
  getChannelById: () => ({ id: 'fixture', enabled: true, models: [{ id: 'model-enabled', enabled: true }, { id: 'model-disabled', enabled: false }] }),
}))
const { assertEnabledModelForChannel } = await import('./agent-model-selection')

describe('显式模型选择契约', () => {
  test('Given 缺省模型 When 校验 Then 继承；空串不冒充默认', () => {
    expect(assertEnabledModelForChannel({ purpose: '测试' })).toBeUndefined()
    for (const modelId of ['', '   ']) expect(() => assertEnabledModelForChannel({ modelId, purpose: '测试' })).toThrow('不能为空')
  })
  test('Given 显式模型 When 校验 Then 只允许当前渠道启用项', () => {
    expect(assertEnabledModelForChannel({ modelId: ' model-enabled ', channelId: 'fixture', purpose: '测试' })).toBe('model-enabled')
    for (const modelId of ['model-disabled', 'unknown']) expect(() => assertEnabledModelForChannel({ modelId, channelId: 'fixture', purpose: '测试' })).toThrow('未启用')
  })
})
