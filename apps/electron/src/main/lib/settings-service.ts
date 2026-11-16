/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式等）的读写。
 * 存储在 ~/.proma/settings.json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { getSettingsPath } from './config-paths'
import { DEFAULT_THEME_MODE, PERSONAL_DIRECTIVE_DEFAULT_CONTENT, normalizeProductivityToolsSettings, clampFontSize } from '../../types'
import type { AppSettings } from '../../types'
import { getTerminalProfilesForPlatform, isTerminalProfile } from '@proma/shared'

export function sanitizeWindowsTerminalProfile(input: unknown): AppSettings['lastWindowsTerminalProfile'] {
  return isTerminalProfile(input) && getTerminalProfilesForPlatform('win32').includes(input)
    ? input
    : undefined
}

/**
 * 获取应用设置
 *
 * 如果文件不存在，返回默认设置。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      gitAttributionEnabled: true,
      personalDirective: { enabled: false, content: PERSONAL_DIRECTIVE_DEFAULT_CONTENT },
      productivityTools: normalizeProductivityToolsSettings(undefined),
    }
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as Partial<AppSettings> & {
      experimentalAgentRuntimeSwitchEnabled?: boolean
      agentRuntime?: unknown
      agentChannelIds?: unknown
      builtinMcpDisabledIds?: unknown
      interfaceVariant?: unknown
      /** PR #1895 早期构建写入的无平台 profile 字段；仅在 Windows 上迁移。 */
      lastTerminalProfile?: unknown
      /** 0.22.80 灵动岛退役；读取时丢弃旧字段，避免下次写回复活。 */
      agentIsland?: unknown
    }
    // Pi-only：读取时丢弃旧 runtime selector、界面风格与 Claude 白名单，避免下次写回复活。
    const {
      experimentalAgentRuntimeSwitchEnabled: _legacyRuntimeSwitch,
      agentRuntime: _legacyAgentRuntime,
      agentChannelIds: _legacyAgentChannelIds,
      builtinMcpDisabledIds: _legacyBuiltinMcpDisabledIds,
      interfaceVariant: _legacyInterfaceVariant,
      lastTerminalProfile: legacyLastTerminalProfile,
      agentIsland: _legacyAgentIsland,
      ...settings
    } = data
    return {
      ...settings,
      themeMode: data.themeMode || DEFAULT_THEME_MODE,
      onboardingCompleted: data.onboardingCompleted ?? false,
      environmentCheckSkipped: data.environmentCheckSkipped ?? false,
      notificationsEnabled: data.notificationsEnabled ?? true,
      longTextPasteAsAttachmentEnabled: data.longTextPasteAsAttachmentEnabled ?? false,
      richTextRenderingEnabled: data.richTextRenderingEnabled ?? false,
      feishuSessionMirror: data.feishuSessionMirror ?? { mode: 'off' },
      windowsShellPreference: settings.windowsShellPreference ?? 'auto',
      lastWindowsTerminalProfile: process.platform === 'win32'
        ? sanitizeWindowsTerminalProfile(settings.lastWindowsTerminalProfile ?? legacyLastTerminalProfile)
        : undefined,
      agentThinking: settings.agentThinking ?? { type: 'adaptive' },
      // 缺省 true：老配置文件未写该字段时保持推广默认开启
      gitAttributionEnabled: settings.gitAttributionEnabled ?? true,
      // 缺省关闭：老配置文件未写该字段时保持不注入
      personalDirective: settings.personalDirective ?? { enabled: false, content: PERSONAL_DIRECTIVE_DEFAULT_CONTENT },
      // 缺省全部开启：老配置文件不会因升级意外隐藏生产力工具。
      productivityTools: normalizeProductivityToolsSettings(data.productivityTools),
    }
  } catch (error) {
    console.error('[设置] 读取失败:', error)
    return {
      themeMode: DEFAULT_THEME_MODE,
      onboardingCompleted: false,
      environmentCheckSkipped: false,
      notificationsEnabled: true,
      longTextPasteAsAttachmentEnabled: false,
      richTextRenderingEnabled: false,
      feishuSessionMirror: { mode: 'off' },
      windowsShellPreference: 'auto',
      agentThinking: { type: 'adaptive' },
      gitAttributionEnabled: true,
      personalDirective: { enabled: false, content: PERSONAL_DIRECTIVE_DEFAULT_CONTENT },
      productivityTools: normalizeProductivityToolsSettings(undefined),
    }
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const updated: AppSettings = {
    ...current,
    ...updates,
    // 字号轴写入前统一 clamp，避免手写 settings.json 或旧快照越界。
    ...(updates.contentFontSize !== undefined ? { contentFontSize: clampFontSize('content', updates.contentFontSize) } : {}),
    ...(updates.codeFontSize !== undefined ? { codeFontSize: clampFontSize('code', updates.codeFontSize) } : {}),
    ...(updates.terminalFontSize !== undefined ? { terminalFontSize: clampFontSize('terminal', updates.terminalFontSize) } : {}),
    productivityTools: updates.productivityTools === undefined
      ? normalizeProductivityToolsSettings(current.productivityTools)
      : normalizeProductivityToolsSettings({ ...current.productivityTools, ...updates.productivityTools }),
  }
  const filePath = getSettingsPath()

  try {
    writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
