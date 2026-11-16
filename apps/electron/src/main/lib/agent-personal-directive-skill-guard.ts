/**
 * 破甲技能根的写保护。
 *
 * 破甲开启时挂载两类技能根，可写性完全不同：
 *
 * - `skillPaths`（Seep 官方技能根）是 Seep 工作台的官方资产，被多个 Agent 共用。
 *   **无条件禁止写入**，不存在任何授权放行通道——用户点"允许"也不行。
 * - `localSkillRootPath`（本地技能根）是用户自己的经验沉淀区，允许写入。
 *
 * 这个区分是硬要求：把两者一起做成"可授权放行"，就等于允许把本地规则写进官方技能。
 *
 * 判定使用 realpath：符号链接与大小写差异（Windows）都要归一到真实路径再比较，
 * 否则 `link -> skillDir` 这类路径能绕过字符串前缀检查。
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 写入类工具：只有这些会改磁盘上的技能文件。 */
const SKILL_WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
}

/** 取真实路径；目标不存在时回退到最近存在祖先的真实路径，保证比较仍然可靠。 */
function guardedRealPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    // 新文件尚未落盘：找到最近的既有祖先，把它 realpath 后接回相对尾巴。
  }

  let ancestor = resolved
  for (;;) {
    const parent = resolve(ancestor, '..')
    if (parent === ancestor) return resolved
    ancestor = parent
    try {
      return resolve(realpathSync.native(ancestor), relative(ancestor, resolved))
    } catch {
      // 继续向上找。
    }
  }
}

/**
 * 判断一次工具调用是否在写破甲技能目录。
 *
 * @param toolName 工具名（Write / Edit / NotebookEdit）
 * @param input    工具入参，path 已由适配层归一为绝对路径
 * @param officialSkillPaths Seep 官方技能根（无条件只读）
 * @returns 命中时返回被写的技能根，用于给用户看得懂的拒绝信息
 */
export function matchProtectedSkillWrite(
  toolName: string,
  input: Record<string, unknown>,
  officialSkillPaths: readonly string[],
): string | undefined {
  if (!SKILL_WRITE_TOOLS.has(toolName)) return undefined
  if (officialSkillPaths.length === 0) return undefined

  const rawPath = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.path === 'string' ? input.path : ''
  if (!rawPath || !isAbsolute(rawPath)) return undefined

  const target = guardedRealPath(rawPath)
  for (const root of officialSkillPaths) {
    if (isPathInside(guardedRealPath(root), target)) return root
  }
  return undefined
}

/** 拒绝时给模型与用户的统一措辞；两者必须一致，避免模型换个说法重试。 */
export function buildProtectedSkillWriteMessage(skillRoot: string, toolName: string, localRoot?: string): string {
  const sink = localRoot
    ? `改成写本地技能根 ${localRoot}`
    : '改成写 Proma 工作区 skills/ 或会话工作台'
  return `Seep 官方技能目录为只读：${skillRoot} 是 Seep 工作台的官方资产，被多个 Agent 共用，任何情况下都不允许写入（包括用户逐次授权）。`
    + `本次 ${toolName} 未执行，不要换个写法或用 Bash 重试。要沉淀新经验请${sink}，不要改官方技能。`
}
