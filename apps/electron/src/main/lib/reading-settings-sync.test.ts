import { describe, expect, test } from 'bun:test'
import { SETTINGS_IPC_CHANNELS } from '../../types'
import type { AppSettings } from '../../types'
const settings = (value: Partial<AppSettings>): AppSettings => ({ themeMode: 'dark', productivityTools: { todosEnabled: true, calendarEnabled: true, obsidianEnabled: true }, ...value })
import { broadcastReadingSettings, type ReadingSettingsTarget } from './reading-settings-sync'

function target(destroyed = false, contentsDestroyed = false, throws = false) {
  const sent: unknown[][] = []
  const win: ReadingSettingsTarget = {
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => contentsDestroyed, send: (...args: unknown[]) => { if (throws) throw new Error('fixture'); sent.push(args) } },
  }
  return { win, sent }
}
describe('阅读设置广播', () => {
  test('Given 字号已保存 When 广播 Then 所有存活窗口包括发起者收到权威结果', () => {
    const a = target(); const b = target()
    broadcastReadingSettings([a.win, b.win], { markdownFontSize: 'large' }, settings({ markdownFontSize: 'small' }))
    expect(a.sent).toEqual([[SETTINGS_IPC_CHANNELS.ON_READING_SETTINGS_CHANGED, { markdownFontSize: 'small' }]])
    expect(b.sent).toEqual(a.sent)
  })
  test('Given 非字号更新 When 广播 Then 不产生阅读事件', () => {
    const a = target(); broadcastReadingSettings([a.win], { themeMode: 'dark' }, settings({ markdownFontSize: 'large' })); expect(a.sent).toEqual([])
  })
  test('Given 已销毁或send失败的窗口 When 广播 Then 不阻断其它窗口', () => {
    const a = target(true); const b = target(false, true); const c = target(false, false, true); const d = target()
    expect(() => broadcastReadingSettings([a.win, b.win, c.win, d.win], { markdownFontSize: 'large' }, settings({ markdownFontSize: 'large' }))).not.toThrow()
    expect(a.sent).toEqual([]); expect(b.sent).toEqual([]); expect(d.sent.length).toBe(1)
  })
  test('Given 字号在结果中缺失 When 广播 Then 发送默认档位而不改变其它设置', () => {
    const a = target(); broadcastReadingSettings([a.win], { markdownFontSize: 'medium' }, settings({}))
    expect(a.sent).toEqual([[SETTINGS_IPC_CHANNELS.ON_READING_SETTINGS_CHANGED, { markdownFontSize: 'medium' }]])
  })
})
