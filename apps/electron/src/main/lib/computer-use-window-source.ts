/**
 * Computer Use 窗口源选择。
 *
 * 官方 0.22.0 用 Electron desktopCapturer 枚举窗口，并通过
 * `window:<windowId>:<0|1>` 形式的 source id 绑定目标窗口。
 * 这里把“枚举”抽成注入口：核心匹配逻辑纯函数可测，
 * Electron 适配器保留但未接入任何 IPC / 工具。
 */

import type { ComputerUseWindowSource } from '@proma/shared'

const WINDOW_SOURCE_ID = /^window:\d+:[01]$/

export function isComputerUseWindowSourceId(id: string): boolean {
  return WINDOW_SOURCE_ID.test(id)
}

/**
 * 从 source id 中取出 windowId。
 * 非窗口 source（screen:、web-contents: 等）返回 undefined。
 */
export function parseComputerUseWindowSourceWindowId(id: string): number | undefined {
  if (!isComputerUseWindowSourceId(id)) return undefined
  const raw = id.split(':')[1]
  if (raw === undefined) return undefined
  const windowId = Number(raw)
  return Number.isSafeInteger(windowId) ? windowId : undefined
}

/**
 * 在 source 列表中查找指定 windowId 的窗口源。
 * 与官方一致：先校验 id 形态，再比较解析出的 windowId。
 */
export function findComputerUseWindowSource<T extends { id: string }>(
  sources: readonly T[],
  windowId: number,
): T | undefined {
  return sources.find(
    (source) =>
      isComputerUseWindowSourceId(source.id) &&
      parseComputerUseWindowSourceWindowId(source.id) === windowId,
  )
}

export function hasComputerUseWindowSource<T extends { id: string }>(
  sources: readonly T[],
  windowId: number,
): boolean {
  return findComputerUseWindowSource(sources, windowId) !== undefined
}

export interface ComputerUseWindowSourceProbe<T extends { id: string }> {
  hasWindow: (windowId: number) => Promise<boolean>
}

/** 注入 source 枚举，便于测试与后续替换 Electron 实现。 */
export function createComputerUseWindowSourceProbe<T extends { id: string }>(
  getSources: () => Promise<readonly T[]>,
): ComputerUseWindowSourceProbe<T> {
  return {
    async hasWindow(windowId) {
      return hasComputerUseWindowSource(await getSources(), windowId)
    },
  }
}

export interface ComputerUseWindowSourceProvider {
  getSources: () => Promise<readonly ComputerUseWindowSource[]>
}

/**
 * Electron desktopCapturer 适配器（deferred）。
 *
 * 只枚举窗口 ID，不生成缩略图；当前没有调用方，等预览/流式链路整体接入时启用。
 */
export function createElectronWindowSourceProvider(): ComputerUseWindowSourceProvider {
  return {
    async getSources() {
      const { desktopCapturer } = await import('electron')
      return desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      })
    },
  }
}
