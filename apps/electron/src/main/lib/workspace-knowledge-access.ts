import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export interface KnowledgeAccessFileSystem {
  lstat: (path: string) => Stats
  readlink: (path: string) => string
  realpath: (path: string) => string
}

export interface KnowledgeAccessPolicy {
  /** 已登记工作区（或显式项目根），必须是未改向的普通 canonical 目录。 */
  anchor: string
  /** memory/ 或工作区根；memory 子链接默认不能访问工作区的其他文件。 */
  logicalRoot: string
  authorizedDirectories: readonly string[]
  fileSystem?: KnowledgeAccessFileSystem
}

export type KnowledgeAccessFailure = 'invalid_path' | 'invalid_root' | 'unauthorized_link' | 'missing' | 'broken_link' | 'cycle' | 'not_directory' | 'unsupported'
export class KnowledgeAccessError extends Error {
  constructor(readonly code: KnowledgeAccessFailure, message: string) { super(message); this.name = 'KnowledgeAccessError' }
}

export interface KnowledgePathIdentity {
  path: string
  dev: number
  ino: number
  kind: 'directory' | 'file' | 'link'
}

export interface KnowledgePathResolution {
  logicalPath: string
  physicalPath: string
  allowedRoot: string
  kind: 'file' | 'directory' | 'missing'
  size: number
  modifiedAt?: number
  linked: boolean
  identities: KnowledgePathIdentity[]
  policyFingerprint: string
}

const defaultFileSystem: KnowledgeAccessFileSystem = { lstat: path => lstatSync(path), readlink: path => readlinkSync(path), realpath: path => realpathSync(path) }

/** Windows junction 的 readlink 可能返回 namespace 前缀；只归一化路径表示，不扩充权限。 */
export function normalizeKnowledgePath(value: string): string {
  let path = value
  if (process.platform === 'win32' && path.startsWith('\\\\?\\')) {
    path = path.startsWith('\\\\?\\UNC\\') ? `\\\\${path.slice(8)}` : path.slice(4)
  }
  return resolve(path)
}

