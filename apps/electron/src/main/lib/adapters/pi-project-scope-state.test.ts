import { describe, expect, test } from 'bun:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { copyProjectScopeState, createProjectScopeState } from './pi-project-scope-state'
import type { ScopeStorage } from './pi-project-scope-state'
const snapshot = (name: string) => ({ version: 1, projectRoot: process.cwd(), directories: [name] })

describe('作用域原子旁路记录', () => {
  test('Given 保存失败 When SDK树保持原样 Then 不存在未落盘父节点且新controller不能恢复失败快照', () => {
    const session = SessionManager.inMemory(process.cwd())
    const anchor = session.appendCustomEntry('fixture', {})
    const state = createProjectScopeState({ getBranch: () => session.getBranch(), getLeafId: () => session.getLeafId(), getSessionFile: () => 'synthetic.jsonl' }, {
      read: () => null,
      write: () => { throw new Error('EACCES') },
    })
    expect(() => state.save(snapshot('nested'))).toThrow('EACCES')
    expect(state.load()).toBeUndefined()
    expect(session.getLeafId()).toBe(anchor)
    expect(session.getBranch()).toHaveLength(1)
  })
  test('Given 存在但读取失败或schema损坏 When 加载 Then 不吞成没有状态', () => {
    const session = SessionManager.inMemory(process.cwd())
    session.appendCustomEntry('root', {})
    const manager = { getBranch: () => session.getBranch(), getLeafId: () => session.getLeafId(), getSessionFile: () => 'fixture.jsonl' }
    const broken = createProjectScopeState(manager, { read: () => { throw new Error('EACCES') }, write: () => {} })
    expect(() => broken.load()).toThrow('EACCES')
    const malformed = createProjectScopeState(manager, { read: () => ({ version: 1, records: [{ anchorId: 'test', snapshot: {} }] }), write: () => {} })
    expect(() => malformed.load()).toThrow('格式非法')
  })
  test('Given fork/rewind新artifact When 复制范围 Then 按新分支锚点过滤，写失败抛出阻止提交', () => {
    const session = SessionManager.inMemory(process.cwd())
    const root = session.appendCustomEntry('root', {})
    const a = session.appendCustomEntry('a', {})
    const files = new Map<string, unknown>()
    const storage: ScopeStorage = { read: (path) => files.get(path) ?? null, write: (path, value) => { files.set(path, structuredClone(value)) } }
    const manager = (file: string) => ({ getBranch: () => session.getBranch(), getLeafId: () => session.getLeafId(), getSessionFile: () => file })
    const source = createProjectScopeState(manager('source'), storage)
    source.save(snapshot('a'))
    session.branch(root)
    session.appendCustomEntry('b', {})
    source.save(snapshot('b'))
    session.branch(a)
    copyProjectScopeState('source', 'dest', session.getBranch().map((entry) => entry.id), storage)
    expect(createProjectScopeState(manager('dest'), storage).load()).toEqual(snapshot('a'))
    expect(JSON.stringify(files.get('dest.proma-project-scopes.json'))).not.toContain('"b"')
    expect(() => copyProjectScopeState('source', 'broken', [a], { ...storage, write: () => { throw new Error('EACCES') } })).toThrow('EACCES')
  })
  test('Given 分支A/B/压缩保留祖先 When 恢复 Then 只加载当前分支锚点', () => {
    const session = SessionManager.inMemory(process.cwd())
    const root = session.appendCustomEntry('root', {})
    const state = createProjectScopeState(session)
    const a = session.appendCustomEntry('a', {})
    state.save(snapshot('a'))
    session.branch(root)
    expect(state.load()).toBeUndefined()
    session.appendCustomEntry('b', {})
    state.save(snapshot('b'))
    expect(state.load()).toEqual(snapshot('b'))
    session.branch(a)
    expect(state.load()).toEqual(snapshot('a'))
  })
})
