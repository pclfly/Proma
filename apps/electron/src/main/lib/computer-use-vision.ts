/**
 * Computer Use 文字观察（macOS Apple Vision OCR）。
 *
 * 官方 0.22.0：从已确认的窗口取最新 Cua 截图，交给本地 Apple Vision helper，
 * 返回文字、置信度、截图像素坐标与 captureId；waitForText 在一次调用内轮询，
 * 最多 10 次，命中要求置信度 ≥ 0.8 且整行文字完全相等。
 *
 * 本模块同时负责 Cua 截图 + Apple Vision helper 进程接线；helper 缺失或
 * 非 macOS 时不注册工具，与官方一致。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  ComputerUseTextReadResult,
  ComputerUseTextReadStatus,
  ComputerUseVisionFrame,
  ComputerUseVisionInput,
  ComputerUseVisionRegion,
} from '@proma/shared'
import { callComputerUseDriver, type ComputerUseDriverCaller } from './computer-use-runtime'

export const COMPUTER_USE_VISION_NOTE =
  '文本框不是可点击控件。坐标仅属于本次 captureId；页面变化后重新观察。匹配仅证明文字可见，不证明任务完成。'

const MIN_VISIBLE_CONFIDENCE = 0.5
const MIN_MATCH_CONFIDENCE = 0.8
const MAX_REGIONS = 200
const MAX_ATTEMPTS = 10
const DEFAULT_WAIT_TIMEOUT_MS = 3_000

export const COMPUTER_USE_VISION_MAX_IMAGE_BYTES = 16 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** 官方窗口截图限制：≤16MB 且必须是 PNG。 */
export function isComputerUseScreenshotPng(image: Uint8Array): boolean {
  return (
    image.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => image[index] === byte)
  )
}

export function isComputerUseVisionImageSizeAllowed(byteLength: number): boolean {
  return byteLength >= PNG_SIGNATURE.length && byteLength <= COMPUTER_USE_VISION_MAX_IMAGE_BYTES
}

export function validateComputerUseVisionImage(image: Uint8Array): void {
  if (!isComputerUseVisionImageSizeAllowed(image.length) || !isComputerUseScreenshotPng(image)) {
    throw new Error('无效窗口截图')
  }
}

export interface ComputerUseVisionCaptureSize {
  screenshot_width?: unknown
  screenshot_height?: unknown
}

/**
 * OCR 结果必须与 Cua 截图尺寸一致，否则坐标不可信。
 * 官方在 observe 内比对 frame.width/height 与 capture.screenshot_width/height。
 */
export function isComputerUseVisionFrameSizeMatched(
  frame: Pick<ComputerUseVisionFrame, 'width' | 'height'>,
  capture: ComputerUseVisionCaptureSize,
): boolean {
  return frame.width === capture.screenshot_width && frame.height === capture.screenshot_height
}

export function validateComputerUseVisionFrameSize(
  frame: Pick<ComputerUseVisionFrame, 'width' | 'height'>,
  capture: ComputerUseVisionCaptureSize,
): void {
  if (!isComputerUseVisionFrameSizeMatched(frame, capture)) {
    throw new Error('OCR 与 Cua 截图尺寸不一致，请重新观察')
  }
}

/** 本机 OCR 不可用（helper 缺失、启动失败或识别超时）；本轮不再重试。 */
export class ComputerUseVisionUnavailableError extends Error {
  constructor(message = '本机 Apple Vision 暂不可用或识别超时') {
    super(message)
    this.name = 'ComputerUseVisionUnavailableError'
  }
}

export interface ComputerUseVisionFailure {
  message: string
  /** true 表示应在本轮禁用 OCR，回退 Cua 截图观察。 */
  unavailable: boolean
}

/** 工具层错误归一化：区分“本轮不可用”和普通单次失败。 */
export function describeComputerUseVisionFailure(error: unknown): ComputerUseVisionFailure {
  if (error instanceof ComputerUseVisionUnavailableError) {
    return { message: error.message, unavailable: true }
  }
  if (error instanceof Error) return { message: error.message, unavailable: false }
  return { message: String(error), unavailable: false }
}

/** 校验 ComputerUseReadText 入参；错误文案与官方一致。 */
export function validateComputerUseVisionInput(input: ComputerUseVisionInput): void {
  if (
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 0 ||
    !Number.isSafeInteger(input.windowId) ||
    input.windowId <= 0
  ) {
    throw new Error('请使用 list_windows 中的真实 PID 和窗口 ID')
  }
  if (!input.session?.trim() || input.session.length > 100) {
    throw new Error('需要当前 Cua 操作的 session')
  }
  const region = input.region
  if (region) {
    if (
      !Object.values(region).every((value) => Number.isFinite(value)) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.x + region.width > 1 ||
      region.y + region.height > 1
    ) {
      throw new Error('region 必须位于 0–1 的截图范围内')
    }
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 10_000)
  ) {
    throw new Error('timeoutMs 必须在 0–10000 之间')
  }
  if (
    input.waitForText !== undefined &&
    (!input.waitForText.trim() || input.waitForText.length > 200)
  ) {
    throw new Error('waitForText 需要 1–200 个字符')
  }
}

