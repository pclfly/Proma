import { describe, expect, test } from 'bun:test'
import {
  normalizeComputerUseAuthorization,
  normalizeComputerUseDriverPath,
} from './computer-use-settings'

describe('Computer Use 设置校验', () => {
  test('Given 合法的 cua-driver 绝对路径 When 归一化 Then 去引号并接受', () => {
    const path = process.platform === 'win32'
      ? '  \"C:\\\\Tools\\\\cua-driver.exe\"  '
      : '  "/opt/cua/cua-driver"  '
    expect(normalizeComputerUseDriverPath(path)).toBe(
      process.platform === 'win32' ? 'C:\\Tools\\cua-driver.exe' : '/opt/cua/cua-driver',
    )
  })

  test('Given 相对路径、错误文件名或换行 When 归一化 Then 拒绝', () => {
    const wrong = process.platform === 'win32' ? 'C:\\\\Tools\\\\other.exe' : '/opt/cua/other'
    expect(normalizeComputerUseDriverPath(wrong)).toBeUndefined()
    expect(normalizeComputerUseDriverPath('relative/cua-driver.exe')).toBeUndefined()
    expect(normalizeComputerUseDriverPath('C:\\\\Tools\\\\cua-driver.exe\\n')).toBeUndefined()
    expect(normalizeComputerUseDriverPath('')).toBeUndefined()
  })

  test('Given 授权状态 When 归一化 Then 只接受三种枚举', () => {
    expect(normalizeComputerUseAuthorization('unrequested')).toBe('unrequested')
    expect(normalizeComputerUseAuthorization('granted')).toBe('granted')
    expect(normalizeComputerUseAuthorization('denied')).toBe('denied')
    expect(normalizeComputerUseAuthorization('yes')).toBeUndefined()
    expect(normalizeComputerUseAuthorization(undefined)).toBeUndefined()
  })
})
