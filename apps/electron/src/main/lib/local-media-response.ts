/**
 * 本地媒体文件响应（Range 支持）。
 *
 * 官方 0.22.0：媒体预览不能整文件读取，否则大视频无法拖动进度；
 * 这里只处理单段 Range，HEAD/416/0 字节与官方一致。
 */

import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

/** 可内联预览的媒体类型；与官方 0.22.0 一致，不包含 PDF/图片。 */
export const MEDIA_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.flac': 'audio/flac',
}

export function getMediaMimeType(path: string): string | undefined {
  return MEDIA_MIME_TYPES[extname(path).toLowerCase()]
}

export type SingleByteRange = { start: number; end: number } | 'unsatisfiable' | null

/** 只支持单个 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`。 */
export function parseSingleByteRange(header: string | null, size: number): SingleByteRange {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (!rawStart && !rawEnd) return null
  if (size <= 0) return 'unsatisfiable'
  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffixLength), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/** 为媒体文件返回支持 Range 的响应；非媒体文件仍走 `net.fetch(file://)`。 */
export function createMediaFileResponse(target: string, request: Request): Response {
  const mimeType = getMediaMimeType(target)
  if (!mimeType) return new Response('Unsupported Media Type', { status: 415 })

  let size: number
  try {
    size = statSync(target).size
  } catch {
    return new Response('Not Found', { status: 404 })
  }

  const headers = new Headers({
    'content-type': mimeType,
    'accept-ranges': 'bytes',
    // 预览的是本地可变文件，命中缓存会让刷新后播放旧内容。
    'cache-control': 'no-cache',
  })
  const range = parseSingleByteRange(request.headers.get('range'), size)
  if (range === 'unsatisfiable') {
    headers.set('content-range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(0, size - 1)
  const status = range ? 206 : 200
  headers.set('content-length', String(size === 0 ? 0 : end - start + 1))
  if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`)

  if (size === 0 || request.method === 'HEAD') {
    return new Response(null, { status, headers })
  }

  const stream = createReadStream(target, { start, end })
  return new Response(
    Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    { status, headers },
  )
}
