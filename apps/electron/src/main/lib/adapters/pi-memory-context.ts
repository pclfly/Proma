/**
 * Live memory 上下文注入。
 *
 * 官方 0.22.0：每次模型请求前重新读取全局 Profile 与项目 MEMORY.md，
 * 通过 system message 的 `proma_memory` 命名 section 替换旧内容；
 * `project_context` 同步保留（项目/工作区指令由 Proma 显式解析后传入）。
 *
 * 本地差异：
 * - 项目规则维护/迁移提示仍由本地 `project-instruction-resolver` 与
 *   `buildSystemPrompt` 负责，这里不重复注入官方 ProjectInstructions* 工具提示。
 * - 不在 context 中自动建立记忆文件；建立只发生在显式 MemoryInitialize。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  MEMORY_INDEX_MAX_CHARS,
  PROFILE_MAX_CHARS,
  hasMemoryAssociation,
  inspectLegacyProfileLocations,
  memoryPaths,
  memoryTarget,
  assertProjectMemoryPath,
  pendingMemoryMigrations,
  readGlobalProfile,
  readMemoryFile,
  readMemoryReview,
  type AgentMemoryContext,
  type MemoryFile,
} from '../agent-memory'
import { inspectProjectMap } from '../project-map-review'
import { instructionMigrationPrompt } from '../project-instruction-memory-migration'
import { instructionMaintenancePrompt } from '../project-instruction-maintenance'
import { readInstructionReadyRecord } from '../project-instruction-state'

export interface MemoryContextProjectFile {
  path: string
  content: string
}

/** 项目规则常驻注入上限（官方口径 12000 字符）。 */
const MEMORY_INDEX_CONTEXT_LIMIT = 12_000

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function memoryFileSection(
  path: string,
  file: MemoryFile,
  limit: number,
  reviewDue: boolean,
): string {
  return `<memory_file path="${escapeXml(path)}" revision="${file.revision}" review_due="${reviewDue}">
${escapeXml((file.content ?? '').slice(0, limit))}
</memory_file>`
}

/**
 * 生成当前记忆正文与维护提示。
 *
 * 读取失败会显式告知模型“不得当作缺失覆盖”，与官方一致。
 */
