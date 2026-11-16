/**
 * 会话变更请求（GitHub PR）渲染层状态
 *
 * 只缓存主进程返回的公开状态；加载是异步的，侧栏首屏不等待 git/gh。
 * 状态变化由主进程推送（CHANGED），渲染层去抖后重新拉取。
 */

import { atom } from 'jotai'
import type { getDefaultStore } from 'jotai'
import type { ChangeRequestSessionState } from '@proma/shared'

/** 与 LeftSidebar 共用的默认 store 类型。 */
type JotaiStore = ReturnType<typeof getDefaultStore>

/** sessionId → 会话变更请求状态；没有绑定的会话不在 Map 中。 */
export const changeRequestStatesAtom = atom<ReadonlyMap<string, ChangeRequestSessionState>>(new Map())

/** 最近一次加载/刷新的错误；仅用于诊断，不阻塞侧栏。 */
export const changeRequestLoadErrorAtom = atom<string | null>(null)

const RELOAD_DEBOUNCE_MS = 200

let listInFlight: Promise<void> | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let subscriptionCount = 0

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 合并单个会话的新状态，避免整表重建导致的无关重渲染。 */
export function mergeChangeRequestStates(
  store: JotaiStore,
  sessions: readonly ChangeRequestSessionState[],
): void {
  if (sessions.length === 0) return
  const next = new Map(store.get(changeRequestStatesAtom))
  for (const session of sessions) next.set(session.sessionId, session)
  store.set(changeRequestStatesAtom, next)
}

/** 重新加载全部有绑定的会话；并发调用共享同一个请求。 */
export function loadChangeRequestStates(store: JotaiStore): Promise<void> {
  if (listInFlight) return listInFlight

  const promise = (async () => {
    try {
      const result = await window.electronAPI.listChangeRequests()
      const next = new Map<string, ChangeRequestSessionState>()
      for (const session of result.sessions) next.set(session.sessionId, session)
      store.set(changeRequestStatesAtom, next)
      store.set(changeRequestLoadErrorAtom, null)
    } catch (error) {
      store.set(changeRequestLoadErrorAtom, toErrorText(error))
    } finally {
      listInFlight = null
    }
  })()
  listInFlight = promise
  return promise
}

function scheduleReload(store: JotaiStore): void {
  if (reloadTimer !== null) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void loadChangeRequestStates(store)
  }, RELOAD_DEBOUNCE_MS)
}

/** 订阅主进程的状态变化推送；返回取消函数。 */
export function subscribeChangeRequests(store: JotaiStore): () => void {
  subscriptionCount += 1
  const dispose = window.electronAPI.onChangeRequestsChanged(() => {
    scheduleReload(store)
  })

  return () => {
    dispose()
    subscriptionCount = Math.max(0, subscriptionCount - 1)
    if (subscriptionCount === 0 && reloadTimer !== null) {
      clearTimeout(reloadTimer)
      reloadTimer = null
    }
  }
}

/** 手动刷新单个会话：主进程与后台轮询共享 in-flight，不排队。 */
export async function refreshSessionChangeRequests(
  store: JotaiStore,
  sessionId: string,
): Promise<void> {
  try {
    const result = await window.electronAPI.refreshChangeRequests(sessionId)
    mergeChangeRequestStates(store, [result.session])
    store.set(changeRequestLoadErrorAtom, result.error ?? null)
  } catch (error) {
    store.set(changeRequestLoadErrorAtom, toErrorText(error))
  }
}

/** 用系统浏览器打开 PR 链接；失败只记录日志，不影响侧栏。 */
export function openChangeRequest(url: string): void {
  void window.electronAPI.openExternal(url).catch((error) => {
    console.error('[变更请求] 打开链接失败:', error)
  })
}
