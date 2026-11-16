/**
 * 订阅当前会话的每轮文件改动记录。
 *
 * 首次挂载/会话切换/刷新版本变化时拉取历史，之后由主进程结算推送增量。
 * 只做数据获取与合并，预览打开仍由调用方在用户点击时决定。
 */

import * as React from 'react'
import type { TurnChangesSnapshot } from '@proma/shared'
import { TURN_STREAM_DEFAULT_LIMIT } from '@/lib/turn-changes-view'

export interface TurnChangesData {
  turns: TurnChangesSnapshot[]
  loading: boolean
}

export function useTurnChanges(sessionId: string, refreshVersion?: number): TurnChangesData {
  const [turns, setTurns] = React.useState<TurnChangesSnapshot[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.electronAPI
      .getTurnChanges({ sessionId, limit: TURN_STREAM_DEFAULT_LIMIT })
      .then((result) => {
        if (cancelled) return
        setTurns(result.turns)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        console.warn('[连续改动流] 读取每轮文件改动失败:', error)
        setTurns([])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId, refreshVersion])

  React.useEffect(() => {
    // 主进程在轮次结算后推送快照；只合并当前会话，避免跨会话串流。
    return window.electronAPI.onTurnChangesChanged((payload) => {
      if (payload.sessionId !== sessionId) return
      setTurns((previous) => {
        const merged = previous
          .filter((turn) => turn.turnId !== payload.turn.turnId)
          .concat(payload.turn)
          .sort((left, right) => left.startedAt - right.startedAt)
        return merged.slice(-TURN_STREAM_DEFAULT_LIMIT)
      })
    })
  }, [sessionId])

  return { turns, loading }
}
