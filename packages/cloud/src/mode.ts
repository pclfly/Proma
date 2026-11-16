/**
 * Proma Cloud 运行模式判定
 *
 * 与官方 0.22.0 一致：仅 `PROMA_MODE === 'cloud'` 视为 Cloud 模式。
 */

export type PromaMode = 'local' | 'cloud'

/** 环境变量只读快照；避免直接依赖 NodeJS 命名空间。 */
export type CloudModeEnv = Readonly<Record<string, string | undefined>>

export function isCloudMode(env: CloudModeEnv = process.env): boolean {
  return env.PROMA_MODE === 'cloud'
}

export function getPromaMode(env: CloudModeEnv = process.env): PromaMode {
  return env.PROMA_MODE === 'cloud' ? 'cloud' : 'local'
}
