import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { writeTextFileAtomic } from './safe-file'
import { invalidateKnowledgeMutation } from './knowledge-mutation-invalidation'

interface KnowledgeFileWriteInput {
  allowedRoot: string
  filePath: string
  content: string
  expectedContent?: string
  maxBytes: number
  /** 外置授权调用者保留逻辑别名/权限快照的提交前复验；默认调用行为不变。 */
  validateAccess?: () => void
}

interface FileIdentity {
  dev: number
  ino: number
}

interface ResolvedKnowledgeTarget {
  rootPath: string
  rootIdentity: FileIdentity
  targetPath: string
  targetIdentity: FileIdentity | null
  /** 新建多级目录前记录最近存在祖先，创建后记录真实父目录。 */
  parentPath: string
  parentIdentity: FileIdentity
  size: number
}

const CONCURRENT_UPDATE_MESSAGE = '文件已被外部更新。请刷新后再处理你的修改。'

function assertWithinRoot(root: string, target: string, allowRoot = false): void {
  const rel = relative(root, target)
  if ((!allowRoot && rel === '') || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('非法路径：禁止通过知识文件链接访问授权目录外')
  }
}

function tryLstat(filePath: string): Stats | null {
  try { return lstatSync(filePath) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

function sameIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left === null || right === null
    ? left === right
    : left.dev === right.dev && left.ino === right.ino
}

/** 只解析调用者已经授权的根；不将外置链接或链接根自动升级为新授权。 */
function resolveKnowledgeTarget(input: KnowledgeFileWriteInput): ResolvedKnowledgeTarget {
  const logicalRoot = resolve(input.allowedRoot)
  const logicalTarget = resolve(input.filePath)
  assertWithinRoot(logicalRoot, logicalTarget)
  const rootStat = lstatSync(logicalRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('知识文件授权根必须是普通目录')
  const rootPath = realpathSync(logicalRoot)

  // lstat 能识别断链；不能用 existsSync 把断链当作尚未创建的普通文件。
  let probe = logicalTarget
  const missing: string[] = []
  let probeStat = tryLstat(probe)
  while (!probeStat) {
    missing.unshift(basename(probe))
    probe = dirname(probe)
    assertWithinRoot(logicalRoot, probe, true)
    probeStat = tryLstat(probe)
  }
  // 断链、循环链接在这里显式失败，禁止覆盖链接本身来“修好”路径。
  const realProbe = realpathSync(probe)
  assertWithinRoot(rootPath, realProbe, true)
  const actualProbe = statSync(realProbe)
  if (missing.length > 0 && !actualProbe.isDirectory()) throw new Error('知识文件父路径不是目录')
  if (missing.length === 0 && !actualProbe.isFile()) throw new Error('知识文件目标不是普通文件')
  const targetPath = resolve(realProbe, ...missing)
  assertWithinRoot(rootPath, targetPath)
  const parentPath = missing.length > 0 ? realProbe : dirname(realProbe)
  const parentStat = statSync(parentPath)
  return {
    rootPath,
    rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
    targetPath,
    targetIdentity: missing.length === 0 ? { dev: actualProbe.dev, ino: actualProbe.ino } : null,
    parentPath,
    parentIdentity: { dev: parentStat.dev, ino: parentStat.ino },
    size: missing.length === 0 ? actualProbe.size : 0,
  }
}

function readCurrentContent(target: ResolvedKnowledgeTarget, maxBytes: number): string {
  if (target.size > maxBytes) throw new Error('知识文件过大，无法安全核验并保存')
  return target.targetIdentity ? readFileSync(target.targetPath, 'utf8') : ''
}

/**
 * 知识文件在已授权的真实目标同目录原子保存，保留逻辑路径上的文件/目录链接。
 * 提交前重新核验路径、文件身份和内容，防止准备期间的重定向或外部更新。
 * 这是应用级乐观并发保护，不宣称跨平台路径API能隔离恶意进程的所有文件系统竞态。
 */
export function writeKnowledgeFileAtomic(input: KnowledgeFileWriteInput): void {
  if (Buffer.byteLength(input.content, 'utf8') > input.maxBytes) throw new Error('知识文件内容过大，无法安全保存')
  input.validateAccess?.()
  const initial = resolveKnowledgeTarget(input)
  mkdirSync(dirname(initial.targetPath), { recursive: true })
  input.validateAccess?.()
  const target = resolveKnowledgeTarget(input)
  // 创建子目录不能把已被同路径替换的祖先当作新的可信基线。
  const initialParentNow = statSync(initial.parentPath)
  if (relative(initial.targetPath, target.targetPath) !== ''
    || relative(initial.parentPath, realpathSync(initial.parentPath)) !== ''
    || !sameIdentity(initial.parentIdentity, initialParentNow)
    || !sameIdentity(initial.rootIdentity, target.rootIdentity)) {
    throw new Error('知识文件路径已变化，请刷新后重试')
  }
  const originalContent = readCurrentContent(target, input.maxBytes)
  if (input.expectedContent !== undefined && originalContent !== input.expectedContent) throw new Error(CONCURRENT_UPDATE_MESSAGE)

  writeTextFileAtomic(target.targetPath, input.content, {
    beforeCommit: () => {
      input.validateAccess?.()
      let current: ResolvedKnowledgeTarget
      try { current = resolveKnowledgeTarget(input) } catch (cause) {
        throw new Error('知识文件路径已变化，请刷新后重试', { cause })
      }
      if (relative(current.rootPath, target.rootPath) !== ''
        || relative(current.targetPath, target.targetPath) !== ''
        || !sameIdentity(current.rootIdentity, target.rootIdentity)
        || relative(current.parentPath, target.parentPath) !== ''
        || !sameIdentity(current.parentIdentity, target.parentIdentity)
        || !sameIdentity(current.targetIdentity, target.targetIdentity)) {
        throw new Error('知识文件路径已变化，请刷新后重试')
      }
      if (readCurrentContent(current, input.maxBytes) !== originalContent) throw new Error(CONCURRENT_UPDATE_MESSAGE)
      invalidateKnowledgeMutation(current.targetPath)
    },
  })
}
