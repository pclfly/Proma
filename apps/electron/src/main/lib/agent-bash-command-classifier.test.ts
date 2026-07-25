import { describe, expect, test } from 'bun:test'
import { isBashCommandReadOnly } from './agent-bash-command-classifier'

describe('Bash 命令只读分类', () => {
  test('Given 常见查询命令，When 分类，Then 保持只读', () => {
    expect(isBashCommandReadOnly('rg -n "TODO" src')).toBe(true)
    expect(isBashCommandReadOnly('git status --short')).toBe(true)
  })

  test('Given 多种脚本运行器，When 执行脚本，Then 视为可能写入', () => {
    for (const command of [
      'python update.py',
      'bash update.sh',
      'pwsh -File update.ps1',
      'powershell update.ps1',
      'bun update.ts',
      'deno update.ts',
      'tsx update.ts',
    ]) {
      expect(isBashCommandReadOnly(command)).toBe(false)
    }
  })

  test('Given PowerShell 写入 Cmdlet 或格式化参数，When 分类，Then 视为写入', () => {
    expect(isBashCommandReadOnly("Set-Content -Path data.txt -Value 'new'")).toBe(false)
    expect(isBashCommandReadOnly('prettier src/index.ts --write')).toBe(false)
  })
})
