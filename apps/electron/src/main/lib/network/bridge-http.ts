/**
 * Bridge SDK 的 axios fetch 适配器。
 *
 * 官方 0.22.0：统一走 bridgeFetch（系统网络），把 multipart 对象转换为
 * FormData，并把 responseType=stream 的 Web ReadableStream 转成 Node Readable。
 */

import axios, { type AxiosInstance } from 'axios'
import { Readable } from 'node:stream'
import { basename } from 'node:path'
import { bridgeFetch } from './bridge-network'
import type { SystemNetworkFetch } from './system-network-service'

export const MAX_TRANSFER_BYTES = 128 * 1024 * 1024

export function createBridgeHttp(fetcher: SystemNetworkFetch = bridgeFetch): AxiosInstance {
  const client = axios.create({
    adapter: 'fetch',
    env: { fetch: fetcher, FormData: globalThis.FormData },
    timeout: 120_000,
    maxBodyLength: MAX_TRANSFER_BYTES,
    maxContentLength: MAX_TRANSFER_BYTES,
  } as unknown as Parameters<typeof axios.create>[0])

  client.interceptors.request.use(async (config) => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.min(config.timeout || 120_000, 120_000)),
      ...(config.signal instanceof AbortSignal ? [config.signal] : []),
    ])
    config.signal = signal
    signal.throwIfAborted()

    if (
      String(config.headers.getContentType()).startsWith('multipart/form-data')
      && config.data
      && typeof config.data === 'object'
    ) {
      const form = new FormData()
      let total = 0
      for (const [key, value] of Object.entries(config.data as Record<string, unknown>)) {
        if (value instanceof Readable) {
          const chunks: Uint8Array[] = []
          const abort = (): void => {
            value.destroy(new Error('Bridge上传已取消或超时'))
          }
          signal.addEventListener('abort', abort, { once: true })
          try {
            for await (const chunk of value) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
              total += bytes.byteLength
              if (total > MAX_TRANSFER_BYTES) throw new Error('Bridge上传文件超过大小上限')
              chunks.push(new Uint8Array(bytes))
            }
          } finally {
            signal.removeEventListener('abort', abort)
            value.destroy()
          }
          const path = 'path' in value && typeof value.path === 'string' ? value.path : 'file'
          form.append(key, new Blob(chunks as unknown as BlobPart[]), basename(path))
        } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
          total += value.byteLength
          if (total > MAX_TRANSFER_BYTES) throw new Error('Bridge上传文件超过大小上限')
          form.append(key, new Blob([new Uint8Array(value)]), 'file')
        } else if (value instanceof Blob) {
          total += value.size
          if (total > MAX_TRANSFER_BYTES) throw new Error('Bridge上传文件超过大小上限')
          form.append(key, value)
        } else if (value !== undefined && value !== null) {
          total += Buffer.byteLength(String(value))
          if (total > MAX_TRANSFER_BYTES) throw new Error('Bridge上传文件超过大小上限')
          form.append(key, String(value))
        }
      }
      config.data = form
      config.headers.setContentType('multipart/form-data')
    }
    return config
  })

  client.interceptors.response.use(
    (response) => {
      if (response.config.responseType === 'stream' && response.data instanceof ReadableStream) {
        const body = response.data
        response.data = Readable.from(async function* () {
          const reader = body.getReader()
          try {
            while (true) {
              const next = await reader.read()
              if (next.done) return
              yield next.value
            }
          } finally {
            await reader.cancel().catch(() => undefined)
            reader.releaseLock()
          }
        }())
      }
      return response
    },
    (error: unknown) => {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined
      throw new Error(status ? `Bridge HTTP请求失败（${status}）` : 'Bridge网络请求失败或已取消')
    },
  )
  return client
}
