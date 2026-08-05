import { describe, expect, test } from 'bun:test'
import { AUTO_UPDATE_ENABLED } from './updater-config'

describe('自动更新配置', () => {
  test('Given 当前版本策略 When 读取自动更新开关 Then 默认关闭自动更新', () => {
    expect(AUTO_UPDATE_ENABLED).toBe(false)
  })
})
