import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace } from '@proma/shared'
import { describeBridgeWorkspaceFailure, resolveBridgeWorkspace } from './bridge-workspace-resolution'

const workspace = (id: string, slug = id): AgentWorkspace => ({ id, slug, name: slug, createdAt: 1, updatedAt: 1 })
const existing = new Set(['w1', 'w2'])
const exists = (id: string): boolean => existing.has(id)

describe('IM 桥接项目解析', () => {
  test('Given bot默认与全局设置为空 When 只有一个项目 Then 自动采用该项目而不是空workspaceId', () => {
    const resolution = resolveBridgeWorkspace({ candidates: [undefined, undefined], exists, list: () => [workspace('w1')] })
    expect(resolution).toEqual({ ok: true, workspaceId: 'w1' })
  })

  test('Given 配置指向已删除项目 When 解析 Then 显式拒绝且不漂移到其他项目', () => {
    const resolution = resolveBridgeWorkspace({ candidates: ['deleted-id', 'w1'], exists, list: () => [workspace('w1')] })
    // 第一个非空候选失效即拒绝，避免把消息发到用户没选择的项目。
    expect(resolution).toEqual({ ok: false, reason: 'stale', configuredId: 'deleted-id' })
    expect(describeBridgeWorkspaceFailure(resolution as never)).toContain('已不存在')
  })

  test('Given 多个项目且未配置 When 解析 Then 要求用户显式选择而不是随便挑一个', () => {
    const resolution = resolveBridgeWorkspace({ candidates: ['', undefined], exists, list: () => [workspace('w1'), workspace('w2')] })
    expect(resolution).toEqual({ ok: false, reason: 'ambiguous' })
    expect(describeBridgeWorkspaceFailure(resolution as never)).toContain('/workspace')
  })

  test('Given 没有任何项目 When 解析 Then 提示先创建项目且不创建孤儿会话', () => {
    const resolution = resolveBridgeWorkspace({ candidates: [undefined], exists, list: () => [] })
    expect(resolution).toEqual({ ok: false, reason: 'missing' })
    expect(describeBridgeWorkspaceFailure(resolution as never)).toContain('创建项目')
  })

  test('Given 配置有效 When 解析 Then 直接采用配置值', () => {
    expect(resolveBridgeWorkspace({ candidates: [undefined, 'w2'], exists, list: () => [workspace('w1')] })).toEqual({ ok: true, workspaceId: 'w2' })
  })
})