/** 过滤低置信度区域，按 y → x 排序；截断策略由调用方决定。 */
export function filterComputerUseVisionRegions(
  regions: readonly ComputerUseVisionRegion[],
): ComputerUseVisionRegion[] {
  return regions
    .filter((region) => region.confidence >= MIN_VISIBLE_CONFIDENCE)
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
}

/** 精确匹配完整 OCR 行；只表示文字可见，不证明任务完成。 */
export function selectComputerUseVisionMatches(
  regions: readonly ComputerUseVisionRegion[],
  waitForText: string,
): ComputerUseVisionRegion[] {
  const wanted = waitForText.trim()
  if (!wanted) return []
  return regions.filter(
    (region) => region.confidence >= MIN_MATCH_CONFIDENCE && region.text.trim() === wanted,
  )
}

export interface ComputerUseVisionObservation extends ComputerUseVisionFrame {
  captureId: string
  capturedAt: number
}

export interface ComputerUseVisionDependencies {
  now: () => number
  pause: (signal?: AbortSignal) => Promise<void>
  /** 取当前窗口截图并执行 OCR。 */
  observe: (
    input: ComputerUseVisionInput,
    signal?: AbortSignal,
  ) => Promise<ComputerUseVisionObservation>
}

/**
 * 读取窗口文字。
 *
 * - 无 waitForText：观察一次即返回 ok；
 * - 有 waitForText：命中返回 matched；否则在 timeoutMs（默认 3000ms）
 *   或 10 次尝试内每 350ms 重试一次，最终 not_found。
 */
export async function readComputerUseText(
  input: ComputerUseVisionInput,
  dependencies: ComputerUseVisionDependencies,
  signal?: AbortSignal,
): Promise<ComputerUseTextReadResult> {
  validateComputerUseVisionInput(input)
  const start = dependencies.now()
  const deadline = start + (input.waitForText ? (input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS) : 0)
  let attempts = 0

  while (true) {
    signal?.throwIfAborted()
    const frame = await dependencies.observe(input, signal)
    signal?.throwIfAborted()
    attempts += 1

    const visible = filterComputerUseVisionRegions(frame.regions)
    const matches = input.waitForText
      ? selectComputerUseVisionMatches(visible, input.waitForText)
      : []
    const elapsedMs = dependencies.now() - start
    const status: ComputerUseTextReadStatus = input.waitForText
      ? matches.length > 0
        ? 'matched'
        : 'not_found'
      : 'ok'

    if (
      !input.waitForText ||
      matches.length > 0 ||
      dependencies.now() >= deadline ||
      attempts >= MAX_ATTEMPTS
    ) {
      return {
        status,
        captureId: frame.captureId,
        capturedAt: frame.capturedAt,
        pid: input.pid,
        windowId: input.windowId,
        session: input.session,
        width: frame.width,
        height: frame.height,
        coordinateSpace: 'screenshot_pixels_top_left',
        regions: visible.slice(0, MAX_REGIONS),
        truncated: visible.length > MAX_REGIONS,
        matches,
        attempts,
        elapsedMs,
        note: COMPUTER_USE_VISION_NOTE,
      }
    }

    await dependencies.pause(signal)
  }
}

export const COMPUTER_USE_VISION_TOOL_METADATA = {
  name: 'ComputerUseReadText',
  label: '识别窗口文字',
  description:
    'macOS Apple Vision 本地 OCR：从已确认的窗口获取最新 Cua 截图，返回文字、置信度、截图像素坐标及 captureId。适合无 AX 界面的文字定位、提示验证；不返回图片、不执行点击。waitForText 可在一次调用内等待精确整段文字出现。复用操作 session，后续 Cua 像素动作绑定 capture_id。未知布局/图标/歧义仍需查看截图。',
  promptSnippet:
    'macOS 无 AX 界面的文字观察/状态检查优先用 ComputerUseReadText，必要时回退完整截图。',
} as const

const VISION_HELPER_TIMEOUT_MS = 8_000
const VISION_HELPER_MAX_BUFFER = 2 * 1024 * 1024
const VISION_MAX_IMAGE_DIMENSION = 1_600
const VISION_POLL_INTERVAL_MS = 350

