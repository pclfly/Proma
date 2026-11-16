/**
 * Computer Use 共享契约。
 *
 * 官方 0.22.0 在主进程实现 Cua Driver 的窗口预览、原生流采集与 macOS OCR。
 * 本地这一批只移植可测试的纯逻辑：安装探测、窗口源选择、坐标/图像校验、
 * 错误归一化与预览状态机；native 屏幕采集 / 输入注入保持接口但未启用，
 * 也不注册任何会直接操作桌面的 IPC 或工具。
 */

export const COMPUTER_USE_IPC_CHANNELS = {
  GET_INSTALLATION_STATUS: 'computer-use:get-installation-status',
  GET_SETTINGS: 'computer-use:get-settings',
  SET_DRIVER_PATH: 'computer-use:set-driver-path',
  SET_AUTHORIZATION: 'computer-use:set-authorization',
  GET_PREVIEW: 'computer-use:get-preview',
  DISMISS_PREVIEW: 'computer-use:dismiss-preview',
  ACTIVATE_PREVIEW: 'computer-use:activate-preview',
  RETRY_PREVIEW: 'computer-use:retry-preview',
  PREPARE_STREAM: 'computer-use:prepare-stream',
  FALLBACK_STREAM: 'computer-use:fallback-stream',
} as const

export type ComputerUseIpcChannel =
  (typeof COMPUTER_USE_IPC_CHANNELS)[keyof typeof COMPUTER_USE_IPC_CHANNELS]

/** 安装探测的平台标识；与 Node process.platform 解耦，便于测试注入。 */
export type ComputerUsePlatform = 'macos' | 'windows' | 'linux' | 'unsupported'

export type ComputerUseInstallationState =
  | 'installed'
  | 'not_installed'
  | 'needs_attention'
  | 'unsupported'

export interface ComputerUseInstallationSummary {
  platform: ComputerUsePlatform
  status: ComputerUseInstallationState
  /** 已解析到的 driver 绝对路径；not_installed / unsupported 时缺省。 */
  driverPath?: string
  /** `cua-driver x.y.z` 版本行；仅 installed 时存在。 */
  version?: string
}

/** 驱动错误归一化后的分类，直接用于用户可见文案与错误重试策略。 */
export type ComputerUseDriverErrorCode =
  | 'driver_not_found'
  | 'window_unavailable'
  | 'desktop_unavailable'
  | 'permission_denied'
  | 'authorization_required'
  | 'timeout'
  | 'activation_blocked'
  | 'capture_failed'
  | 'driver_error'

export interface ComputerUseBounds {
  x: number
  y: number
  width: number
  height: number
}

export type ComputerUsePreviewTarget = 'window' | 'desktop'
export type ComputerUsePreviewTransport = 'native-stream' | 'snapshot'
export type ComputerUsePreviewStatus = 'running' | 'finished' | 'error'

/** 主进程保存的预览状态；renderer 只读，窗口 ID 由主进程校验后下发。 */
export interface ComputerUsePreviewState {
  id: string
  sessionId: string
  target: ComputerUsePreviewTarget
  label: string
  transport: ComputerUsePreviewTransport
  status: ComputerUsePreviewStatus
  /** data:image/png;base64,...；仅 snapshot 传输捕获成功后存在。 */
  image?: string
  capturedAt?: number
  finishedAt?: number
  error?: string
  errorCode?: ComputerUseDriverErrorCode
}

/** ComputerUsePreview 工具的入参。 */
export interface ComputerUsePreviewRequest {
  action: 'show' | 'finish'
  target?: ComputerUsePreviewTarget
  label?: string
  pid?: number
  windowId?: number
}

/** 原生流只允许主进程当前保存的窗口目标，禁止 renderer 传入窗口 ID。 */
export interface ComputerUseWindowTarget {
  target: 'window'
  pid: number
  windowId: number
  label?: string
}

/** 窗口源的最小结构，兼容 Electron DesktopCapturerSource。 */
export interface ComputerUseWindowSource {
  id: string
  name?: string
}

/** OCR 文本区域；bounds 为截图像素坐标（左上原点）。 */
export interface ComputerUseVisionRegion {
  text: string
  confidence: number
  bounds: ComputerUseBounds
}

export interface ComputerUseVisionFrame {
  width: number
  height: number
  regions: ComputerUseVisionRegion[]
}

/** ComputerUseReadText 工具入参。 */
export interface ComputerUseVisionInput {
  pid: number
  windowId: number
  session: string
  /** 可选 OCR 范围：相对整图左上角的 0–1 坐标。 */
  region?: ComputerUseBounds
  /** 精确匹配完整 OCR 行；只表示文字可见，不证明任务完成。 */
  waitForText?: string
  /** 等待预算，0–10000ms；默认 3000ms。 */
  timeoutMs?: number
}

export type ComputerUseTextReadStatus = 'ok' | 'matched' | 'not_found'

export interface ComputerUseTextReadResult {
  status: ComputerUseTextReadStatus
  captureId: string
  capturedAt: number
  pid: number
  windowId: number
  session: string
  width: number
  height: number
  /** 坐标空间固定为截图像素、左上原点，且只对本次 captureId 有效。 */
  coordinateSpace: 'screenshot_pixels_top_left'
  regions: ComputerUseVisionRegion[]
  truncated: boolean
  matches: ComputerUseVisionRegion[]
  attempts: number
  elapsedMs: number
  note: string
}

/**
 * 用户对 Computer Use 自动控制的显式授权状态。
 * 只有 `granted` 才允许真正调用 Cua Driver 的输入动作；默认 `unrequested`。
 */
export type ComputerUseControlAuthorization = 'unrequested' | 'granted' | 'denied'

/** 设置页展示的 Computer Use 状态。 */
export interface ComputerUseSettingsState {
  installation: ComputerUseInstallationSummary
  authorization: ComputerUseControlAuthorization
  /** 用户在设置中显式覆盖的 driver 路径；未设置时由 resolver 自动探测。 */
  driverPath?: string
}
