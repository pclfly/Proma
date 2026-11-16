import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeDownloadBody } from './download-body'

function responseOf(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream)
}

describe('下载响应体写入', () => {
  test('Given 分块响应 When 写入 Then 文件内容完整且进度递增', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-download-'))
    try {
      const file = join(dir, 'a.bin')
      const progress: number[] = []
      await writeDownloadBody(responseOf([new Uint8Array([1, 2]), new Uint8Array([3])]), file, {
        onProgress: (received) => progress.push(received),
      })
      expect([...readFileSync(file)]).toEqual([1, 2, 3])
      expect(progress).toEqual([2, 3])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 超过 maxBytes When 写入 Then 抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proma-download-'))
    try {
      await expect(writeDownloadBody(responseOf([new Uint8Array(10)]), join(dir, 'a.bin'), {
        maxBytes: 5,
      })).rejects.toThrow('大小上限')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Given 没有正文 When 写入 Then 抛错', async () => {
    const response = new Response(null)
    await expect(writeDownloadBody(response, 'x', {})).rejects.toThrow('没有正文')
  })
})
