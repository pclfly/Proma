import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AttributedKnowledgeChange, WorkspaceKnowledgeFileRef } from '@proma/shared'
import { resolveAgentWorkspaceDirPath } from './config-paths'
import { getKnownKnowledgeWorkspace, getWorkspaceKnowledgePolicy, isWorkspaceProjectKnowledgeMaintenanceApproved, resolveWorkspaceProjectRoot } from './agent-workspace-manager'
import { knowledgePathKey, knowledgeResolutionBoundary, normalizeKnowledgeRelativePath, resolveWorkspaceKnowledgePath, type KnowledgeAccessPolicy, type KnowledgePathResolution } from './workspace-knowledge-access'
import { inspectKnowledgePath, readKnowledgeWitness, resolvePhysicalPath } from './knowledge-witness'
import { setKnowledgeMutationInvalidator } from './knowledge-mutation-invalidation'
import {
  WorkspaceKnowledgeMutationBroker,
  type BoundKnowledgeMutationObserver,
  type KnowledgeMutationScope,
  type KnowledgeMutationSnapshot,
  type KnowledgeMutationTarget,
} from './workspace-knowledge-mutation-broker'

interface WorkspaceRoots {
  memoryRoot: string
  workspaceAgents: string
  projectAgents: string
  approved: boolean
}

