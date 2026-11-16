import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rendererRoot = join(import.meta.dir, '..', '..')
const read = (relativePath: string): string =>
  readFileSync(join(rendererRoot, relativePath), 'utf8').replaceAll(String.fromCharCode(13), '')

describe('Computer Use 预览浮层接线', () => {
  test('Given 主界面 When 渲染 Then 挂载 ComputerUsePreviewOverlay', () => {
    const app = read('App.tsx')
    expect(app).toContain("import { ComputerUsePreviewOverlay } from './components/computer-use/ComputerUsePreviewOverlay'")
    expect(app).toContain('<ComputerUsePreviewOverlay />')
  })

  test('Given 浮层 When 操作 Then 消费预览/关闭/激活/重试接口', () => {
    const overlay = read('components/computer-use/ComputerUsePreviewOverlay.tsx')
    expect(overlay).toContain('getComputerUsePreview(sessionId, false)')
    expect(overlay).toContain('getComputerUsePreview(sessionId, true)')
    expect(overlay).toContain('dismissComputerUsePreview(sessionId, preview.id)')
    expect(overlay).toContain('activateComputerUsePreview(sessionId, preview.id)')
    expect(overlay).toContain('retryComputerUsePreview(sessionId, preview.id)')
    expect(overlay).toContain("value.startsWith('data:image/png;base64,')")
  })
})
