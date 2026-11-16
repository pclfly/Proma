import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMediaFileResponse,
  getMediaMimeType,
  parseSingleByteRange,
} from './local-media-response'

const directory = mkdtempSync(join(tmpdir(), 'proma-media-test-'))
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

function mediaFile(name: string, content: string): string {
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

describe('媒体类型', () => {
  test('Given 常见音视频扩展名 When 查询 Then 返回官方 MIME', () => {
    expect(getMediaMimeType('a.MP4')).toBe('video/mp4')
    expect(getMediaMimeType('a.webm')).toBe('video/webm')
    expect(getMediaMimeType('a.mp3')).toBe('audio/mpeg')
    expect(getMediaMimeType('a.opus')).toBe('audio/ogg; codecs=opus')
    expect(getMediaMimeType('a.pdf')).toBeUndefined()
  })
})

describe('Range 解析', () => {
  test('Given 单段范围 When 解析 Then 返回闭区间', () => {
    expect(parseSingleByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 })
    expect(parseSingleByteRange('bytes=6-', 10)).toEqual({ start: 6, end: 9 })
    expect(parseSingleByteRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 })
    expect(parseSingleByteRange('bytes=8-99', 10)).toEqual({ start: 8, end: 9 })
  })

  test('Given 无范围或非法范围 When 解析 Then 忽略或标记不可满足', () => {
    expect(parseSingleByteRange(null, 10)).toBeNull()
    expect(parseSingleByteRange('items=0-1', 10)).toBeNull()
    expect(parseSingleByteRange('bytes=-', 10)).toBeNull()
    expect(parseSingleByteRange('bytes=10-', 10)).toBe('unsatisfiable')
    expect(parseSingleByteRange('bytes=5-4', 10)).toBe('unsatisfiable')
    expect(parseSingleByteRange('bytes=-0', 10)).toBe('unsatisfiable')
    expect(parseSingleByteRange('bytes=0-0', 0)).toBe('unsatisfiable')
  })
})

describe('媒体响应', () => {
  test('Given 完整请求 When 读取 Then 200 且支持 Range', async () => {
    const path = mediaFile('full.mp4', '0123456789')
    const response = createMediaFileResponse(path, new Request('proma-file://x/full.mp4'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-length')).toBe('10')
    expect(await response.text()).toBe('0123456789')
  })

  test('Given Range 请求 When 读取 Then 206 且只返回该区间', async () => {
    const path = mediaFile('range.mp4', '0123456789')
    const response = createMediaFileResponse(path, new Request('proma-file://x/range.mp4', {
      headers: { range: 'bytes=2-4' },
    }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(response.headers.get('content-length')).toBe('3')
    expect(await response.text()).toBe('234')
  })

  test('Given HEAD 请求 When 响应 Then 仅返回头部', async () => {
    const path = mediaFile('head.mp3', 'abc')
    const response = createMediaFileResponse(path, new Request('proma-file://x/head.mp3', {
      method: 'HEAD',
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('3')
    expect(await response.text()).toBe('')
  })

  test('Given 越界 Range When 响应 Then 416 与总长度', async () => {
    const path = mediaFile('bad.mp3', 'abc')
    const response = createMediaFileResponse(path, new Request('proma-file://x/bad.mp3', {
      headers: { range: 'bytes=5-' },
    }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */3')
  })

  test('Given 空文件 When 响应 Then 200 且长度 0', async () => {
    const path = mediaFile('empty.wav', '')
    const response = createMediaFileResponse(path, new Request('proma-file://x/empty.wav'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('0')
    expect(await response.text()).toBe('')
  })
})
