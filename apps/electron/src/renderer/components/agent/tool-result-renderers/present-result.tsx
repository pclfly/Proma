/**
 * Present 工具结果渲染 — 本轮交付物卡。
 *
 * 官方 0.22.28：每轮结束时单独声明最终成品，点击直接打开预览或系统应用。
 * 文件路径复用 FilePathChip，以沿用其解析、授权与预览逻辑，避免另开绕过路径。
 */

import * as React from 'react'
import { Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { useMessageSessionId } from '@/components/ai-elements/message'
import { DefaultResultRenderer } from './default-result'

export interface PresentResultRendererProps {
  result: string
  isError: boolean
}

interface PresentedFile {
  path: string
  name?: string
  description?: string
}

function parsePresentedFiles(result: string): PresentedFile[] | null {
  try {
    const parsed: unknown = JSON.parse(result)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const files = (parsed as { files?: unknown }).files
    if (!Array.isArray(files)) return null
    const valid = files.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const candidate = item as { path?: unknown; name?: unknown; description?: unknown }
      if (typeof candidate.path !== 'string' || candidate.path.trim().length === 0) return []
      return [{
        path: candidate.path,
        ...(typeof candidate.name === 'string' && candidate.name.length > 0 && { name: candidate.name }),
        ...(typeof candidate.description === 'string' && candidate.description.length > 0 && { description: candidate.description }),
      }]
    })
    return valid.length > 0 ? valid : null
  } catch {
    return null
  }
}

export function PresentResultRenderer({ result, isError }: PresentResultRendererProps): React.ReactElement {
  const sessionId = useMessageSessionId()
  const files = React.useMemo(() => (isError ? null : parsePresentedFiles(result)), [isError, result])

  if (!files) return <DefaultResultRenderer result={result} isError={isError} />

  return (
    <div className={cn('my-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5')}>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
        <Package className="size-3.5" />
        <span>交付物</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {files.map((file) => (
          <li key={file.path} className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <FilePathChip filePath={file.path} sessionId={sessionId} />
            </div>
            {file.description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{file.description}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