export function knowledgePathKey(path: string): string {
  const normalized = normalizeKnowledgePath(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isWithinKnowledgeRoot(root: string, target: string, allowRoot = true): boolean {
  const rel = relative(normalizeKnowledgePath(root), normalizeKnowledgePath(target))
  return (allowRoot || rel !== '') && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function normalizeKnowledgeRelativePath(value: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.includes('\0') || /[:]/.test(value) || /^[\\/]/.test(value)) throw new KnowledgeAccessError('invalid_path', '非法知识文件相对路径')
  const normalized = value.replace(/\\/g, '/')
  if (normalized === '' && allowRoot) return ''
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || (process.platform === 'win32' && (/[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw new KnowledgeAccessError('invalid_path', '非法知识文件相对路径，禁止目录穿越或设备别名')
  }
  return normalized
}

/** 根与metadata parent复用同一不跨祖先链接的检查，不能各自退回完整路径lstat。 */
export function inspectCanonicalKnowledgeDirectory(value: string, io: KnowledgeAccessFileSystem = defaultFileSystem): Stats {
  const path = normalizeKnowledgePath(value)
  let current = parse(path).root
  let stat = io.lstat(current)
  for (const segment of relative(current, path).split(sep).filter(Boolean)) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new KnowledgeAccessError('invalid_root', '知识授权根的祖先已被链接改向')
    current = join(current, segment)
    stat = io.lstat(current)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || knowledgePathKey(io.realpath(path)) !== knowledgePathKey(path)) throw new KnowledgeAccessError('invalid_root', '知识授权根不是未改向的普通目录')
  return stat
}

function codeOf(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined }
function identity(path: string, stat: Stats): KnowledgePathIdentity {
  return { path, dev: stat.dev, ino: stat.ino, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : 'file' }
}

/**
 * 一处逐段、逐跳的知识访问策略。只读路径身份，不读正文、不迁移、不创建目录。
 * 每个链接先读取已授权的 link 本身，再证明下一跳受权，才访问其目标。
 */
export function resolveWorkspaceKnowledgePath(policy: KnowledgeAccessPolicy, relativePath: string, options: { allowRoot?: boolean; allowMissing?: boolean } = {}): KnowledgePathResolution {
  const io = policy.fileSystem ?? defaultFileSystem
  const anchor = normalizeKnowledgePath(policy.anchor)
  const logicalRoot = normalizeKnowledgePath(policy.logicalRoot)
  const rel = normalizeKnowledgeRelativePath(relativePath, options.allowRoot)
  if (!isWithinKnowledgeRoot(anchor, logicalRoot)) throw new KnowledgeAccessError('invalid_root', '知识逻辑根不在已登记根内')
  const identities = new Map<string, KnowledgePathIdentity>()
  const record = (path: string, stat: Stats): void => { identities.set(knowledgePathKey(path), identity(path, stat)) }
  const verifiedRoots = new Map<string, Stats>()
  const verifyCanonicalDirectory = (path: string): Stats => {
    const stat = inspectCanonicalKnowledgeDirectory(path, io)
    verifiedRoots.set(knowledgePathKey(path), stat)
    return stat
  }
  let anchorStat: Stats
  try { anchorStat = verifyCanonicalDirectory(anchor) } catch { throw new KnowledgeAccessError('invalid_root', '工作区知识根不可用或已被链接改向') }
  record(anchor, anchorStat)
  const grants: string[] = []
  const grantIdentities: string[] = []
  for (const directory of policy.authorizedDirectories) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) continue
    const grant = normalizeKnowledgePath(directory)
    try {
      const stat = verifyCanonicalDirectory(grant)
      grants.push(grant)
      grantIdentities.push(`${knowledgePathKey(grant)}:${stat.dev}:${stat.ino}`)
    } catch { /* 失效的历史授权不能自动跟随新的 realpath。 */ }
  }
  const roots = [...new Set([logicalRoot, ...grants])].sort((a, b) => b.length - a.length)
  const rootFor = (path: string): string | undefined => roots.find(root => isWithinKnowledgeRoot(root, path))
  const policyFingerprint = JSON.stringify([knowledgePathKey(anchor), knowledgePathKey(logicalRoot), [...policy.authorizedDirectories].sort(), grantIdentities.sort()])
  let linked = false
  let hops = 0

  interface Located { path: string; stat?: Stats; allowedRoot: string }
  const walk = (candidate: string, allowMissing: boolean, links: ReadonlySet<string>): Located => {
    const path = normalizeKnowledgePath(candidate)
    const allowedRoot = rootFor(path)
    if (!allowedRoot) throw new KnowledgeAccessError('unauthorized_link', '禁止通过知识文件链接访问授权目录外，请先显式授权外置目录')
    // 默认 memory 根从可信 workspace 逐段走起；不能把 memory 根 symlink 当授权凭据。
    const start = knowledgePathKey(allowedRoot) === knowledgePathKey(logicalRoot) ? anchor : allowedRoot
    let stat = verifiedRoots.get(knowledgePathKey(start)) ?? verifyCanonicalDirectory(start)
    record(start, stat)
    const parts = relative(start, path).split(sep).filter(Boolean)
    let current = start
    for (let index = 0; index < parts.length; index += 1) {
      if (!stat.isDirectory()) throw new KnowledgeAccessError('not_directory', '知识文件父路径不是目录')
      current = join(current, parts[index]!)
      try { stat = io.lstat(current) } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error
        if (!allowMissing) throw new KnowledgeAccessError('missing', '知识文件不存在')
        return { path: join(current, ...parts.slice(index + 1)), allowedRoot }
      }
      record(current, stat)
      if (stat.isSymbolicLink()) {
        linked = true
        const linkKey = knowledgePathKey(current)
        if (++hops > 64 || links.has(linkKey)) throw new KnowledgeAccessError('cycle', '知识文件链接存在循环或超过跳转上限')
        const nextLinks = new Set(links).add(linkKey)
        const destination = normalizeKnowledgePath(resolve(dirname(current), io.readlink(current)))
        // 此处不能先 realpath(destination)：未授权目标连 lstat 都不访问。
        if (!rootFor(destination)) throw new KnowledgeAccessError('unauthorized_link', '禁止通过知识文件链接访问授权目录外，请先显式授权外置目录')
        let base: Located
        try { base = walk(destination, false, nextLinks) } catch (error) {
          if (error instanceof KnowledgeAccessError && error.code === 'missing') throw new KnowledgeAccessError('broken_link', '知识文件链接已断裂，不能当作新文件覆盖')
          throw error
        }
        const remaining = parts.slice(index + 1)
        if (remaining.length === 0) return base
        if (!base.stat?.isDirectory()) throw new KnowledgeAccessError('not_directory', '知识文件链接的父目标不是目录')
        return walk(join(base.path, ...remaining), allowMissing, nextLinks)
      }
      if (!stat.isDirectory() && !stat.isFile()) throw new KnowledgeAccessError('unsupported', '知识路径不是普通文件或目录')
    }
    return { path: current, stat, allowedRoot: rootFor(current) ?? allowedRoot }
  }
  const logicalPath = join(logicalRoot, ...rel.split('/').filter(Boolean))
  const result = walk(logicalPath, options.allowMissing === true, new Set())
  return { logicalPath, physicalPath: result.path, allowedRoot: result.allowedRoot, kind: !result.stat ? 'missing' : result.stat.isDirectory() ? 'directory' : 'file', size: result.stat?.size ?? 0, modifiedAt: result.stat?.mtimeMs, linked, identities: [...identities.values()], policyFingerprint }
}

