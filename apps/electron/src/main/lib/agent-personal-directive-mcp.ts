/**
 * 破甲 · Seep MCP 挂载层。
 *
 * 破甲开启时，除系统提示词与技能根之外，还会把一份外部 MCP 配置并入
 * 工作区 MCP 集合；关闭后这些 server 在下一轮装配时立刻消失。
 *
 * 配置来源与 `seepSystemPromptPath` 同构：`personalDirective.seepMcpConfigPath`
 * 指向一个 JSON 文件，支持绝对路径或相对于 settings.json 的路径。文件内容
 * 兼容两种顶层键：
 * - `{ "servers": {...} }`    —— Proma 工作区 mcp.json 的形状
 * - `{ "mcpServers": {...} }` —— Claude / Seep 模板的形状
 *
 * 合并规则：**工作区显式配置优先**。同名 server 以工作区为准，破甲层只补空缺，
 * 这样用户可以随时在 UI 里覆盖某个 server，不必回头改破甲配置文件。
 *
 * 这里只做解析与合并，不连接任何 server；连接由编排层统一交给 SDK 桥接。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { McpServerEntry } from '@proma/shared'
import { inferMcpTransportType, normalizeMcpTransportType } from '@proma/shared'
import type { AgentPersonalDirective } from '../../types'
import { getSettingsPath } from './config-paths'

/** 条目来源，决定 http/sse 是否走工作区级 OAuth 凭据。 */
export type McpServerSource = 'workspace' | 'directive'

export interface MergedMcpServer {
  entry: McpServerEntry
  source: McpServerSource
}

export interface MergedMcpServers {
  servers: Record<string, MergedMcpServer>
  /** 破甲层提供但被工作区同名配置覆盖的 server 名，用于一次性日志。 */
  shadowed: string[]
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(
    (pair): pair is [string, string] => typeof pair[1] === 'string',
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * 把一条外部 MCP 定义归一成 Proma 的 `McpServerEntry`。
 *
 * 缺 command（stdio）或 url（http/sse）的条目视为不完整并跳过——静默放过会让
 * 编排层在连接阶段才报错，用户很难定位是哪一条配置的问题。
 */
function normalizeMcpServerEntry(raw: unknown): McpServerEntry | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const candidate = raw as {
    type?: unknown
    command?: unknown
    args?: unknown
    env?: unknown
    url?: unknown
    headers?: unknown
    timeout?: unknown
    enabled?: unknown
  }

  const type = normalizeMcpTransportType(candidate.type) ?? inferMcpTransportType(candidate)
  if (type === 'stdio') {
    if (typeof candidate.command !== 'string' || candidate.command.trim().length === 0) return undefined
  } else if (typeof candidate.url !== 'string' || candidate.url.trim().length === 0) {
    return undefined
  }

  const args = toStringArray(candidate.args)
  const env = toStringRecord(candidate.env)
  const headers = toStringRecord(candidate.headers)
  const timeout = typeof candidate.timeout === 'number'
    && Number.isFinite(candidate.timeout)
    && candidate.timeout > 0
    ? candidate.timeout
    : undefined

  return {
    type,
    enabled: candidate.enabled !== false,
    ...(typeof candidate.command === 'string' && { command: candidate.command }),
    ...(args && { args }),
    ...(env && { env }),
    ...(typeof candidate.url === 'string' && { url: candidate.url }),
    ...(headers && { headers }),
    ...(timeout !== undefined && { timeout }),
  }
}

/** 解析配置路径；破甲关闭或未配置时返回 undefined。 */
export function resolvePersonalDirectiveMcpConfigPath(
  pd: AgentPersonalDirective | undefined,
): string | undefined {
  if (!pd?.enabled) return undefined
  const configured = pd.seepMcpConfigPath?.trim()
  if (!configured) return undefined

  // 绝对路径不触碰 settings 目录解析：测试与纯解析调用不需要 Electron 环境。
  if (isAbsolute(configured)) return configured
  return resolve(dirname(getSettingsPath()), configured)
}

/**
 * 现读破甲 MCP 配置文件。
 *
 * 与 `resolveSeepSystemPrompt` 的选择一致：只在破甲开启时调用，文件缺失或解析
 * 失败返回空集，不影响工作区自身 MCP 与其余破甲层。
 */
export function resolvePersonalDirectiveMcpServers(
  pd: AgentPersonalDirective | undefined,
): Record<string, McpServerEntry> {
  const filePath = resolvePersonalDirectiveMcpConfigPath(pd)
  if (!filePath) return {}

  try {
    if (!existsSync(filePath)) {
      console.warn(`[破甲] seepMcpConfigPath 文件不存在，跳过 MCP 挂载层: ${filePath}`)
      return {}
    }
    const text = readFileSync(filePath, 'utf-8').trim()
    if (!text) {
      console.warn(`[破甲] seepMcpConfigPath 指向的文件为空，跳过: ${filePath}`)
      return {}
    }

    const parsed = JSON.parse(text) as { servers?: unknown; mcpServers?: unknown }
    const source = parsed.servers ?? parsed.mcpServers
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      console.warn(`[破甲] MCP 配置缺少 servers / mcpServers 对象: ${filePath}`)
      return {}
    }

    const result: Record<string, McpServerEntry> = {}
    for (const [name, raw] of Object.entries(source as Record<string, unknown>)) {
      const entry = normalizeMcpServerEntry(raw)
      if (!entry) {
        console.warn(`[破甲] MCP 配置条目 "${name}" 不完整（缺 command/url），已跳过: ${filePath}`)
        continue
      }
      result[name] = entry
    }
    return result
  } catch (error) {
    console.error('[破甲] 读取 seepMcpConfigPath 失败，跳过 MCP 挂载层:', error)
    return {}
  }
}

/** 工作区配置优先合并破甲层；破甲层同名条目不覆盖工作区。 */
export function mergePersonalDirectiveMcpServers(
  workspace: Record<string, McpServerEntry>,
  directive: Record<string, McpServerEntry>,
): MergedMcpServers {
  const servers: Record<string, MergedMcpServer> = {}
  for (const [name, entry] of Object.entries(workspace)) {
    servers[name] = { entry, source: 'workspace' }
  }

  const shadowed: string[] = []
  for (const [name, entry] of Object.entries(directive)) {
    if (servers[name]) {
      shadowed.push(name)
      continue
    }
    servers[name] = { entry, source: 'directive' }
  }

  return { servers, shadowed }
}
