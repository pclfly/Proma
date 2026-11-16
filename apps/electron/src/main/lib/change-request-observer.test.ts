/**
 * 变更请求观察器测试
 *
 * 覆盖：PR 链接解析、gh pr create/view 输出解析、git push 输出解析与待处理命令索引。
 */

import { describe, expect, test } from 'bun:test'
import {
  PendingCommandTracker,
  commandFromToolInput,
  extractChangeRequestUrls,
  isPullRequestCreateCommand,
  isPullRequestReferenceCommand,
  isPushCommand,
  ownChangeRequestUrlFromOutput,
  pushedBranchesFromOutput,
  selectedChangeRequestUrls,
  textOfToolResult,
} from './change-request-observer'

describe('extractChangeRequestUrls', () => {
  test('Given 文本里混有 PR 链接与普通链接，When 解析，Then 只保留规范化的 PR 链接', () => {
    const text = [
      '已创建：https://github.com/acme/repo/pull/12,',
      '另见 https://github.com/acme/repo/issues/12 与 https://github.com/acme/repo/pull/12',
    ].join('\n')

    expect(extractChangeRequestUrls(text)).toEqual(['https://github.com/acme/repo/pull/12'])
  })

  test('Given 非 PR 路径，When 解析，Then 返回空数组', () => {
    expect(extractChangeRequestUrls('https://github.com/acme/repo/commit/abc')).toEqual([])
    expect(extractChangeRequestUrls('')).toEqual([])
  })
})

describe('ownChangeRequestUrlFromOutput', () => {
  test('Given gh 的纯文本输出，When 解析 url 行，Then 返回该 PR 链接', () => {
    const output = 'title: 修复登录\nstate: OPEN\nurl: https://github.com/acme/repo/pull/8\n'
    expect(ownChangeRequestUrlFromOutput(output)).toBe('https://github.com/acme/repo/pull/8')
  })

  test('Given gh 的 JSON 输出，When 解析 url 字段，Then 返回该 PR 链接', () => {
    expect(ownChangeRequestUrlFromOutput('{"number":9,"url":"https://github.com/acme/repo/pull/9"}'))
      .toBe('https://github.com/acme/repo/pull/9')
  })

  test('Given 输出里只有其它链接，When 解析，Then 不误取其它链接', () => {
    expect(ownChangeRequestUrlFromOutput('see https://github.com/acme/repo/pull/10')).toBeNull()
  })
})

describe('shell 命令识别', () => {
  test('Given git push 及 -C 前缀，When 判断，Then 只有 push 命中', () => {
    expect(isPushCommand('git push origin HEAD')).toBe(true)
    expect(isPushCommand('git -C /tmp/repo push origin feature/login')).toBe(true)
    expect(isPushCommand('git pushd origin HEAD')).toBe(false)
    expect(isPushCommand('git status')).toBe(false)
  })

  test('Given gh pr create 的前缀写法，When 判断，Then 能识别且不误判 pr list', () => {
    expect(isPullRequestCreateCommand('gh pr create --fill')).toBe(true)
    expect(isPullRequestCreateCommand('cd /tmp/repo && GH_TOKEN=x gh pr create --title "t"')).toBe(true)
    expect(isPullRequestCreateCommand('gh pr list --state open')).toBe(false)
  })

  test('Given gh pr view/edit/checkout，When 判断，Then 视为 PR 引用', () => {
    expect(isPullRequestReferenceCommand('gh pr view https://github.com/acme/repo/pull/1')).toBe(true)
    expect(isPullRequestReferenceCommand('gh pr edit 12 --title x')).toBe(true)
    expect(isPullRequestReferenceCommand('gh pr create --fill')).toBe(false)
  })

  test('Given --body 里带链接，When 提取显式链接，Then 跳过取值参数', () => {
    const command = 'gh pr view https://github.com/acme/repo/pull/3 --body "https://github.com/acme/repo/pull/4"'
    expect(selectedChangeRequestUrls(command)).toEqual(['https://github.com/acme/repo/pull/3'])
  })

  test('Given 非 PR 引用命令，When 提取链接，Then 返回空数组', () => {
    expect(selectedChangeRequestUrls('git push origin https://github.com/acme/repo/pull/3')).toEqual([])
  })
})

describe('pushedBranchesFromOutput', () => {
  test('Given 一次普通推送，When 解析，Then 得到远端与分支', () => {
    const output = [
      'To git@github.com:acme/repo.git',
      '   abc1234..def5678  feature/login -> feature/login',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'git@github.com:acme/repo.git', branch: 'feature/login' },
    ])
  })

  test('Given 删除分支与 tag 推送，When 解析，Then 全部忽略', () => {
    const output = [
      'To git@github.com:acme/repo.git',
      ' - [deleted]         feature/old',
      ' * [new tag]         v1.0.0 -> v1.0.0',
      '   abc1234..def5678  refs/tags/v2.0.0 -> refs/tags/v2.0.0',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([])
  })

  test('Given 多个远端连续推送，When 解析，Then 每个远端各自归属', () => {
    const output = [
      'To https://github.com/acme/one.git',
      '   abc1234..def5678  feature/login -> feature/login',
      'To https://github.com/acme/two.git',
      '   abc1234..def5678  refs/heads/feature/login -> refs/heads/feature/login',
    ].join('\n')

    expect(pushedBranchesFromOutput(output)).toEqual([
      { remote: 'https://github.com/acme/one.git', branch: 'feature/login' },
      { remote: 'https://github.com/acme/two.git', branch: 'feature/login' },
    ])
  })

  test('Given 没有 To 行，When 解析，Then 不猜测远端', () => {
    expect(pushedBranchesFromOutput('   abc..def  main -> main')).toEqual([])
  })
})

describe('工具结果与命令索引', () => {
  test('Given 内容块数组，When 取文本，Then 拼接文本块并忽略非文本', () => {
    expect(textOfToolResult([{ type: 'text', text: '第一行' }, { type: 'image' }, '第二行']))
      .toBe('第一行\n第二行')
  })

  test('Given 非字符串 command，When 读取入参，Then 返回 null', () => {
    expect(commandFromToolInput({ command: 'git push' })).toBe('git push')
    expect(commandFromToolInput({ command: 42 })).toBeNull()
    expect(commandFromToolInput(undefined)).toBeNull()
  })

  test('Given 超过上限的命令，When 记录，Then 丢弃最旧条目', () => {
    const tracker = new PendingCommandTracker(2)
    tracker.remember('tool-1', 'git push')
    tracker.remember('tool-2', 'gh pr create --fill')
    tracker.remember('tool-3', 'gh pr view 1')

    expect(tracker.size).toBe(2)
    expect(tracker.take('tool-1')).toBeNull()
    expect(tracker.take('tool-2')).toBe('gh pr create --fill')
    expect(tracker.take('tool-2')).toBeNull()
  })
})
