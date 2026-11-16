import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeWorkspaceSwitchError, commitBridgeWorkspaceSwitch, createBridgeWorkspaceSwitchJournal } from './bridge-workspace-switch'

interface SwitchState {
  defaultId: string | undefined
  diskBinding: string
  memoryBinding: string
  pending: boolean
}

function fixture(initialDefault: string | undefined = 'A') {
  const state: SwitchState = { defaultId: initialDefault, diskBinding: 'old', memoryBinding: 'old', pending: false }
  const calls: string[] = []
  const input = {
    workspaceId: 'B',
    getDefaultWorkspaceId: () => state.defaultId,
    persistDefaultWorkspaceId: (id: string | undefined): void | Promise<void> => { calls.push(`default:${id}`); state.defaultId = id },
    validate: () => true,
    persistBindings: () => { calls.push('bindings'); state.diskBinding = 'new' },
    restoreBindings: () => { calls.push('restore-bindings'); state.diskBinding = 'old' },
    commitMemory: () => { calls.push('memory'); state.memoryBinding = 'new' },
    restoreMemory: () => { calls.push('restore-memory'); state.memoryBinding = 'old' },
    journal: {
      isPending: () => state.pending,
      begin: () => { calls.push('begin'); state.pending = true },
      complete: () => { calls.push('complete'); state.pending = false },
    },
  }
  return { state, calls, input }
}

async function expectFailure(input: Parameters<typeof commitBridgeWorkspaceSwitch>[0], repair = false) {
  let failure: unknown
  try { await commitBridgeWorkspaceSwitch(input) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(BridgeWorkspaceSwitchError)
  expect((failure as BridgeWorkspaceSwitchError).requiresRepair).toBe(repair)
}

describe('桥接项目切换的补偿与重启门禁', () => {
  test('Given 延迟持久化 When 尚未完成 Then 不提交绑定或内存', async () => {
    const f = fixture()
    let resolve: () => void = () => { throw new Error('尚未开始') }
    f.input.persistDefaultWorkspaceId = async (id) => {
      await new Promise<void>((done) => { resolve = done })
      f.state.defaultId = id
    }
    const result = commitBridgeWorkspaceSwitch(f.input)
    await Promise.resolve()
    expect(f.state).toEqual({ defaultId: 'A', diskBinding: 'old', memoryBinding: 'old', pending: true })
    resolve()
    await result
    expect(f.state).toEqual({ defaultId: 'B', diskBinding: 'new', memoryBinding: 'new', pending: false })
    expect(f.calls).toEqual(['begin', 'bindings', 'memory', 'complete'])
  })

  for (const asynchronous of [false, true]) test(`Given ${asynchronous ? '异步' : '同步'}配置失败 When 切换 Then 原默认及两种绑定保持`, async () => {
    const f = fixture()
    f.input.persistDefaultWorkspaceId = asynchronous
      ? async () => { throw new Error('配置失败') }
      : () => { throw new Error('配置失败') }
    await expectFailure(f.input)
    expect(f.state).toEqual({ defaultId: 'A', diskBinding: 'old', memoryBinding: 'old', pending: false })
    expect(f.calls).toEqual(['begin', 'complete'])
  })

  for (const initial of ['A', undefined]) test(`Given 绑定写入失败及原默认${initial} When 补偿 Then 恢复原默认和绑定`, async () => {
    const f = fixture(initial)
    f.state.defaultId = initial
    // 覆盖可能在报错前改动持久化状态的存储实现。
    f.input.persistBindings = () => { f.state.diskBinding = 'broken'; throw new Error('绑定失败') }
    await expectFailure(f.input)
    expect(f.state).toEqual({ defaultId: initial, diskBinding: 'old', memoryBinding: 'old', pending: false })
  })

  test('Given 内存提交中断 When 补偿 Then 内存/磁盘/默认一并恢复', async () => {
    const f = fixture()
    f.input.commitMemory = () => { f.state.memoryBinding = 'broken'; throw new Error('内存提交失败') }
    await expectFailure(f.input)
    expect(f.state).toEqual({ defaultId: 'A', diskBinding: 'old', memoryBinding: 'old', pending: false })
  })

  test('Given await期间删除目标 When 校验失败 Then 不保存绑定并还原默认', async () => {
    const f = fixture()
    f.input.validate = () => f.state.defaultId === 'A'
    await expectFailure(f.input)
    expect(f.state.defaultId).toBe('A')
    expect(f.calls).not.toContain('bindings')
  })

  test('Given 并发用户改为C When 事务失败 Then 不用旧A覆盖C且保留修复门禁', async () => {
    const f = fixture()
    f.input.persistDefaultWorkspaceId = () => { f.state.defaultId = 'C' }
    await expectFailure(f.input, true)
    expect(f.state.defaultId).toBe('C')
    expect(f.state.pending).toBe(true)
    expect(f.state.memoryBinding).toBe('old')
  })

  test('Given 回滚默认也失败 When 事务失败 Then 保留pending阻止重启后自动派发', async () => {
    const f = fixture()
    f.input.persistDefaultWorkspaceId = (id) => { if (id === 'A') throw new Error('回滚失败'); f.state.defaultId = id }
    f.input.persistBindings = () => { throw new Error('绑定失败') }
    await expectFailure(f.input, true)
    expect(f.state.pending).toBe(true)
    expect(f.state.memoryBinding).toBe('old')
  })

  test('Given journal无法开始 When 切换 Then 不写配置或绑定', async () => {
    const f = fixture()
    f.input.journal.begin = () => { throw new Error('不可写') }
    await expectFailure(f.input)
    expect(f.calls).toEqual([])
    expect(f.state.defaultId).toBe('A')
  })

  test('Given 上次pending When 用户明确重新选择 Then 成功后解除门禁', async () => {
    const f = fixture()
    f.state.pending = true
    await commitBridgeWorkspaceSwitch(f.input)
    expect(f.state.pending).toBe(false)
    expect(f.state.defaultId).toBe('B')
  })

  test('Given 旧pending且再次修复失败 When 补偿完成 Then 不清除原重启门禁', async () => {
    const f = fixture()
    f.state.pending = true
    f.input.persistDefaultWorkspaceId = () => { throw new Error('仍不可写') }
    await expectFailure(f.input, true)
    expect(f.state.pending).toBe(true)
  })

  test('Given 真实JSON意图记录 When 重建实例或损坏 Then 只明确完成才可解除门禁', () => {
    const root = mkdtempSync(join(tmpdir(), 'proma-bridge-switch-'))
    const path = join(root, 'bindings.json')
    try {
      const journal = createBridgeWorkspaceSwitchJournal(path)
      expect(journal.isPending()).toBe(false)
      journal.begin()
      expect(createBridgeWorkspaceSwitchJournal(path).isPending()).toBe(true)
      journal.complete()
      expect(createBridgeWorkspaceSwitchJournal(path).isPending()).toBe(false)
      expect(JSON.parse(readFileSync(`${path}.workspace-switch.json`, 'utf-8'))).toEqual({ pending: false })
      writeFileSync(`${path}.workspace-switch.json`, '{broken')
      expect(journal.isPending()).toBe(true)
      writeFileSync(`${path}.workspace-switch.json`, '{"pending":"false"}')
      expect(journal.isPending()).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
