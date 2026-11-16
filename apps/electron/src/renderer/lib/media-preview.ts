/**
 * 可内联播放的媒体类型判定。
 *
 * 与主进程 `local-media-response.ts` 支持的 MIME 保持一致；
 * 预览面板与消息 Markdown 共用同一份扩展名集合。
 */

export type InlineMediaKind = 'video' | 'audio'

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac'])

function getExtension(filePath: string): string {
  const clean = filePath.split(/[?#]/, 1)[0] ?? filePath
  const match = clean.match(/\.([A-Za-z0-9]+)$/)
  return match?.[1]?.toLowerCase() ?? ''
}

/** 返回内联播放的媒体类型；非媒体文件返回 null。 */
export function getInlineMediaKind(filePath: string): InlineMediaKind | null {
  const ext = getExtension(filePath)
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return null
}

/** 是否为可内联播放的音视频路径。 */
export function isInlineMediaPath(filePath: string): boolean {
  return getInlineMediaKind(filePath) !== null
}
