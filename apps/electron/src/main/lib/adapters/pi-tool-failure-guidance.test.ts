import { describe, expect, test } from 'bun:test'
import { buildPiToolFailureGuidance } from './pi-tool-failure-guidance'

describe('Pi 工具失败纠偏', () => {
  test('Given MultiEdit 精确匹配失败 When 生成纠偏 Then 要求重读后重试且禁止整文件覆盖', () => {
    const guidance = buildPiToolFailureGuidance('edit', true, [{
      type: 'text',
      text: 'Could not find edits[1] in E:\\电商\\产品\\1688\\index.html. The oldText must match exactly.',
    }])

    expect(guidance).toContain('重新 Read')
    expect(guidance).toContain('不要因为精确匹配失败而用 Write 覆盖整个已有文件')
  })

  test('Given 缺失 CLAUDE.md When Read 返回 ENOENT Then 要求跳过而非继续猜测路径', () => {
    const guidance = buildPiToolFailureGuidance('read', true, [{
      type: 'text',
      text: "ENOENT: no such file or directory, access 'C:\\workspace\\CLAUDE.md'",
    }])

    expect(guidance).toContain('跳过即可')
    expect(guidance).toContain('不要继续尝试 cwd')
  })

  test('Given 重复锚点或普通缺失文件 When 失败 Then 引导安全定位而非绕过', () => {
    expect(buildPiToolFailureGuidance('edit', true, [{ type: 'text', text: 'Found 2 occurrences of edits[4] in file.ts. Each oldText must be unique.' }])).toContain('本次未写入')
    expect(buildPiToolFailureGuidance('read', true, [{ type: 'text', text: 'ENOENT: missing registry.test.ts' }])).toContain('先用 find')
  })

  test('Given 工具成功或其他错误 When 生成纠偏 Then 不追加无关提示', () => {
    expect(buildPiToolFailureGuidance('edit', false, [{ type: 'text', text: 'ok' }])).toBeUndefined()
    expect(buildPiToolFailureGuidance('read', true, [{ type: 'text', text: 'permission denied' }])).toBeUndefined()
  })

  test('Given Bash 把 cmd 语法当 bash 执行 When cd /d 报 too many arguments Then 指出改用 bash 语法', () => {
    const guidance = buildPiToolFailureGuidance('bash', true, [{
      type: 'text',
      text: '/usr/bin/bash: line 1: cd: too many arguments\nCommand exited with code 1',
    }])

    expect(guidance).toContain('cmd.exe 语法')
    expect(guidance).toContain('bash 语法')
    // 必须给出可直接照抄的两条替代写法
    expect(guidance).toContain('ls')
    // 不得把它说成「工具失败 / 环境异常」
    expect(guidance).not.toContain('环境异常')
  })

  test('Given 命令链某一步非零 When 输出 Command exited with code Then 说明是退出码而非环境故障', () => {
    const guidance = buildPiToolFailureGuidance('bash', true, [{
      type: 'text',
      text: '{\n  "name": "agent2api"\n}\n-----\nCommand exited with code 2',
    }])

    expect(guidance).toContain('非零退出码')
    expect(guidance).toContain('不是工具或环境故障')
    // 建议里给出「可选步骤不要串在 && 链上」这条可操作结论
    expect(guidance).toContain('&&')
  })

  test('Given PowerShell 里写 cmd 语法 When 报参数无法绑定 Then 指向 PowerShell 写法', () => {
    const guidance = buildPiToolFailureGuidance('powershell', true, [{
      type: 'text',
      text: "Get-ChildItem : A parameter cannot be found that matches parameter name 'b'.",
    }])

    expect(guidance).toContain('PowerShell')
    expect(guidance).toContain('Get-ChildItem')
  })

  test('Given 真·路径不存在 When Bash 非零退出 Then 不误判为语法错配', () => {
    const guidance = buildPiToolFailureGuidance('bash', true, [{
      type: 'text',
      text: "ls: cannot access 'src': No such file or directory\nCommand exited with code 2",
    }])

    // 命中「非零退出」这一类，但不能说成「你语法写错了」
    expect(guidance).toContain('非零退出码')
    expect(guidance).not.toContain('cmd.exe 语法')
  })

  test('Given shell 工具成功 When 退出码为 0 Then 不追加任何引导', () => {
    expect(buildPiToolFailureGuidance('bash', false, [{ type: 'text', text: 'ok' }])).toBeUndefined()
  })
})
