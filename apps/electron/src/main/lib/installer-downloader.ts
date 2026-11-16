/**
 * 第三方安装包下载器
 *
 * 从 OSS / 官方源下载 Git、Node.js 安装程序到本地临时目录，
 * 下载过程中通过 BrowserWindow 事件推送进度，完成后校验 sha256。
 */

import { createHash } from 'crypto'
import { existsSync, promises as fsp } from 'fs'
import path from 'path'

import { app, BrowserWindow, shell } from 'electron'
import { createHostSystemFetch } from './network/host-system-fetch'
import { writeDownloadBody } from './network/download-body'

import {
  INSTALLER_IPC_CHANNELS,
  type InstallerDownloadResult,
  type InstallerProgressPayload,
  type InstallerSource,
} from '@proma/shared'

/** 已注册的可取消下载：key -> cancel() */
const activeDownloads = new Map<string, () => void>()

/**
 * 构造安装包的本地缓存目录
 */
function getInstallerDir(): string {
  return path.join(app.getPath('temp'), 'proma-installers')
}

/**
 * 下载单个安装包：优先 downloadUrl，失败自动 fallback 到 fallbackUrl
 *
 * @param source 安装包元数据
 * @param key 去重键（前端可据此关联进度事件与取消）
 * @param sender 可选的进度事件窗口（通常是发起下载的 BrowserWindow）
 */
export async function downloadInstaller(
  source: InstallerSource,
  key: string,
  sender?: BrowserWindow,
): Promise<InstallerDownloadResult> {
  const dir = getInstallerDir()
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, source.filename)

  // 尝试主 URL，失败再尝试 fallback
  const urls = [source.downloadUrl, source.fallbackUrl].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  )
  if (urls.length === 0) {
    throw new Error('安装包清单缺少有效 URL')
  }

  let lastError: unknown = null
  for (const url of urls) {
    try {
      await downloadToFile(url, filePath, source, key, sender)
      const sha256 = await computeSha256(filePath)
      if (source.sha256 && sha256.toLowerCase() !== source.sha256.toLowerCase()) {
        await fsp.unlink(filePath).catch(() => {})
        throw new Error(
          `sha256 校验失败：期望 ${source.sha256}，实际 ${sha256}`,
        )
      }
      if (!source.sha256) {
        console.warn(
          `[Installer] ${source.filename} 清单未提供 sha256，跳过校验`,
        )
      }
      return { filePath, sha256 }
    } catch (error) {
      lastError = error
      const isCancelled =
        error instanceof Error && error.message === 'cancelled'
      if (isCancelled) {
        // 用户取消不降级到 fallback
        throw error
      }
      console.warn(
        `[Installer] 从 ${url} 下载失败，尝试下一个源：`,
        error,
      )
      await fsp.unlink(filePath).catch(() => {})
    }
  }

  throw (lastError as Error) ?? new Error('所有下载源均失败')
}

/**
 * 流式下载单个 URL 到指定文件，支持自动跟随 3xx 重定向
 */
function downloadToFile(
  url: string,
  filePath: string,
  source: InstallerSource,
  key: string,
  sender: BrowserWindow | undefined,
): Promise<void> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  activeDownloads.set(key, cancel)
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)])

  let response: Response | undefined
  return (async () => {
    try {
      response = await createHostSystemFetch('download')(url, { signal, redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || source.sizeBytes
      let downloaded = 0
      let lastEmit = Date.now()
      let lastBytes = 0
      await writeDownloadBody(response, filePath, {
        signal,
        onProgress: (received) => {
          downloaded = received
          const now = Date.now()
          if (now - lastEmit < 250 && downloaded !== total) return
          const speed = Math.round((downloaded - lastBytes) / ((now - lastEmit) / 1e3 || 1))
          lastEmit = now
          lastBytes = downloaded
          emitProgress(sender, { key, downloaded, total, speed })
        },
      })
      emitProgress(sender, { key, downloaded, total: total || downloaded, speed: 0 })
    } catch (error) {
      if (controller.signal.aborted) throw new Error('cancelled')
      throw error
    } finally {
      if (activeDownloads.get(key) === cancel) activeDownloads.delete(key)
      await response?.body?.cancel().catch(() => {})
    }
  })()
}

function emitProgress(sender: BrowserWindow | undefined, payload: InstallerProgressPayload) {
  if (!sender || sender.isDestroyed()) return
  sender.webContents.send(INSTALLER_IPC_CHANNELS.PROGRESS, payload)
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const buf = await fsp.readFile(filePath)
  hash.update(buf)
  return hash.digest('hex')
}

/**
 * 取消正在进行的下载
 */
export function cancelInstallerDownload(key: string): boolean {
  const cancel = activeDownloads.get(key)
  if (cancel) {
    cancel()
    return true
  }
  return false
}

/**
 * 拉起已下载的安装程序
 *
 * Windows 下 shell.openPath 会用系统默认方式打开 .exe / .msi，
 * 等同于用户双击，由操作系统决定是否弹 UAC。
 */
export async function launchInstaller(filePath: string): Promise<void> {
  const errorMsg = await shell.openPath(filePath)
  if (errorMsg) {
    throw new Error(`无法拉起安装程序：${errorMsg}`)
  }
}

/** 清理已下载的安装包缓存目录 */
export async function cleanInstallerDir(): Promise<number> {
  const dir = getInstallerDir()
  if (!existsSync(dir)) return 0
  let count = 0
  try {
    const files = await fsp.readdir(dir)
    for (const f of files) {
      try { await fsp.unlink(path.join(dir, f)); count++ } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return count
}
