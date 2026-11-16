import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cn } from '../lib/utils'
const src = (...parts: string[]) => readFileSync(join(import.meta.dir, '..', '..', ...parts), 'utf8').replaceAll(String.fromCharCode(13), '')

describe('阅读设置与预览侧栏入口契约', () => {
  test('Given 真实记忆窗口正文class When 与MessageResponse合并 Then 不覆盖阅读字号', () => {
    const memory = src('renderer', 'components', 'agent-skills', 'WorkspaceMemoryWindowApp.tsx')
    const actualClass = memory.match(/<MessageResponse className="([^"]*)"/)?.[1]
    expect(actualClass).toBeDefined()
    expect(cn('prose text-[length:var(--md-preview-font-size,15px)]', actualClass)).toContain('--md-preview-font-size')
  })
  test('Given 输入代码块 When 核对真实pre与code配置 Then 跟阅读根缩放且不重复乘比例', () => {
    const input = src('renderer', 'components', 'ai-elements', 'rich-text-input.tsx')
    expect(input).toContain("class: 'rounded-md p-3 font-mono text-[0.933333em]'")
    expect(input).toContain('[&_pre_code]:text-[1em]')
  })
  test('Given 阅读事件 When 核对主进程与preload Then 异步和同步保存均广播且订阅有清理', () => {
    const ipc = src('main', 'ipc.ts'); const preload = src('preload', 'index.ts')
    expect(ipc.match(/broadcastReadingSettings\(BrowserWindow\.getAllWindows\(\), updates, result\)/g)?.length).toBe(2)
    expect(preload).toContain('onReadingSettingsChanged: (callback: (payload: ReadingSettingsChangedEvent) => void)')
    expect(preload).toContain('ipcRenderer.on(SETTINGS_IPC_CHANNELS.ON_READING_SETTINGS_CHANGED, listener)')
    expect(preload).toContain('ipcRenderer.removeListener(SETTINGS_IPC_CHANNELS.ON_READING_SETTINGS_CHANGED, listener)')
  })
  test('Given 独立阅读窗口 When 核对入口 Then 主窗/预览/记忆/QuickTask均挂字号初始化与清理', () => {
    const main = src('renderer', 'main.tsx')
    for (const app of ['QuickTaskApp', 'DetachedPreviewApp', 'WorkspaceMemoryWindowApp']) {
      expect(main).toContain(`<MarkdownFontSizeInitializer />\n        <FontSizeInitializer />\n        <${app} />`)
    }
    expect(main).toContain('useEffect(() => initializeMarkdownFontSize(setMarkdownFontSize), [setMarkdownFontSize])')
    expect(main.match(/<MarkdownFontSizeInitializer \/>/g)?.length).toBe(4)
  })
  test('Given 共享输入和Agent会话列表 When 核对阅读根字号 Then 不再固定13或15px且代码用相对字号', () => {
    const input = src('renderer', 'components', 'ai-elements', 'rich-text-input.tsx')
    const sidebar = src('renderer', 'components', 'app-shell', 'LeftSidebar.tsx')
    expect(input).toContain('min-h-[101px] w-full text-[length:var(--md-preview-font-size,15px)] leading-[1.6]')
    expect(input).toContain('[&_code]:text-[0.875em]')
    // Chat专属行已退役，只检查仍存在的Agent标题与重命名输入，不要求旧代码复活。
    expect(sidebar.match(/truncate text-\[length:var\(--md-preview-font-size,15px\)\] leading-\[1\.4\]/g)?.length).toBe(1)
    expect(sidebar.match(/bg-transparent text-\[length:var\(--md-preview-font-size,15px\)\] leading-\[1\.4\]/g)?.length).toBe(1)
  })
  test('Given 独立预览窗口 When 渲染工具栏 Then 挂载 TooltipProvider', () => {
    const detached = src('renderer', 'components', 'diff', 'DetachedPreviewApp.tsx')
    expect(detached).toContain("<TooltipProvider delayDuration={200} disableHoverableContent>")
    expect(detached).toContain('</TooltipProvider>')
  })
  test('Given 侧栏按钮/快捷键/布局拖动 When 核对所有使用点 Then 均消费有效状态而非直接覆盖临时状态', () => {
    for (const path of [['app-shell', 'LeftSidebar.tsx'], ['app-shell', 'AppShell.tsx'], ['shortcuts', 'GlobalShortcuts.tsx']]) {
      const code = src('renderer', 'components', ...path)
      expect(code).toContain("from '@/atoms/preview-sidebar-atoms'")
      expect(code).toContain('useAtom(effectiveSidebarCollapsedAtom)')
      expect(code).not.toContain('useAtom(sidebarCollapsedAtom)')
    }
  })
})
