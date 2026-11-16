import { describe, expect, test } from 'bun:test'
import { createChangesScrollController } from './changes-scroll-controller'

describe('Changes滚动恢复', () => {
  test('Given A滚动后立即卸载 When 返回A Then 最后位置已flush且程序恢复不覆盖', () => {
    let saved = 0, frame: (() => void) | undefined
    const element = { scrollTop: 0, scrollHeight: 2000, clientHeight: 300 }
    const controller = createChangesScrollController(element, () => saved, (top) => { saved = top }, (fn) => { frame = fn; return 1 }, () => {})
    controller.restore(true); frame!()
    controller.takeControl(); element.scrollTop = 700; controller.scroll(); controller.dispose()
    expect(saved).toBe(700)
    element.scrollTop = 0
    const restored = createChangesScrollController(element, () => saved, (top) => { saved = top }, (fn) => { frame = fn; return 2 }, () => {})
    restored.restore(true); restored.scroll(); frame!()
    expect(element.scrollTop).toBe(700)
    expect(saved).toBe(700)
    restored.dispose()
  })
  test('Given 高度不足产生clamp When 后续内容到齐 Then 恢复原位置', () => {
    let saved = 1200, frame: (() => void) | undefined
    const element = { scrollTop: 0, scrollHeight: 300, clientHeight: 300 }
    const controller = createChangesScrollController(element, () => saved, (top) => { saved = top }, (fn) => { frame = fn; return 1 }, () => {})
    controller.restore(true); element.scrollTop = 0; frame!(); controller.scroll()
    expect(saved).toBe(1200)
    element.scrollHeight = 2000; controller.restore(true); frame!()
    expect(element.scrollTop).toBe(1200)
    controller.dispose()
  })
})
