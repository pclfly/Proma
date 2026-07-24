import * as React from 'react'
import type { Editor } from '@tiptap/react'
import {
  ClipboardPaste,
  Copy,
  Redo2,
  Scissors,
  TextSelect,
  Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { hasCopyableSelection, resolveEditableTextMenuState } from './text-context-menu-state'

interface SelectionRange {
  from: number
  to: number
}

interface TextContextMenuProps {
  children: React.ReactElement
}

interface EditableTextContextMenuProps extends TextContextMenuProps {
  editor: Editor | null
  disabled?: boolean
  onPasteText?: (text: string) => boolean
}

const MENU_ICON_CLASS = 'mr-2 size-4 text-muted-foreground'
const MENU_SHORTCUT_CLASS = 'tracking-normal'

function getShortcut(command: string): string {
  const primary = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '') ? '⌘' : 'Ctrl+'
  return `${primary}${command}`
}

function getRedoShortcut(): string {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '') ? '⌘⇧Z' : 'Ctrl+Y'
}

function isSelectionInside(root: HTMLElement, selection: Selection | null): boolean {
  if (!selection?.anchorNode || !selection.focusNode || selection.isCollapsed) return false
  return root.contains(selection.anchorNode) && root.contains(selection.focusNode)
}

export function ConversationTextContextMenu({ children }: TextContextMenuProps): React.ReactElement {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const selectedTextRef = React.useRef('')
  const [canCopy, setCanCopy] = React.useState(false)

  const captureSelection = React.useCallback((): void => {
    const selection = window.getSelection()
    const selectedText = rootRef.current && isSelectionInside(rootRef.current, selection)
      ? selection?.toString() ?? ''
      : ''
    selectedTextRef.current = selectedText
    setCanCopy(hasCopyableSelection(selectedText))
  }, [])

  const handleCopy = React.useCallback(async (): Promise<void> => {
    if (!hasCopyableSelection(selectedTextRef.current)) return
    try {
      await navigator.clipboard.writeText(selectedTextRef.current)
    } catch (error) {
      console.error('[文本右键菜单] 复制对话文本失败:', error)
      toast.error('复制失败')
    }
  }, [])

  const handleSelectAll = React.useCallback((): void => {
    const root = rootRef.current
    const selection = window.getSelection()
    if (!root || !selection) return

    const range = document.createRange()
    range.selectNodeContents(root)
    selection.removeAllRanges()
    selection.addRange(range)
    selectedTextRef.current = selection.toString()
    setCanCopy(hasCopyableSelection(selectedTextRef.current))
  }, [])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rootRef}
          className="relative flex min-h-0 flex-1 flex-col"
          onContextMenuCapture={captureSelection}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[9999] w-48">
        <ContextMenuItem disabled={!canCopy} onSelect={() => void handleCopy()}>
          <Copy className={MENU_ICON_CLASS} />
          复制
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('C')}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleSelectAll}>
          <TextSelect className={MENU_ICON_CLASS} />
          全选
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('A')}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function EditableTextContextMenu({
  children,
  editor,
  disabled = false,
  onPasteText,
}: EditableTextContextMenuProps): React.ReactElement {
  const selectionRef = React.useRef<SelectionRange>({ from: 0, to: 0 })
  const [menuState, setMenuState] = React.useState(() => resolveEditableTextMenuState({
    editable: false,
    hasSelection: false,
    canUndo: false,
    canRedo: false,
    clipboardReadSupported: false,
  }))

  const captureEditorState = React.useCallback((): void => {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    selectionRef.current = { from, to }
    setMenuState(resolveEditableTextMenuState({
      editable: editor.isEditable && !disabled,
      hasSelection: !empty,
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
      clipboardReadSupported: typeof navigator.clipboard?.readText === 'function',
    }))
  }, [disabled, editor])

  const restoreSelection = React.useCallback((): boolean => {
    if (!editor) return false
    const maxPosition = editor.state.doc.content.size
    const selection = {
      from: Math.min(selectionRef.current.from, maxPosition),
      to: Math.min(selectionRef.current.to, maxPosition),
    }
    selectionRef.current = selection
    return editor.chain().focus().setTextSelection(selection).run()
  }, [editor])

  const handleCopy = React.useCallback(async (): Promise<void> => {
    if (!editor || !restoreSelection()) return
    try {
      if (!document.execCommand('copy')) {
        const { from, to } = selectionRef.current
        await navigator.clipboard.writeText(editor.state.doc.textBetween(from, to, '\n'))
      }
    } catch (error) {
      console.error('[文本右键菜单] 复制输入内容失败:', error)
      toast.error('复制失败')
    }
  }, [editor, restoreSelection])

  const handleCut = React.useCallback(async (): Promise<void> => {
    if (!editor || !restoreSelection()) return
    try {
      if (!document.execCommand('cut')) {
        const { from, to } = selectionRef.current
        await navigator.clipboard.writeText(editor.state.doc.textBetween(from, to, '\n'))
        editor.chain().focus().setTextSelection(selectionRef.current).deleteSelection().run()
      }
    } catch (error) {
      console.error('[文本右键菜单] 剪切输入内容失败:', error)
      toast.error('剪切失败')
    }
  }, [editor, restoreSelection])

  const handlePaste = React.useCallback(async (): Promise<void> => {
    if (!editor || !restoreSelection()) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text || onPasteText?.(text)) return
      editor.chain().focus().setTextSelection(selectionRef.current).insertContent(text).run()
    } catch (error) {
      console.error('[文本右键菜单] 粘贴输入内容失败:', error)
      toast.error('读取剪贴板失败')
    }
  }, [editor, onPasteText, restoreSelection])

  const handleSelectAll = React.useCallback((): void => {
    editor?.chain().focus().selectAll().run()
  }, [editor])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div onContextMenuCapture={captureEditorState}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[9999] w-52">
        <ContextMenuItem
          disabled={!menuState.canUndo}
          onSelect={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 className={MENU_ICON_CLASS} />
          撤销
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('Z')}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!menuState.canRedo}
          onSelect={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 className={MENU_ICON_CLASS} />
          重做
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getRedoShortcut()}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!menuState.canCut} onSelect={() => void handleCut()}>
          <Scissors className={MENU_ICON_CLASS} />
          剪切
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('X')}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!menuState.canCopy} onSelect={() => void handleCopy()}>
          <Copy className={MENU_ICON_CLASS} />
          复制
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('C')}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem disabled={!menuState.canPaste} onSelect={() => void handlePaste()}>
          <ClipboardPaste className={MENU_ICON_CLASS} />
          粘贴
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('V')}</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!editor} onSelect={handleSelectAll}>
          <TextSelect className={MENU_ICON_CLASS} />
          全选
          <ContextMenuShortcut className={MENU_SHORTCUT_CLASS}>{getShortcut('A')}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
