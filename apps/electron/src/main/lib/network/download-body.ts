/**
 * 下载响应体写入文件。
 *
 * 官方 0.22.0：统一处理流式写入、大小上限、进度回调和 abort 取消，
 * 避免各处下载逻辑重复实现且漏掉上限/取消。
 */

import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export interface WriteDownloadBodyOptions {
  signal?: AbortSignal
  /** 默认 1GB。 */
  maxBytes?: number
  onProgress?: (received: number) => void
}

export async function writeDownloadBody(
  response: Response,
  filePath: string,
  options: WriteDownloadBodyOptions,
): Promise<void> {
  if (!response.body) throw new Error('下载响应没有正文')
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => {})
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  let received = 0
  async function* chunks(): AsyncGenerator<Uint8Array> {
    while (true) {
      options.signal?.throwIfAborted()
      const { done, value } = await reader.read()
      options.signal?.throwIfAborted()
      if (done) return
      if (!value) continue
      received += value.byteLength
      if (received > (options.maxBytes ?? 1024 * 1024 * 1024)) {
        throw new Error('下载内容超过大小上限')
      }
      options.onProgress?.(received)
      yield value
    }
  }

  try {
    options.signal?.throwIfAborted()
    await pipeline(chunks(), createWriteStream(filePath), { signal: options.signal })
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
