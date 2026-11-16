import { describe, expect, test } from 'bun:test'
import { createPiSessionCleanup } from './pi-session-cleanup'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('Pi 会话幂等异步清理', () => {
  test('Given producer和dispatcher分别悬空 When 双入口清理 Then 两层完成后才释放且每步只执行一次', async () => {
    const producer = deferred()
    const dispatcher = deferred()
    const closingDispatcher = deferred()
    const steps: string[] = []
    const cleanup = createPiSessionCleanup({
      waitForProducer: async () => { steps.push('wait'); await producer.promise },
      dispose: () => { steps.push('dispose') },
      closeDispatcher: async () => { steps.push('dispatcher'); closingDispatcher.resolve(); await dispatcher.promise },
      release: () => { steps.push('release') },
    })
    const first = cleanup()
    expect(cleanup()).toBe(first)
    expect(steps).toEqual(['wait'])
    producer.resolve()
    await closingDispatcher.promise
    expect(steps).toEqual(['wait', 'dispose', 'dispatcher'])
    dispatcher.resolve()
    await first
    expect(steps).toEqual(['wait', 'dispose', 'dispatcher', 'release'])
  })

  test('Given producer失败 When 清理 Then 仍等待资源关闭并保留失败证据', async () => {
    const steps: string[] = []
    const cleanup = createPiSessionCleanup({
      waitForProducer: async () => { throw new Error('producer failed') },
      dispose: () => { steps.push('dispose') },
      closeDispatcher: async () => { steps.push('dispatcher') },
      release: () => { steps.push('release') },
    })
    await expect(cleanup()).rejects.toThrow('producer failed')
    expect(steps).toEqual(['dispose', 'dispatcher', 'release'])
  })
})