function runVisionHelper(
  file: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: VISION_HELPER_TIMEOUT_MS, maxBuffer: VISION_HELPER_MAX_BUFFER, signal, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

interface NativeCaptureInfo {
  screenshot_frame_valid?: unknown
  capture_id?: unknown
  pid?: unknown
  window_id?: unknown
  screenshot_width?: unknown
  screenshot_height?: unknown
}

/** 建立真实依赖：Cua 截图 → Apple Vision helper → 结构化文字区域。 */
export function createVisionDependencies(
  helperPath: string,
  callDriver: ComputerUseDriverCaller = callComputerUseDriver,
  runHelper: typeof runVisionHelper = runVisionHelper,
): ComputerUseVisionDependencies {
  return {
    now: () => performance.now(),
    pause: (signal) => delay(VISION_POLL_INTERVAL_MS, undefined, { signal }),
    async observe(input, signal) {
      const directory = await mkdtemp(join(tmpdir(), 'proma-vision-'))
      try {
        const path = join(directory, 'frame.png')
        const capturedAt = Date.now()
        const raw = await callDriver('get_window_state', {
          pid: input.pid,
          window_id: input.windowId,
          session: input.session,
          include_accessibility_tree: false,
          screenshot_out_file: path,
          max_image_dimension: VISION_MAX_IMAGE_DIMENSION,
        }, signal)
        const capture = JSON.parse(raw) as NativeCaptureInfo
        const captureId = capture.capture_id
        if (
          capture.screenshot_frame_valid !== true
          || typeof captureId !== 'string'
          || capture.pid !== input.pid
          || capture.window_id !== input.windowId
        ) {
          throw new Error('Cua 未返回可绑定操作的有效窗口截图，请回退到原有截图观察')
        }
        const image = await readFile(path)
        validateComputerUseVisionImage(image)

        let frame: ComputerUseVisionFrame
        try {
          frame = JSON.parse(
            await runHelper(
              helperPath,
              [JSON.stringify({ path, region: input.region })],
              signal,
            ),
          ) as ComputerUseVisionFrame
        } catch (error) {
          if (signal?.aborted) throw error
          throw new ComputerUseVisionUnavailableError('本机 Apple Vision 暂不可用或识别超时')
        }
        validateComputerUseVisionFrameSize(frame, capture)
        if (!Array.isArray(frame.regions)) {
          throw new Error('OCR 与 Cua 截图尺寸不一致，请重新观察')
        }
        return { ...frame, captureId, capturedAt }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
  }
}

export interface ComputerUseVisionToolOptions {
  platform?: NodeJS.Platform
  helperExists?: (path: string) => boolean
  callDriver?: ComputerUseDriverCaller
  runHelper?: typeof runVisionHelper
}

/**
 * 官方只在 macOS 且 helper 存在时注册 OCR 工具。
 * Windows 上没有 Apple Vision，因此返回空列表，Agent 继续用 Cua 截图。
 */
export function createComputerUseVisionTools(
  helperPath: string,
  options: ComputerUseVisionToolOptions = {},
): ToolDefinition[] {
  const platform = options.platform ?? process.platform
  const helperExists = options.helperExists ?? existsSync
  if (platform !== 'darwin' || !helperExists(helperPath)) return []

  const dependencies = createVisionDependencies(
    helperPath,
    options.callDriver,
    options.runHelper,
  )
  let unavailable = false
  return [{
    name: COMPUTER_USE_VISION_TOOL_METADATA.name,
    label: COMPUTER_USE_VISION_TOOL_METADATA.label,
    description: COMPUTER_USE_VISION_TOOL_METADATA.description,
    promptSnippet: COMPUTER_USE_VISION_TOOL_METADATA.promptSnippet,
    parameters: Type.Object({
      pid: Type.Integer({ minimum: 1 }),
      windowId: Type.Integer({ minimum: 1 }),
      session: Type.String({
        minLength: 1,
        maxLength: 100,
        description: '与 Cua 操作共享的 session。由 Agent 在任务结束时 end_session。',
      }),
      region: Type.Optional(Type.Object(
        { x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() },
        { description: '可选 OCR 范围：相对整个截图左上角的 0–1 坐标，输出仍为整图像素。' },
      )),
      waitForText: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 200,
        description: '精确匹配完整 OCR 行；只表示文字可见。',
      })),
      timeoutMs: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 10_000,
        description: '重试等待预算，默认 3000ms；在途捕获/OCR 最多各需 8 秒。',
      })),
    }),
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const input = params as ComputerUseVisionInput
      validateComputerUseVisionInput(input)
      if (unavailable) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Apple Vision 本轮不可用，请继续 Cua 截图观察，无需重装或再次检查。',
          }],
          details: {},
          isError: true,
        }
      }
      try {
        const result = await readComputerUseText(input, dependencies, signal)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: {} }
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof ComputerUseVisionUnavailableError) unavailable = true
        const failure = describeComputerUseVisionFailure(error)
        return {
          content: [{ type: 'text' as const, text: `本次文字观察失败：${failure.message}。请回退 Cua 截图观察，不要重复安装。` }],
          details: {},
          isError: true,
        }
      }
    },
  } as ToolDefinition]
}
