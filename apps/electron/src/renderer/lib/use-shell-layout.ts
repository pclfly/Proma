import * as React from 'react'
import { resolveShellLayoutMode } from './layout-mode'

/** 监听窗口宽度并返回是否处于紧凑单栏；不写入任何持久化偏好。 */
export function useCompactShell(): boolean {
  const [compact, setCompact] = React.useState(() => resolveShellLayoutMode(window.innerWidth) === 'compact')

  React.useEffect(() => {
    const onResize = (): void => {
      setCompact(resolveShellLayoutMode(window.innerWidth) === 'compact')
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return compact
}
