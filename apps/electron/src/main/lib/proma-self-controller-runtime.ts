/**
 * Proma 自操作的 CDP 传输层：串行队列、命令超时与可取消等待。
 *
 * 这里不包含任何界面语义；controller 只在这一层之上做 ref、保护与审批判定。
 */

import {
  PromaSelfAbortedError,
  PromaSelfTimeoutError,
  throwIfPromaSelfAborted,
  type PromaSelfSendCommand,
} from './proma-self-controller-types'

export interface PromaSelfCommandRuntimeOptions {
  sendCommand: PromaSelfSendCommand
  commandTimeoutMs: number
  pollIntervalMs: number
}

export function readPromaSelfRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export class PromaSelfCommandRuntime {
  private readonly options: PromaSelfCommandRuntimeOptions
  private queue: Promise<void> = Promise.resolve()

  constructor(options: PromaSelfCommandRuntimeOptions) {
    this.options = options
  }

  get pollIntervalMs(): number {
    return this.options.pollIntervalMs
  }

  /** 所有动作共享一条队列；signal 取消后排队动作不会再派发。 */
  run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    this.queue = previous.then(() => gate)
    return previous.then(async () => {
      try {
        throwIfPromaSelfAborted(signal)
        return await task()
      } finally {
        release()
      }
    })
  }

  send(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    throwIfPromaSelfAborted(signal)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const onAbort = () => finish(() => reject(new PromaSelfAbortedError()))
      timer = setTimeout(() => finish(() => reject(new PromaSelfTimeoutError(method))), this.options.commandTimeoutMs)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      Promise.resolve()
        .then(() => this.options.sendCommand(method, params))
        .then(
          (value) => finish(() => resolve(readPromaSelfRecord(value) ?? {})),
          (error: unknown) => finish(() => reject(error)),
        )
    })
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new PromaSelfAbortedError())
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new PromaSelfAbortedError())
      }
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
