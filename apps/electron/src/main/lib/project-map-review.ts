/**
 * 项目地图（AGENTS.md）检查。
 *
 * 官方 0.22.0 的记忆子系统把“项目规则入口”当作项目地图：
 * 只读取项目根已有的 AGENTS.md / AGENTS.MD，不跟随符号链接、不做环境式发现。
 * 这里保持最小实现，供记忆关联与 live context 复用。
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFileAtomic } from './safe-file'

export type ProjectMapStatus = '已存在' | '待完善' | '缺失' | '不可安全修改'

export interface ProjectMapInspection {
  /** 期望或实际的项目地图路径。 */
  path: string
  content?: string
  /** 去掉 Proma 记忆关联块后的非空白字符数。 */
  characterCount?: number
  modifiedAt?: number
  status: ProjectMapStatus
  revision?: string
}

/** 项目地图被视为“足够完整”的最小非空白字符数（官方口径）。 */
const MIN_PROJECT_MAP_CHARS = 200

const MEMORY_BLOCK = /<!-- proma:memory:start -->[\s\S]*?<!-- proma:memory:end -->/g

/** 去掉受管记忆关联块，避免它被算作项目规则。 */
export function stripMemoryAssociation(content: string): string {
  return content.replace(MEMORY_BLOCK, '')
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}

/**
 * 检查项目根规则文件。
 *
 * - 只接受普通文件；符号链接、目录、其他特殊文件一律“不可安全修改”。
 * - 不存在返回“缺失”，内容不足 200 个非空白字符返回“待完善”。
 */
export function inspectProjectMap(projectRoot: string): ProjectMapInspection {
  for (const name of ['AGENTS.md', 'AGENTS.MD'] as const) {
    const path = join(projectRoot, name)
    let stat
    try {
      stat = lstatSync(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      return { path, status: '不可安全修改' }
    }
    if (!stat.isFile()) return { path, status: '不可安全修改' }
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      return { path, status: '不可安全修改' }
    }
    const projectContent = stripMemoryAssociation(content)
    const characterCount = Array.from(projectContent.replace(/\s/g, '')).length
    return {
      path,
      content,
      characterCount,
      modifiedAt: stat.mtimeMs,
      status: characterCount < MIN_PROJECT_MAP_CHARS ? '待完善' : '已存在',
      revision: createHash('sha256').update(`${name}\0${stat.mtimeMs}\0${content}`).digest('hex'),
    }
  }
  return { path: join(projectRoot, 'AGENTS.md'), status: '缺失' }
}

/** 项目地图每周至少复核一次；修改时间与上次实际检查时间取较晚者。 */
export const PROJECT_MAP_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000

export interface ProjectMapReviewState extends ProjectMapInspection {
  checkedAt?: number
  reviewDue: boolean
}

export interface ProjectMapReviewRecord {
  checkedAt: number
  revision: string
  summary: string
}

function reviewRecordPath(workspaceRoot: string, projectRoot: string): string {
  let identity = resolve(projectRoot)
  try {
    identity = realpathSync.native(projectRoot)
  } catch {
    // 项目根不可解析时仍使用规范化绝对路径作为稳定键。
  }
  const key = createHash('sha256').update(identity).digest('hex')
  return join(workspaceRoot, 'project-map-reviews', `${key}.json`)
}

/** 读取项目地图与当前 revision 对应的实际检查记录。 */
export function readProjectMapReviewState(
  workspaceRoot: string,
  projectRoot: string,
  now = Date.now(),
): ProjectMapReviewState {
  const map = inspectProjectMap(projectRoot)
  let checkedAt: number | undefined
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(reviewRecordPath(workspaceRoot, projectRoot), 'utf-8'),
    )
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (
        record.revision === map.revision
        && typeof record.checkedAt === 'number'
        && Number.isFinite(record.checkedAt)
        && record.checkedAt > 0
        && record.checkedAt <= now
      ) {
        checkedAt = record.checkedAt
      }
    }
  } catch {
    // 无检查记录或记录损坏时保持未检查状态。
  }
  return {
    ...map,
    checkedAt,
    reviewDue: map.modifiedAt !== undefined
      && now - Math.max(map.modifiedAt, checkedAt ?? 0) > PROJECT_MAP_REVIEW_INTERVAL_MS,
  }
}

/** 记录一次实际完成的检查；revision 必须是当前文件版本。 */
export function completeProjectMapReview(
  workspaceRoot: string,
  projectRoot: string,
  revision: string,
  summary: string,
  now = Date.now(),
): ProjectMapReviewRecord {
  if (!summary.trim()) {
    throw new Error('请说明实际核验的内容、依据以及更新或无需更新的结论。')
  }
  const map = inspectProjectMap(projectRoot)
  if (!map.revision || map.status === '不可安全修改') {
    throw new Error('项目地图缺失或不可安全修改，不能记录检查完成。')
  }
  if (map.revision !== revision) {
    throw new Error('AGENTS.md 已发生变化，请重新读取并核验后再记录检查完成。')
  }
  const record: ProjectMapReviewRecord = { checkedAt: now, revision, summary: summary.trim() }
  const path = reviewRecordPath(workspaceRoot, projectRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonFileAtomic(path, record)
  return record
}
