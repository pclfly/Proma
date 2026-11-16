/**
 * 全局用户画像（关于你）的读写与历史。
 *
 * 官方 0.22.0：全局画像只属于 `memory/user_profile.md`，所有项目共享；
 * 项目协作规则仍留在各项目 MEMORY.md，二者不能互相覆盖。
 */

import type {
  GlobalProfileHistoryEntry,
  GlobalProfileHistoryVersion,
  GlobalUserProfile,
} from '@proma/shared'
import {
  inspectLegacyProfileLocations,
  listMemoryHistory,
  memoryPaths,
  pendingMemoryMigrations,
  readGlobalProfile as readGlobalProfileFile,
  readMemoryHistoryVersion,
  readMemoryReview,
  restoreMemoryVersion,
  updateMemory,
  type AgentMemoryContext,
} from './agent-memory'

export type GlobalProfileView = GlobalUserProfile

export function readGlobalProfile(ctx: AgentMemoryContext): GlobalProfileView {
  const file = readGlobalProfileFile(ctx)
  const { sources, issues } = inspectLegacyProfileLocations(ctx)
  let pendingCount = 0
  try {
    pendingCount = pendingMemoryMigrations(ctx).length
  } catch (error) {
    issues.push({ path: ctx.globalDir, message: `迁移记录检查失败：${String(error)}` })
  }
  return {
    ...file,
    checkedAt: readMemoryReview(ctx, file).checkedAt,
    legacyCount: sources.length,
    pendingCount,
    migrationIssues: issues,
  }
}

export function writeGlobalProfile(
  ctx: AgentMemoryContext,
  revision: string,
  content: string,
): GlobalProfileView {
  if (
    typeof revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(revision)
    || typeof content !== 'string'
    || !content.trim()
    || Buffer.byteLength(content) > 512 * 1024
  ) {
    throw new Error('请输入有效画像内容（不超过 512 KiB），并先读取当前版本。')
  }
  updateMemory(ctx, 'global-profile', revision, content, '用户在「关于你」中直接编辑并保存。')
  return readGlobalProfile(ctx)
}

export function readGlobalProfileHistory(
  ctx: AgentMemoryContext,
  limit = 8,
): GlobalProfileHistoryEntry[] {
  return listMemoryHistory(ctx, 'global-profile', limit)
}

export function readGlobalProfileHistoryVersion(
  ctx: AgentMemoryContext,
  revision: string,
): GlobalProfileHistoryVersion {
  const file = readMemoryHistoryVersion(ctx, 'global-profile', revision)
  if (file.content === null) throw new Error('该历史版本不存在或已被清理。')
  return { revision, content: file.content }
}

export function restoreGlobalProfileHistory(
  ctx: AgentMemoryContext,
  revision: string,
  expectedRevision: string,
): GlobalProfileView {
  if (!/^[a-f0-9]{64}$/.test(revision) || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new Error('请先刷新画像，再选择要恢复的历史版本。')
  }
  restoreMemoryVersion(
    ctx,
    'global-profile',
    revision,
    expectedRevision,
    '用户在「关于你」中从历史版本恢复。',
  )
  return readGlobalProfile(ctx)
}

export function globalProfilePath(ctx: AgentMemoryContext): string {
  return memoryPaths(ctx).profile
}
