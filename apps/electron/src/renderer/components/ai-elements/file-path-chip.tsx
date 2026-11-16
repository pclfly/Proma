/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 支持绝对路径和相对路径（相对于 basePath 解析）。
 * 点击后按用户偏好（标签页 / 侧边分屏）打开文件预览。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  fileResolutionCacheKey,
  getFileName,
  getFilePathDisplayPath,
  isAbsoluteFilePath,
  isAsyncResultCurrent,
  isImageFilePath,
  isLocalFileReference,
  isRelativeFilePath,
  stripLineCol,
} from './file-path-chip-utils'

interface FileResolutionCacheEntry {
  exists: boolean
  resolvedPath?: string
}

/** 文件存在性缓存（模块级共享，避免重复 IPC）。key 包含会话授权上下文。 */
const fileExistsCache = new Map<string, FileResolutionCacheEntry>()
const fileResolutionRequests = new Map<string, Promise<FileResolutionCacheEntry>>()
const existsCacheKey = fileResolutionCacheKey

function resolveFilePathEntry(filePath: string, bases: string[], sessionId?: string): Promise<FileResolutionCacheEntry> {
  const key = existsCacheKey(filePath, bases, sessionId)
  const cached = fileExistsCache.get(key)
  if (cached) return Promise.resolve(cached)

  const inFlight = fileResolutionRequests.get(key)
  if (inFlight) return inFlight

  const promise = window.electronAPI.resolveFilePath(filePath, {
    sessionId,
    candidateBasePaths: bases.length > 0 ? bases : undefined,
  }).then((resolved) => {
    const entry: FileResolutionCacheEntry = {
      exists: resolved !== null,
      ...(resolved?.resolvedPath ? { resolvedPath: resolved.resolvedPath } : {}),
    }
    fileExistsCache.set(key, entry)
    return entry
  }).finally(() => {
    fileResolutionRequests.delete(key)
  })
  fileResolutionRequests.set(key, promise)
  return promise
}

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径（向后兼容，单值） */
  basePath?: string
  /** 多个候选基础目录（如主 cwd + 附加目录），点击时由主进程依次解析 */
  basePaths?: string[]
  /** 消息所属会话；嵌入子会话时不得回退为父会话的授权边界。 */
  sessionId?: string
  className?: string
}

