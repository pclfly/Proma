/**
 * 连接启动代际控制。
 *
 * 官方 0.22.0：Bridge 重连/切换配置时，新的 start() 必须取消旧的启动过程；
 * 旧的 SDK import / WebSocket 握手 / 身份请求即使晚到，也不能再写入新连接状态。
 */

export function waitForConnection<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('连接启动已取消', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export interface ConnectionAttempt {
  isCurrent: () => boolean
  wait: <T>(operation: Promise<T>) => Promise<T>
}

export class ConnectionStartup {
  private current: AbortController | undefined

  begin(): ConnectionAttempt {
    this.cancel()
    const controller = new AbortController()
    this.current = controller
    return {
      isCurrent: () => this.current === controller && !controller.signal.aborted,
      wait: (operation) => waitForConnection(operation, controller.signal),
    }
  }

  cancel(): void {
    this.current?.abort()
    this.current = undefined
  }
}
