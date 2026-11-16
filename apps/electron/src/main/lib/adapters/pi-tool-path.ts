import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { canonicalizeProjectPath } from '../project-instruction-resolver'
import { fileURLToPath } from 'node:url'

/** 与Pi1.1工具resolveToCwd保持一致，权限/作用域/执行使用同一路径。 */
export function resolvePiToolPath(input: string, cwd: string): string {
  const normalize = (value: string, toolInput = false): string => {
    let path = toolInput ? value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '') : value
    if (process.platform === 'win32' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
      const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
      if (match) path = `${match[1]!.toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`
    }
    if (path === '~') return homedir()
    if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) return join(homedir(), path.slice(2))
    return /^file:\/\//.test(path) ? fileURLToPath(path) : path
  }
  const path = normalize(input, true)
  return isAbsolute(path) ? resolve(path) : resolve(normalize(cwd), path)
}

export function normalizePiPathInput(name: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  if (!['read', 'write', 'edit', 'ls', 'find', 'grep'].includes(name)) return input
  const path = typeof input.path === 'string' ? input.path : ['ls', 'find', 'grep'].includes(name) ? '.' : undefined
  return path === undefined ? input : { ...input, path: canonicalizeProjectPath(resolvePiToolPath(path, cwd)) }
}
