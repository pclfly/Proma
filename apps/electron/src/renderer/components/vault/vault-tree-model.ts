import type { VaultFileEntry, VaultTreeEntry } from '@proma/shared'

/** A fresh file tree intentionally reveals no nested folders. */
export function getInitialVaultExpandedFolders(): ReadonlySet<string> {
  return new Set()
}

export interface VaultFolderNode {
  name: string
  relativePath: string
  folders: Map<string, VaultFolderNode>
  files: VaultFileEntry[]
}

/** Builds the data model once per tree-entry change; rendering remains demand-driven. */
export function buildVaultTree(entries: VaultTreeEntry[]): VaultFolderNode {
  const root: VaultFolderNode = { name: '', relativePath: '', folders: new Map(), files: [] }

  const getOrCreateFolder = (relativePath: string): VaultFolderNode => {
    let parent = root
    let currentPath = ''
    for (const folderName of relativePath.split('/').filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${folderName}` : folderName
      let folder = parent.folders.get(folderName)
      if (!folder) {
        folder = { name: folderName, relativePath: currentPath, folders: new Map(), files: [] }
        parent.folders.set(folderName, folder)
      }
      parent = folder
    }
    return parent
  }

  for (const entry of entries) {
    if (entry.kind === 'folder') {
      getOrCreateFolder(entry.relativePath)
      continue
    }

    const separatorIndex = entry.relativePath.lastIndexOf('/')
    const parent = separatorIndex < 0 ? root : getOrCreateFolder(entry.relativePath.slice(0, separatorIndex))
    parent.files.push(entry)
  }

  return root
}

/** File contents, sizes, and timestamps do not change the visible tree. Reuse the existing
 * model for saves or refreshes that leave every entry kind, path, and label intact.
 */
export function hasSameVaultTreeEntries(current: VaultTreeEntry[], next: VaultTreeEntry[]): boolean {
  return current.length === next.length
    && current.every((entry, index) => (
      entry.kind === next[index]?.kind
      && entry.relativePath === next[index]?.relativePath
      && entry.name === next[index]?.name
    ))
}

export function getVaultFolderAncestors(relativePath: string): string[] {
  const folders = relativePath.split('/').filter(Boolean).slice(0, -1)
  const ancestors: string[] = []
  let currentPath = ''

  for (const folderName of folders) {
    currentPath = currentPath ? `${currentPath}/${folderName}` : folderName
    ancestors.push(currentPath)
  }

  return ancestors
}

/** 虚拟列表行：文件夹与文件共享同一行高，展开状态决定是否产出子行。 */
export type VaultTreeRow =
  | { kind: 'folder'; key: string; relativePath: string; name: string; depth: number; expanded: boolean }
  | { kind: 'file'; key: string; file: VaultFileEntry; depth: number }

export function getVaultFolderRowKey(relativePath: string): string {
  return `folder:${relativePath}`
}

export function getVaultFileRowKey(relativePath: string): string {
  return `file:${relativePath}`
}

function compareVaultNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

/**
 * 把树按当前展开集合展平为虚拟列表行。
 *
 * 只产出可见行，未展开文件夹的子项不再进入渲染列表；排序规则与旧递归渲染一致
 * （文件夹在前、文件名数字序），保证视觉顺序不变。
 */
export function flattenVaultTree(tree: VaultFolderNode, expandedFolders: ReadonlySet<string>): VaultTreeRow[] {
  const rows: VaultTreeRow[] = []

  const visit = (folder: VaultFolderNode, depth: number): void => {
    const childFolders = Array.from(folder.folders.values()).sort((left, right) => compareVaultNames(left.name, right.name))
    for (const child of childFolders) {
      const expanded = expandedFolders.has(child.relativePath)
      rows.push({
        kind: 'folder',
        key: getVaultFolderRowKey(child.relativePath),
        relativePath: child.relativePath,
        name: child.name,
        depth,
        expanded,
      })
      if (expanded) visit(child, depth + 1)
    }

    const files = folder.files.slice().sort((left, right) => compareVaultNames(left.name, right.name))
    for (const file of files) {
      rows.push({ kind: 'file', key: getVaultFileRowKey(file.relativePath), file, depth })
    }
  }

  visit(tree, 0)
  return rows
}

/** 按目录缓存增量构树：根层来自一次请求，子层只在用户展开后并入。 */
export function buildVaultTreeFromDirectories(
  rootEntries: readonly VaultTreeEntry[],
  childrenByDirectory: ReadonlyMap<string, readonly VaultTreeEntry[]>,
): VaultFolderNode {
  const root: VaultFolderNode = { name: '', relativePath: '', folders: new Map(), files: [] }

  const ensureFolder = (relativePath: string): VaultFolderNode => {
    let current = root
    let currentPath = ''
    for (const segment of relativePath.split('/').filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      let child = current.folders.get(segment)
      if (!child) {
        child = { name: segment, relativePath: currentPath, folders: new Map(), files: [] }
        current.folders.set(segment, child)
      }
      current = child
    }
    return current
  }

  const fileKeys = new WeakMap<VaultFolderNode, Set<string>>()
  const applyEntries = (target: VaultFolderNode, entries: readonly VaultTreeEntry[]): void => {
    let keys = fileKeys.get(target)
    if (!keys) { keys = new Set(); fileKeys.set(target, keys) }
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        if (target.folders.has(entry.name)) continue
        target.folders.set(entry.name, {
          name: entry.name,
          relativePath: entry.relativePath,
          folders: new Map(),
          files: [],
        })
        continue
      }
      if (keys.has(entry.relativePath)) continue
      keys.add(entry.relativePath)
      target.files.push(entry)
    }
  }

  applyEntries(root, rootEntries)
  for (const [directory, entries] of childrenByDirectory) {
    if (!directory) continue
    applyEntries(ensureFolder(directory), entries)
  }
  return root
}
