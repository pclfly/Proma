/**
 * Cloud 主进程服务共享类型与错误归一化
 *
 * 本轮范围：只做纯配置 / URL / 错误归一化与类型契约。
 * 真实登录态、token 持久化、后端调用与 IPC 注册均 deferred。
 */

import { isApiError } from '@proma/cloud'
import type { CloudApiErrorKind } from '@proma/cloud'

/** 未登录统一文案（与官方 cloud-notification-service 一致） */
export const CLOUD_NOT_LOGGED_IN_ERROR = '未登录'

export interface CloudServiceSuccess<T> {
  success: true
  data: T
}

export interface CloudServiceFailure {
  success: false
  error: string
  errorReason?: CloudApiErrorKind
  retryable?: boolean
}

export type CloudServiceResult<T> = CloudServiceSuccess<T> | CloudServiceFailure

/** 官方 wrapError 等价实现：优先使用结构化 Cloud 错误文案 */
export function getCloudErrorMessage(error: unknown, fallback = '未知错误'): string {
  if (isApiError(error)) return error.message
  return error instanceof Error ? error.message : fallback
}

/**
 * 官方通知 / 企业 Skills 的文案策略：只有结构化 Cloud 错误才透出 message，
 * 其它错误一律使用调用方兜底文案，避免把底层 socket/系统错误暴露给用户。
 */
export function getSafeCloudApiErrorMessage(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback
}

/**
 * 官方 toSafeAuthFailure 等价实现。
 *
 * 非结构化错误统一标记为 unknown 且 retryable = true，
 * 避免把未知失败误判为不可重试。
 */
export function toSafeAuthFailure(error: unknown, fallback: string): CloudServiceFailure {
  if (isApiError(error)) {
    return {
      success: false,
      error: error.message,
      errorReason: error.kind,
      retryable: error.retryable,
    }
  }
  return { success: false, error: fallback, errorReason: 'unknown', retryable: true }
}

/** 包装成功结果 */
export function cloudServiceSuccess<T>(data: T): CloudServiceSuccess<T> {
  return { success: true, data }
}
