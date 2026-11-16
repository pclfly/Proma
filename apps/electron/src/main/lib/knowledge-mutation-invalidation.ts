/** 手动writer只使既有来源票据失效，不初始化broker、不读取正文、不创建来源事件。 */
let invalidator: ((physicalPath: string) => void) | undefined

export function setKnowledgeMutationInvalidator(next: ((physicalPath: string) => void) | undefined): void {
  invalidator = next
}

export function invalidateKnowledgeMutation(physicalPath: string): void {
  invalidator?.(physicalPath)
}
