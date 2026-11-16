/**
 * Cloud 认证服务（纯逻辑部分）
 *
 * 从官方 0.22.0 `src/main/lib/cloud-auth-service.ts` 提取可安全移植的部分：
 * - API base URL 归一化
 * - 认证文件路径隔离判定（供 safeStorage / 正式版登录态借用逻辑使用）
 * - 用户快照解析与安全错误映射
 *
 * 明确 deferred：
 * - 真实登录 / 注册 / OAuth 回调
 * - safeStorage 加解密与认证文件读写
 * - 会话版本号、广播与 Cloud 渠道联动
 */

import { normalizeCloudBaseUrl } from '@proma/cloud'
import type { CloudUser, CloudUserStatus } from '@proma/cloud'

/** 正式版 API 根地址（与官方一致） */
export const PRODUCTION_CLOUD_API_BASE_URL = 'https://api.proma.cool/api/v1'

/** 认证态快照（供 IPC / renderer 使用的最小契约） */
export interface CloudAuthState {
  loggedIn: boolean
  user: CloudUser | null
}

/** 文件身份（dev + ino 足以判断是否同一文件/目录） */
export interface CloudFileIdentity {
  dev: number
  ino: number
}

/** 认证路径上的条目（lstat 结果） */
export interface CloudAuthPathEntry extends CloudFileIdentity {
  isSymbolicLink: boolean
}

/**
 * 认证路径判定所需事实。
 *
 * 由主进程注入 lstat/stat 结果，纯函数只负责决策。
 */
export interface CloudAuthPathFacts {
  /** 开发认证文件（~/.proma-dev/cloud-auth.json） */
  localFile?: CloudAuthPathEntry
  /** 正式版认证文件（~/.proma/cloud-auth.json）；不存在时 undefined */
  productionFile?: CloudAuthPathEntry
  /** 正式版文件若为符号链接，其目标 stat 结果；断链时 undefined */
  productionTarget?: CloudFileIdentity
  /** 开发配置目录 */
  localDirectory?: CloudFileIdentity
  /** 正式版配置目录 */
  productionDirectory?: CloudFileIdentity
}

/** 官方 getAuthApiBaseUrl 等价实现 */
export function getCloudAuthApiBaseUrl(baseUrl?: string): string {
  return normalizeCloudBaseUrl(baseUrl)
}

/** 判断两个文件身份是否相同；任一侧缺失视为不同 */
export function isSameCloudFile(
  first: CloudFileIdentity | undefined,
  second: CloudFileIdentity | undefined,
): boolean {
  return first !== undefined
    && second !== undefined
    && first.dev === second.dev
    && first.ino === second.ino
}

/**
 * 是否可以使用本地（开发）认证路径。
 *
 * 官方 `getLocalAuthPath()` 在检测到开发路径与正式版路径共用文件、
 * 目录相同或存在符号链接时返回 null（跳过本地认证恢复）。
 * 这里用注入事实复刻该判定：
 * - 本地文件是符号链接 → 不可用
 * - 正式版文件是符号链接且目标缺失（断链）→ 不可用
 * - 本地文件与正式版符号链接目标同文件 → 不可用
 * - 两个配置目录相同 → 不可用
 * - 没有正式版安装（productionFile 缺失）→ 可用
 */
export function isLocalCloudAuthPathUsable(facts: CloudAuthPathFacts): boolean {
  if (facts.localFile?.isSymbolicLink) return false
  if (facts.productionFile?.isSymbolicLink && !facts.productionTarget) return false
  if (isSameCloudFile(facts.localFile, facts.productionTarget)) return false
  if (isSameCloudFile(facts.localDirectory, facts.productionDirectory)) return false
  return true
}

const CLOUD_USER_STATUSES: readonly CloudUserStatus[] = ['PENDING', 'APPROVED', 'DISABLED']

function isCloudUserStatus(value: unknown): value is CloudUserStatus {
  return typeof value === 'string' && CLOUD_USER_STATUSES.includes(value as CloudUserStatus)
}

/**
 * 解析认证文件中的用户快照。
 *
 * `decode` 由调用方注入（safeStorage 解密或明文直返）。
 * 任一必填字段类型不符时返回 null，不抛出。
 */
export function parseCloudUserSnapshot(
  value: unknown,
  decode: (stored: string) => string,
): CloudUser | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const user = JSON.parse(decode(value)) as Record<string, unknown>
    if (
      !user
      || typeof user !== 'object'
      || typeof user.id !== 'string'
      || typeof user.email !== 'string'
      || typeof user.name !== 'string'
      || !isCloudUserStatus(user.status)
    ) {
      return null
    }
    const image = typeof user.image === 'string' || user.image === null ? user.image : undefined
    const avatar = typeof user.avatar === 'string' || user.avatar === null ? user.avatar : undefined
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      image,
      avatar,
    }
  } catch {
    return null
  }
}

/** 认证服务类型契约；实现留给后续批次。 */
export interface CloudAuthService {
  getAuthState(): Promise<CloudAuthState>
  login(email: string, password: string): Promise<CloudAuthState>
  logout(): Promise<void>
  getAccessToken(): string | null
}
