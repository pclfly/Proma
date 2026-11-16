import { describe, expect, test } from 'bun:test'
import { getInlineMediaKind, isInlineMediaPath } from './media-preview'

describe('内联媒体类型判定', () => {
  test.each([
    ['clip.mp4', 'video'],
    ['clip.MOV', 'video'],
    ['clip.webm', 'video'],
    ['voice.mp3', 'audio'],
    ['voice.wav', 'audio'],
    ['voice.flac', 'audio'],
    ['C:\\Users\\me\\Desktop\\video.mov', 'video'],
    ['/tmp/audio.m4a', 'audio'],
  ] as const)('Given %s When 判定 Then 返回 %s', (filePath, kind) => {
    expect(getInlineMediaKind(filePath)).toBe(kind)
    expect(isInlineMediaPath(filePath)).toBe(true)
  })

  test.each([
    'report.pdf',
    'image.png',
    'notes.md',
    'no-extension',
    'clip.mp4.txt',
  ])('Given 非媒体文件 %s When 判定 Then 返回 null', (filePath) => {
    expect(getInlineMediaKind(filePath)).toBeNull()
    expect(isInlineMediaPath(filePath)).toBe(false)
  })

  test('Given 带查询串的媒体 URL When 判定 Then 忽略查询串', () => {
    expect(getInlineMediaKind('proma-file://session/clip.mp4?range=1')).toBe('video')
  })
})
