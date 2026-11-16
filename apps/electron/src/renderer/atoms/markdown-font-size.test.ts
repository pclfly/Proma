import { afterEach, describe, expect, test } from 'bun:test'
import type { AppSettings, MarkdownFontSize, ReadingSettingsChangedEvent } from '../../types'
import { initializeMarkdownFontSize, updateMarkdownFontSize } from './markdown-font-size'

const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
afterEach(() => {
  for (const [key, descriptor] of [['window', oldWindow], ['document', oldDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
function fixture() {
  let resolve!: (settings: AppSettings) => void
  let reject!: (error: Error) => void
  const settings = (value: Partial<AppSettings>): AppSettings => ({ themeMode: 'dark', productivityTools: { todosEnabled: true, calendarEnabled: true, obsidianEnabled: true }, ...value })
  const pending = new Promise<AppSettings>((yes, no) => { resolve = yes; reject = no })
  const listeners = new Set<(event: ReadingSettingsChangedEvent) => void>()
  const order: string[] = []; const applied: string[] = []; const states: MarkdownFontSize[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    getSettings: () => { order.push('read'); return pending },
    onReadingSettingsChanged: (callback: (event: ReadingSettingsChangedEvent) => void) => {
      order.push('subscribe'); listeners.add(callback); return () => { listeners.delete(callback) }
    },
    updateSettings: async () => ({}),
  } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: { style: { setProperty: (_name: string, value: string) => applied.push(value) } },
  } })
  const emit = (markdownFontSize: MarkdownFontSize) => listeners.forEach((listener) => listener({ markdownFontSize }))
  return { resolve: (value: Partial<AppSettings>) => resolve(settings(value)), reject, emit, listeners, order, applied, states, start: () => initializeMarkdownFontSize((size) => states.push(size)) }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('阅读字号初始化与实时同步', () => {
  for (const [size, px] of [['small', '13px'], ['medium', '15px'], ['large', '17px']] as const) {
    test(`Given ${size} When 初始化 Then atom与DOM同步且订阅先于读取`, async () => {
      const f = fixture(); const close = f.start(); f.resolve({ markdownFontSize: size }); await flush()
      expect(f.order).toEqual(['subscribe', 'read']); expect(f.states).toEqual([size]); expect(f.applied).toEqual([px]); close()
      expect(f.listeners.size).toBe(0)
    })
  }
  test('Given 初始化未返回 When 新广播先到 Then 迟到旧快照不能回退', async () => {
    const f = fixture(); const close = f.start(); f.emit('large'); f.resolve({ markdownFontSize: 'small' }); await flush()
    expect(f.states).toEqual(['large']); expect(f.applied).toEqual(['17px']); close()
  })
  test('Given 已卸载 When 旧读取或回调返回 Then 不再写atom与DOM', async () => {
    const f = fixture(); const close = f.start(); close(); f.emit('large'); f.resolve({ markdownFontSize: 'small' }); await flush()
    expect(f.states).toEqual([]); expect(f.applied).toEqual([]); close(); expect(f.listeners.size).toBe(0)
  })
  test('Given StrictMode重新挂载 When 旧effect卸载 Then 新订阅仍有效', async () => {
    const f = fixture(); const old = f.start(); old(); const close = f.start(); f.emit('large'); f.resolve({ markdownFontSize: 'small' }); await flush()
    expect(f.states).toEqual(['large']); expect(f.listeners.size).toBe(1); close()
  })
  test('Given 本地选择发生在读取期间 When 旧快照返回 Then 不覆写本地选择', async () => {
    const f = fixture(); const close = f.start(); await updateMarkdownFontSize('large'); f.resolve({ markdownFontSize: 'small' }); await flush()
    expect(f.states).toEqual([]); expect(f.applied).toEqual(['17px']); close()
  })
  test('Given 无字号或未知持久档位 When 初始化 Then 安全回退medium而非undefinedpx', async () => {
    const f = fixture(); const close = f.start(); f.resolve({ markdownFontSize: 'invalid' } as unknown as AppSettings); await flush()
    expect(f.states).toEqual(['medium']); expect(f.applied).toEqual(['15px']); close()
  })
  test('Given 已收到新广播 When 初始读取失败 Then 不回退到默认', async () => {
    const f = fixture(); const close = f.start(); f.emit('large'); f.reject(new Error('fixture')); await flush()
    expect(f.applied).toEqual(['17px']); expect(f.states).toEqual(['large']); close()
  })
  test('Given 初始读取失败且无更新 When 初始化 Then atom和DOM均回退默认', async () => {
    const f = fixture(); const close = f.start(); f.reject(new Error('fixture')); await flush()
    expect(f.states).toEqual(['medium']); expect(f.applied).toEqual(['15px']); close()
  })
})