export function buildLiveMemoryContext(ctx: AgentMemoryContext, maintenanceSince?: number): string {
  const paths = memoryPaths(ctx)
  const parts: string[] = [
    '## 当前记忆（每次模型请求前重新读取）',
    '读写走 MemoryInspect / MemoryUpdate 并校验版本；写入优先用 operations 增删改单条 `- ` 事实（不要动辄整篇重写），主题较多时先用 MemorySearch 定位片段，历史版本用 MemoryHistory 查看；记录时保留来源、范围和核验日期，临时事实标注有效期。稳定偏好不因时间自动失效；读取不等于核验。',
  ]

  const ready = readInstructionReadyRecord(ctx)
  const maintenance = instructionMaintenancePrompt(ctx)
  if (maintenance) parts.push(maintenance)
  if (ready) {
    parts.push('项目规则首次维护已完成，优先于旧的 AGENTS.md 缺失快照；仅停止重复执行 ProjectInstructionsMaintain、ProjectInstructionsMigrate 等项目规则初始化与迁移。这个状态不代表全局画像整合完成，不禁止 MemoryInspect、MemoryMigrateProfile 或日常记忆维护。画像整合以本轮独立检查的剩余来源和中断记录为准。用户未询问时，不主动提起此前的项目规则维护。')
  }
  if (ready?.changed && maintenanceSince !== undefined && ready.completedAt >= maintenanceSince) {
    parts.push('本轮已实际完成项目能力优化。先正常回答用户，在末尾仅附一句：这次也顺手完善了项目的 Agent 协作能力，后续可以直接使用。不要再解释文件路径、规则条款、技术步骤或初始化。用户仅问候时最终回复最多两句，不列举能力，不说目录为空。这是本轮唯一维护告知，下轮不再提及。')
  }
  const instructionsMigration = instructionMigrationPrompt(ctx)
  if (instructionsMigration) parts.push(instructionsMigration)

  for (const [path, limit, kind] of [
    [paths.profile, PROFILE_MAX_CHARS, 'profile'],
    [paths.index, MEMORY_INDEX_CONTEXT_LIMIT, 'index'],
  ] as const) {
    try {
      let file: MemoryFile
      if (kind === 'profile') {
        file = readGlobalProfile(ctx)
      } else {
        assertProjectMemoryPath(ctx, path)
        file = readMemoryFile(path)
      }
      if (!file.content?.trim()) {
        parts.push(ctx.allowMemoryWrites === false
          ? `记忆文件尚不存在：${path}（本轮只读，不建立）`
          : `必需记忆待建立：${path}`)
        continue
      }
      const review = readMemoryReview(ctx, file)
      parts.push(memoryFileSection(path, file, limit, review.reviewDue))
      if (file.content.length > limit) {
        parts.push(kind === 'profile'
          ? `Profile 超过 ${limit} 字符，仅注入前 ${limit} 字符。在允许写入的用户会话中，用 MemoryUpdate 的 operations 逐条去重、合并过期事实并保留来源；不要为清除提醒而重写。`
          : `文件 ${path} 超过常驻上下文预算，仅注入前 ${limit} 字符；判断相关事实前必须用 MemoryInspect 读取完整正文，不能将未展示的内容视为不存在。`)
      } else if (kind === 'index' && file.content.length > MEMORY_INDEX_MAX_CHARS) {
        parts.push(`存量 MEMORY.md 索引已有 ${file.content.length} 字符，超过纯路由索引预算（${MEMORY_INDEX_MAX_CHARS} 字符）。索引每条应只写「- [主题](file.md) — 适用场景（≤1 行）」，禁止在索引里堆砌详细结论；可在项目会话收尾前，将索引中的长段事实下沉到对应 memory/*.md 并精简 MEMORY.md。`)
      }
      if (review.reviewDue) {
        parts.push(`${path} 超过一周未修改或核验；结合本轮任务检查阶段性要求、过期条目和冲突。实际核验后用 MemoryUpdate 提交正文（可不变）及依据；不要仅为清除提醒写入。`)
      }
    } catch (error) {
      parts.push(`记忆读取失败（不得当作缺失覆盖）：${path}；${String(error)}`)
    }
  }

  try {
    const legacyPath = memoryTarget(ctx, 'project-preferences.md')
    const legacyPrefs = readMemoryFile(legacyPath)
    if (legacyPrefs.content?.trim()) {
      parts.push(`检测到存量 project-preferences.md（${legacyPrefs.content.length} 字符，已取消每轮常驻注入）：可写项目会话收尾前，请用 MemoryInspect(target="project-preferences.md") 读取并按三层架构分流——跨任务必守的项目红线并入 AGENTS.md，特定模块偏好或经验并入对应 memory/*.md 主题，过期的阶段性状态直接剔除；分流核验后调用 MemoryArchive 归档 project-preferences.md 并同步移除 MEMORY.md 中的入口。`)
    }
  } catch (error) {
    parts.push(`存量项目偏好读取失败（保留原文件）：${paths.preferences}；${String(error)}`)
  }

  const map = inspectProjectMap(ctx.projectRoot)
  if (map.status === '不可安全修改') {
    parts.push(`项目 AGENTS.md 不可安全修改：${map.path}；不要通过符号链接或其他工具绕过。`)
  } else if (!hasMemoryAssociation(ctx, map.content ?? '')) {
    parts.push(`项目 AGENTS.md 尚未关联记忆维护方案：${map.path}；已有长文同样需要关联。`)
  }

  try {
    const pending = pendingMemoryMigrations(ctx)
    const { sources: legacy, issues } = inspectLegacyProfileLocations(ctx)
    if (issues.length > 0) {
      parts.push(`旧画像存在受阻来源：${issues.map((issue) => `${issue.path}：${issue.message}`).join('；')}。保留异常文件，不将失效或循环链接当作缺失覆盖；可以继续处理正常来源。只要 migrationIssues 非空，就不能宣告整合全部完成。`)
    }
    const canMigrate = ctx.allowProfileMigration !== false && ctx.allowInstructionMaintenance !== false
    if (pending.length > 0 || legacy.length > 0) {
      if (!canMigrate) {
        parts.push(`全局画像整合独立待处理：${legacy.length} 份旧画像、${pending.length} 项未完成记录。本轮为自动化/委派/只读会话，不执行画像整合，不调用 MemoryMigrateProfile；保留原文件与状态。`)
      } else {
        parts.push(`全局画像整合独立待处理：${legacy.length} 份旧画像、${pending.length} 项未完成记录（旧正文未作为当前有效画像注入）。本轮允许写入的用户项目会话中，应在收尾前顺势完成整合，无需等待用户点击按钮或专门提出要求。先用 MemoryInspect 读取来源和版本，再用 MemoryMigrateProfile 逐份语义合并、同步源项目 MEMORY.md 索引并归档。不能只删除旧入口，不能按文件时间覆盖冲突，不确定事实保留范围和来源，必要时询问。最后重新检查剩余来源、中断记录和 migrationIssues；全部清空才报告整合完成，普通任务中仅简短告知。`)
        if (pending.length > 0) {
          parts.push(`先用 MemoryMigrateProfile 的 resumeId 恢复未完成画像整合：${pending.join(', ')}。遇到新改动不得覆盖，使用 replanId 保留现有文件并退役旧计划，然后用 MemoryInspect 重新读取最新版本，提交新的语义合并。重规划不代表整合完成，成功后继续处理剩余来源。`)
        }
      }
    }
  } catch (error) {
    parts.push(`旧画像检查未完成：${String(error)}；不得声称已完成迁移。`)
  }

  return parts.join('\n\n')
}

/**
 * 把 live memory 写入第一条 system message 的命名 section。
 *
 * - 所有 system message 都清除旧的 `project_context` / `proma_memory`，避免重复累积；
 * - 第一条 system message 承载最新内容；没有 system message 时新建一条；
 * - 其他命名 section（如 `proma_project_instructions`）原样保留。
 */
export function refreshMemorySystemMessages(
  messages: AgentMessage[],
  ctx: AgentMemoryContext,
  projectFiles: readonly MemoryContextProjectFile[],
  maintenanceSince?: number,
): AgentMessage[] {
  const memory = buildLiveMemoryContext(ctx, maintenanceSince)
  const project = projectFiles.length > 0
    ? `Project-specific instructions and guidelines:

${projectFiles.map((file) => `<project_instructions path="${escapeXml(file.path)}">
${file.content}
</project_instructions>`).join('\n\n')}`
    : null

  let injected = false
  const result: AgentMessage[] = messages.map((message) => {
    if (message.role !== 'system') return message
    const sections: Record<string, string | null> = { ...message.sections }
    delete sections.project_context
    delete sections.proma_memory
    if (!injected) {
      sections.project_context = project
      sections.proma_memory = memory
      injected = true
    }
    return { ...message, sections }
  })
  if (!injected) {
    result.unshift({
      role: 'system',
      content: '',
      sections: { project_context: project, proma_memory: memory },
      timestamp: Date.now(),
    })
  }
  return result
}
