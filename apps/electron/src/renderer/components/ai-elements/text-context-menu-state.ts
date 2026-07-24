export interface EditableTextMenuStateInput {
  editable: boolean
  hasSelection: boolean
  canUndo: boolean
  canRedo: boolean
  clipboardReadSupported: boolean
}

export interface EditableTextMenuState {
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
}

export function resolveEditableTextMenuState(input: EditableTextMenuStateInput): EditableTextMenuState {
  return {
    canUndo: input.editable && input.canUndo,
    canRedo: input.editable && input.canRedo,
    canCut: input.editable && input.hasSelection,
    canCopy: input.hasSelection,
    canPaste: input.editable && input.clipboardReadSupported,
  }
}

export function hasCopyableSelection(selectedText: string): boolean {
  return selectedText.length > 0
}