function realOrResolved(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

function identityOf(path: string): string {
  try {
    const stat = lstatSync(path)
    return `${realOrResolved(path)}:${stat.dev}:${stat.ino}`
  } catch {
    return `${realOrResolved(path)}:missing`
  }
}

function rootsFor(workspaceSlug: string): WorkspaceRoots {
  // 先验证注册表中的确切 slug：拒绝未知/非法标识时不能经过任何创建型 getter。
  const workspaceDir = resolveAgentWorkspaceDirPath(getKnownKnowledgeWorkspace(workspaceSlug).slug)
  return {
    memoryRoot: join(workspaceDir, 'memory'),
    workspaceAgents: join(workspaceDir, 'AGENTS.md'),
    projectAgents: join(resolveWorkspaceProjectRoot(workspaceSlug), 'AGENTS.md'),
    approved: isWorkspaceProjectKnowledgeMaintenanceApproved(workspaceSlug),
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 分类一个 typed 文件工具的实际目标：与读写/树/watch共用同一权限策略，
 * 因此已授权外置链接按逻辑别名归因，未授权链接不会因能 realpath 就被当作 memory 目标。
 * 未获持久维护授权的 AGENTS 仍返回竞争目标（file 为空），避免并发写被误当作独占。
 */
export function resolveWorkspaceKnowledgeTarget(workspaceSlug: string, logicalPath: string): KnowledgeMutationTarget | undefined {
  if (!isAbsolute(logicalPath)) return undefined
  let roots: WorkspaceRoots
  try { roots = rootsFor(workspaceSlug) } catch { return undefined }

  // memory 目标：先做纯逻辑归属判定，再交给统一 resolver 逐跳验证链接授权。
  const memoryRelative = memoryRelativePath(roots.memoryRoot, logicalPath)
  if (memoryRelative !== undefined) {
    let policy: KnowledgeAccessPolicy, target: KnowledgePathResolution
    try {
      policy = getWorkspaceKnowledgePolicy(workspaceSlug)
      target = resolveWorkspaceKnowledgePath(policy, memoryRelative, { allowMissing: true })
    } catch { return undefined }
    if (target.kind === 'directory') return undefined
    const file: WorkspaceKnowledgeFileRef = { kind: 'memory', relativePath: memoryRelative }
    return { key: target.physicalPath, physicalPath: target.physicalPath, logicalPath, boundaryIdentity: knowledgeResolutionBoundary(target), file }
  }

  // AGENTS 走同一策略；外置链接在未显式授权时直接放弃分类，已授权时归到真实目标。
  const agentsKind = sameFile(roots.workspaceAgents, logicalPath) ? 'workspace_agents'
    : sameFile(roots.projectAgents, logicalPath) ? 'project_agents' : undefined
  if (!agentsKind) return undefined
  let target: KnowledgePathResolution
  try {
    target = resolveWorkspaceKnowledgePath(getWorkspaceKnowledgePolicy(workspaceSlug, agentsKind === 'workspace_agents' ? 'workspace_agents' : 'project_agents'), 'AGENTS.md', { allowMissing: true })
  } catch { return undefined }
  if (target.kind === 'directory') return undefined
  const boundary = knowledgeResolutionBoundary(target)
  if (!roots.approved) return { key: target.physicalPath, physicalPath: target.physicalPath, logicalPath, boundaryIdentity: boundary }
  return { key: target.physicalPath, physicalPath: target.physicalPath, logicalPath, boundaryIdentity: boundary, file: { kind: agentsKind } }
}

/** 只在逻辑上属于 memory 根时返回相对路径；不做 realpath，避免未授权链接先被跟随。 */
function memoryRelativePath(memoryRoot: string, logicalPath: string): string | undefined {
  const rel = relative(resolve(memoryRoot), resolve(logicalPath))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
  try { return normalizeKnowledgeRelativePath(rel.split(sep).join('/')) } catch { return undefined }
}

function sameFile(left: string, right: string): boolean {
  return knowledgePathKey(left) === knowledgePathKey(right)
}

export interface WorkspaceKnowledgeAttributionHooks {
  /** 主进程权威：旧代次、已停止、已删除会话都不得再产出来源事件。 */
  isRunCurrent: (owner: KnowledgeMutationScope) => boolean
  emit: (change: AttributedKnowledgeChange) => void
  maxTickets?: number
}

let hooks: WorkspaceKnowledgeAttributionHooks | undefined
let sharedBroker: WorkspaceKnowledgeMutationBroker | undefined

/** 全局竞争登记必须跨 query/会话共享，不能每个 query 建一个 broker。 */
export function configureWorkspaceKnowledgeAttribution(next: WorkspaceKnowledgeAttributionHooks | undefined): void {
  hooks = next
  sharedBroker = undefined
  setKnowledgeMutationInvalidator(next ? (path) => {
    // 手动保存可以通过任何workspace/链接别名到达同一物理文件，不能只取消当前workspace。
    let physical = path
    try { physical = realpathSync(path) } catch { physical = resolvePhysicalPath(path) }
    sharedBroker?.invalidateTarget(physical)
  } : undefined)
}

function broker(): WorkspaceKnowledgeMutationBroker {
  sharedBroker ??= new WorkspaceKnowledgeMutationBroker({
    maxTickets: hooks?.maxTickets,
    resolveTarget: (owner, path) => resolveWorkspaceKnowledgeTarget(owner.workspaceSlug, path),
    // 已授权文件链接的正文见证必须读真实目标；直接读 alias 会被 witness 当作不支持的链接。
    read: async (target): Promise<KnowledgeMutationSnapshot> => readKnowledgeWitness(target.physicalPath ?? target.logicalPath),
    // 未配置主进程权威时保守拒绝，不把 observed 事件当作可信来源。
    isCurrent: owner => hooks?.isRunCurrent(owner) === true,
    emit: change => { hooks?.emit(change) },
  })
  return sharedBroker
}

/** 手动保存、外部 writer 等未持有凭据的已知写入口：只取消同目标候选。 */
export function invalidateWorkspaceKnowledgeTarget(workspaceSlug: string, logicalPath: string): void {
  const target = resolveWorkspaceKnowledgeTarget(workspaceSlug, logicalPath)
  if (target) broker().invalidateTarget(target.key)
}

/**
 * 一次 query 的归属句柄：只把通过核验的 write/edit 提交变成来源事件。
 * close 必须发生在该 query 的真实清理之后，否则同路径竞争记录会被提前释放。
 */
export function bindWorkspaceKnowledgeScope(scope: KnowledgeMutationScope): BoundKnowledgeMutationObserver {
  return broker().bind(scope)
}