/** 文件路径芯片 — 可点击，触发文件预览 */
export function FilePathChip({ filePath, basePath, basePaths, sessionId, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  const filename = getFileName(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const requestGenerationRef = React.useRef(0)
  const resolutionRequestRef = React.useRef<{ key: string; promise: Promise<void> } | null>(null)
  const mountedRef = React.useRef(true)
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'broken'>('idle')
  const [resolvedPath, setResolvedPath] = React.useState<string | undefined>()
  const store = useStore()
  const openPreview = useOpenPreview()

  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])

  const displayPath = React.useMemo(() => getFilePathDisplayPath({
    originalPath: trimmedPath,
    resolvedPath,
    lineColSuffix: resolvedPath ? lineColSuffix : '',
  }), [trimmedPath, resolvedPath, lineColSuffix])

  const getSessionId = React.useCallback(() => sessionId ?? store.get(currentAgentSessionIdAtom) ?? undefined, [sessionId, store])

  // 流式输出时父组件每帧都会重建 candidateBases 数组；解析 effect 必须只依赖
  // 内容稳定的 key，否则每帧都会把已解析状态重置回 idle，表现为文件 chip 闪烁。
  const resolutionKey = React.useMemo(
    () => existsCacheKey(cleanPath, candidateBases, sessionId ?? store.get(currentAgentSessionIdAtom) ?? undefined),
    [candidateBases, cleanPath, sessionId, store],
  )
  const resolutionArgsRef = React.useRef<{ cleanPath: string; candidateBases: string[]; sessionId?: string }>({
    cleanPath,
    candidateBases,
    sessionId,
  })
  resolutionArgsRef.current = {
    cleanPath,
    candidateBases,
    sessionId: sessionId ?? store.get(currentAgentSessionIdAtom) ?? undefined,
  }

  const resolveCurrentPath = React.useCallback((): Promise<void> => {
    const resolvedSessionId = getSessionId()
    const key = existsCacheKey(cleanPath, candidateBases, resolvedSessionId)
    const inFlight = resolutionRequestRef.current
    if (inFlight?.key === key) return inFlight.promise

    const generation = ++requestGenerationRef.current
    let promise: Promise<void>
    promise = resolveFilePathEntry(cleanPath, candidateBases, resolvedSessionId)
      .then((entry) => {
        if (!isAsyncResultCurrent(generation, requestGenerationRef.current, mountedRef.current)) return
        setFileStatus(entry.exists ? 'resolved' : 'broken')
        setResolvedPath(entry.resolvedPath)
      })
      .catch(() => { /* IPC 失败时保留当前状态 */ })
      .finally(() => {
        if (resolutionRequestRef.current?.promise === promise) {
          resolutionRequestRef.current = null
        }
      })
    resolutionRequestRef.current = { key, promise }
    return promise
  }, [cleanPath, candidateBases, getSessionId])

  // IntersectionObserver 首次懒检查可使用缓存；Tooltip 打开时会绕过缓存重新解析。
  // 只依赖内容稳定的 resolutionKey：父组件重建数组引用时不会重置已解析状态。
  React.useEffect(() => {
    const el = chipRef.current
    mountedRef.current = true
    const generation = ++requestGenerationRef.current
    const { cleanPath: path, candidateBases: bases, sessionId: resolvedSessionId } = resolutionArgsRef.current
    const key = existsCacheKey(path, bases, resolvedSessionId)

    const applyEntry = (entry: FileResolutionCacheEntry): void => {
      if (!isAsyncResultCurrent(generation, requestGenerationRef.current, mountedRef.current)) return
      setFileStatus(entry.exists ? 'resolved' : 'broken')
      setResolvedPath(entry.resolvedPath)
    }

    const cached = fileExistsCache.get(key)
    if (cached) {
      applyEntry(cached)
      return () => {
        mountedRef.current = false
        requestGenerationRef.current += 1
      }
    }

    const beginResolve = (): void => {
      void resolveFilePathEntry(path, bases, resolvedSessionId)
        .then(applyEntry)
        .catch(() => { /* IPC 失败时保留当前状态 */ })
    }

    if (!el || typeof IntersectionObserver === 'undefined') {
      beginResolve()
      return () => {
        mountedRef.current = false
        requestGenerationRef.current += 1
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        beginResolve()
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      observer.disconnect()
    }
  }, [resolutionKey])

  const handleTooltipOpenChange = React.useCallback((open: boolean) => {
    if (open) void resolveCurrentPath()
  }, [resolveCurrentPath])

  const handleClick = React.useCallback(() => {
    const resolvedSessionId = getSessionId()
    if (!resolvedSessionId) return
    // 优先用主进程解析出的绝对路径。用户主动点击即视为对该单文件的预览授权，
    // 主进程只放行这一个文件，不会因此把所在目录整体变成可预览根。
    // 即使此前解析失败（例如文件在会话授权根之外）也允许重试：点击本身就是授权行为。
    const targetPath = resolvedPath ?? cleanPath
    openPreview(resolvedSessionId, {
      filePath: targetPath,
      previewOnly: true,
      basePaths: candidateBases.length > 0 ? candidateBases : undefined,
      explicitPreviewFiles: [targetPath],
    })
  }, [getSessionId, openPreview, cleanPath, candidateBases, resolvedPath])

  const handleShowInFolder = React.useCallback(() => {
    const bases = candidateBases.length > 0 ? candidateBases : undefined
    window.electronAPI.showItemInFolder(cleanPath, bases)
      .then((ok) => { if (!ok) toast.error(`未找到文件：${filename}`) })
      .catch(() => toast.error(`未找到文件：${filename}`))
  }, [cleanPath, candidateBases, filename])

  return (
    <ContextMenu>
      <Tooltip onOpenChange={handleTooltipOpenChange}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              ref={chipRef}
              type="button"
              onClick={handleClick}
              className={cn(
                'inline-flex items-center gap-[0.25em] rounded px-[0.35em] py-[0.15em] text-[0.875em] font-medium leading-none',
                'cursor-pointer transition-colors duration-150',
                'align-baseline not-prose',
                fileStatus === 'broken'
                  ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground hover:opacity-70 hover:bg-muted/20'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
                className,
              )}
            >
              <FileTypeIcon name={filename} isDirectory={false} size={12} />
              <span className="truncate max-w-[240px] leading-none">{filename}{lineColSuffix}</span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all font-mono text-[11px]">
          {fileStatus === 'broken'
            ? `无法解析该路径（文件不存在或不在会话授权范围）: ${displayPath}`
            : displayPath}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-48 z-[9999]">
        <ContextMenuItem onClick={handleClick}>
          打开预览
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleShowInFolder}>
          在文件管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface ResolvableFilePathChipProps extends FilePathChipProps {
  /** 路径未通过主进程解析时显示的原始 Markdown 节点，避免制造不可用 Chip。 */
  fallback: React.ReactElement
}

/**
 * 用于模型自由文本中的路径候选。只有文件存在且位于当前会话授权范围内时才升级为 Chip；
 * 图片路径例外：即使解析不到也保留可点击形态，用户点击即视为对该单文件的预览授权。
 */
export function ResolvableFilePathChip({ fallback, filePath, basePath, basePaths, sessionId, className }: ResolvableFilePathChipProps): React.ReactElement {
  const store = useStore()
  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])
  const cleanPath = React.useMemo(() => stripLineCol(filePath.trim()).path, [filePath])
  const resolvedSessionId = sessionId ?? store.get(currentAgentSessionIdAtom) ?? undefined
  const resolutionKey = React.useMemo(
    () => existsCacheKey(cleanPath, candidateBases, resolvedSessionId),
    [candidateBases, cleanPath, resolvedSessionId],
  )
  const [resolvedKey, setResolvedKey] = React.useState<string | null>(null)
  // 解析参数放进 ref：effect 只跟随内容稳定的 key，避免流式重渲染反复回退到 fallback。
  const resolutionArgsRef = React.useRef({ cleanPath, candidateBases, resolvedSessionId })
  resolutionArgsRef.current = { cleanPath, candidateBases, resolvedSessionId }

  React.useEffect(() => {
    let cancelled = false
    const { cleanPath: path, candidateBases: bases, resolvedSessionId: sid } = resolutionArgsRef.current
    const cached = fileExistsCache.get(resolutionKey)
    if (cached) {
      if (cached.exists) setResolvedKey(resolutionKey)
      return () => { cancelled = true }
    }
    // 只在解析成功后升级；解析中/失败保持调用方的 Markdown 外观，且不清空旧结果。
    void resolveFilePathEntry(path, bases, sid)
      .then((entry) => {
        if (!cancelled && entry.exists) setResolvedKey(resolutionKey)
      })
      .catch(() => { /* 解析失败保留 fallback */ })
    return () => { cancelled = true }
  }, [resolutionKey])

  // 图片路径即使当前授权范围解析不到，也保留可点击形态：用户点击本身即视为
  // 对该单文件的预览授权，允许主动查看项目外的临时截图等文件。
  if (resolvedKey !== resolutionKey && !isImageFilePath(cleanPath)) return fallback
  return <FilePathChip filePath={filePath} basePath={basePath} basePaths={basePaths} sessionId={sessionId} className={className} />
}

export { isAbsoluteFilePath, isImageFilePath, isLocalFileReference, isRelativeFilePath }