/** 创建父目录可新增身份，但既有根/祖先/link/目标的身份与授权不得在准备期间改变。 */
export function assertKnowledgeResolutionUnchanged(before: KnowledgePathResolution, after: KnowledgePathResolution): void {
  const current = new Map(after.identities.map(entry => [knowledgePathKey(entry.path), entry]))
  if (before.policyFingerprint !== after.policyFingerprint || knowledgePathKey(before.physicalPath) !== knowledgePathKey(after.physicalPath)
    || before.kind !== after.kind || before.identities.some(entry => { const found = current.get(knowledgePathKey(entry.path)); return !found || found.dev !== entry.dev || found.ino !== entry.ino || found.kind !== entry.kind })) {
    throw new Error('知识文件路径已变化或授权已撤销，请刷新后重试')
  }
}

/** 文件自己的inode允许随本次写入改变；来源边界只描述授权及父目录/link身份。 */
export function knowledgeResolutionBoundary(target: KnowledgePathResolution): string {
  return JSON.stringify([target.policyFingerprint, target.identities.filter(item => item.kind !== 'file').map(item => [knowledgePathKey(item.path), item.dev, item.ino, item.kind])])
}

/** 跨 read→save 的边界快照：授权指纹必须完全相等，已观察的目录/link 身份必须仍一致。 */
export interface KnowledgeBoundarySnapshot {
  policyFingerprint: string
  entries: Array<[string, number, number, string]>
}

export function captureKnowledgeBoundary(target: KnowledgePathResolution): KnowledgeBoundarySnapshot {
  return {
    policyFingerprint: target.policyFingerprint,
    entries: target.identities
      .filter(item => item.kind !== 'file')
      .map(item => [knowledgePathKey(item.path), item.dev, item.ino, item.kind] as [string, number, number, string]),
  }
}

/**
 * 受控保存自己新建的中间目录不在读取快照里，应允许出现；但任何已观察到的
 * 目录/link 换了 dev/ino，或授权指纹变化（attach/detach、grant 改向）都必须拒绝。
 * 新出现目录是否把文件导向别处，由调用方另行比较 physicalPathKey。
 */
export function knowledgeBoundaryMatches(
  snapshot: KnowledgeBoundarySnapshot,
  target: KnowledgePathResolution,
  expectedPhysicalPathKey?: string,
): boolean {
  if (snapshot.policyFingerprint !== target.policyFingerprint) return false
  // 单一调用即可自证物理目标未变，不要求调用方记得再比一次。
  if (expectedPhysicalPathKey !== undefined
    && knowledgePathKey(target.physicalPath) !== knowledgePathKey(expectedPhysicalPathKey)) return false
  const nonFile = target.identities.filter(item => item.kind !== 'file')
  const current = new Map(nonFile.map(item => [knowledgePathKey(item.path), item]))
  const matched = snapshot.entries.every(([path, dev, ino, kind]) => {
    const identity = current.get(path)
    return Boolean(identity) && identity!.dev === dev && identity!.ino === ino && identity!.kind === kind
  })
  if (!matched) return false
  // 受控写入可以新建中间目录，但新出现的条目必须是 directory；
  // 不许把同路径的文件/链接替换当成“正常新建”。
  const observed = new Set(snapshot.entries.map(([path]) => path))
  return nonFile.every(item => observed.has(knowledgePathKey(item.path)) || item.kind === 'directory')
}
