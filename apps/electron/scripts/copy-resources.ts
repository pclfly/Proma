import { cpSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 使用跨平台FS复制，不依赖Bun shell对cp参数的支持，也不吞掉资源缺失或复制错误。 */
export function copyElectronResources(appDirectory = resolve(import.meta.dir, '..')): void {
  const source = join(appDirectory, 'resources')
  const destination = join(appDirectory, 'dist', 'resources')
  if (!statSync(source).isDirectory()) throw new Error('Electron资源目录不存在或不是目录')
  cpSync(source, destination, { recursive: true, force: true })
}

if (import.meta.main) {
  copyElectronResources()
  console.log('[构建资源] 已复制Electron资源目录')
}
