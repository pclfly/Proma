import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'ComputerUseSettings.tsx'), 'utf8').replaceAll(String.fromCharCode(13), '')

describe('Computer Use 设置页能力说明', () => {
  test('Given 设置页 When 阅读说明 Then 不再声称预览与采集统统未接入', () => {
    expect(source).not.toContain('原生屏幕采集、输入注入、OCR 与预览流尚未接入')
    expect(source).toContain('目标窗口画面镜像')
  })

  test('Given 授权开关 When 阅读描述 Then 说明它放开的是 Proma 自己的画面读取', () => {
    expect(source).toContain('只有「已授权自动控制」时，Proma 才会调用 Cua Driver 读取目标窗口画面')
  })

  test('Given 页面说明 When 阅读 Then 明确点击输入由 Agent 经 Cua 执行而不是 Proma 进程注入', () => {
    expect(source).toContain('桌面点击与输入由 Agent 通过 Cua Driver 的命令行工具执行')
  })
})
