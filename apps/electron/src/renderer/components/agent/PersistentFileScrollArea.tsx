import * as React from 'react'
import { useStore } from 'jotai'
import { fileBrowserScrollTopMapAtom } from '@/atoms/agent-atoms'
import { createFileScrollController } from './file-scroll-controller'

interface PersistentFileScrollAreaProps {
  stateKey: string
  className: string
  children: React.ReactNode
  autoRevealTs?: number
}

/** Files 各布局共享的滚动宿主，不读取文件正文或写入磁盘配置。 */
export function PersistentFileScrollArea(props: PersistentFileScrollAreaProps): React.ReactElement {
  // 来源/session/root变化时替换真实DOM，旧cleanup不能读取已被新内容clamp的共享容器。
  return <FileScrollHost key={props.stateKey} {...props} />
}

function FileScrollHost({ stateKey, className, children, autoRevealTs = 0 }: PersistentFileScrollAreaProps): React.ReactElement {
  const store = useStore()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const revealRef = React.useRef(autoRevealTs)
  revealRef.current = autoRevealTs
  const takeControlRef = React.useRef<(() => void) | undefined>(undefined)

  React.useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const controller = createFileScrollController(container, store.get(fileBrowserScrollTopMapAtom).get(stateKey) ?? 0, top => {
      store.set(fileBrowserScrollTopMapAtom, previous => {
        if (previous.get(stateKey) === top) return previous
        const next = new Map(previous)
        next.set(stateKey, top)
        return next
      })
    })
    let frame: number | undefined
    let stopped = false
    let resize: ResizeObserver | undefined
    let mutation: MutationObserver | undefined
    const stopRestoring = (): void => {
      stopped = true
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      resize?.disconnect()
      mutation?.disconnect()
    }
    const takeControl = (): void => { controller.takeControl(); stopRestoring() }
    takeControlRef.current = takeControl
    const restore = (): void => {
      frame = undefined
      if (stopped) return
      // 初次成功不解除观察：异步刷新可能先缩短再回填，直到用户/搜索接管前保留目标。
      controller.restore()
    }
    const scheduleRestore = (): void => {
      if (!stopped && frame === undefined) frame = requestAnimationFrame(restore)
    }
    const handleScroll = (): void => { controller.scroll() }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) takeControl()
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    container.addEventListener('wheel', takeControl, { passive: true })
    container.addEventListener('touchstart', takeControl, { passive: true })
    container.addEventListener('pointerdown', takeControl, { passive: true })
    container.addEventListener('keydown', handleKeyDown)
    // Tab从宿主外进入时keydown不会冒泡到这里，focusin必须在浏览器滚动焦点前接管。
    container.addEventListener('focusin', takeControl)

    if (revealRef.current) takeControl()
    else {
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(scheduleRestore)
        resize.observe(container)
        if (contentRef.current) resize.observe(contentRef.current)
      }
      if (typeof MutationObserver !== 'undefined') {
        mutation = new MutationObserver(scheduleRestore)
        mutation.observe(container, { childList: true, subtree: true })
      }
      restore()
    }
    return () => {
      stopRestoring()
      takeControlRef.current = undefined
      container.removeEventListener('scroll', handleScroll)
      container.removeEventListener('wheel', takeControl)
      container.removeEventListener('touchstart', takeControl)
      container.removeEventListener('pointerdown', takeControl)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('focusin', takeControl)
      controller.dispose() // 旧stateKey的最后位置必须由自己的closure保存。
    }
  }, [stateKey, store])

  React.useLayoutEffect(() => {
    if (autoRevealTs) takeControlRef.current?.()
    // 搜索过期不重新夺回滚动权，用户/搜索决定的新位置继续被保存。
  }, [autoRevealTs])

  return <div ref={containerRef} className={className} data-file-scroll-key={stateKey}><div ref={contentRef} className="min-w-0">{children}</div></div>
}
