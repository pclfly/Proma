/**
 * Cloud 网络执行器（纯逻辑部分）
 *
 * 官方 0.22.0 通过 `system-network-runtime` 的 `getSystemFetch('cloud')`
 * 注入系统网络栈；本地只有普通 fetch，因此这里先提供可注入的执行器契约，
 * 等 P2 网络栈整体迁移后再替换实现。
 */

import type { CloudFetch, CloudFetchRunner } from '@proma/cloud'

export type { CloudFetch, CloudFetchRunner }

/**
 * 创建网络执行器。
 *
 * 与官方 `withCloudFetch` 的结构一致：调用方只拿到 fetch，不感知来源。
 */
export function createCloudFetchRunner(fetchFn: CloudFetch = globalThis.fetch): CloudFetchRunner {
  return async (work) => work(fetchFn)
}

/** 默认执行器（当前等价于 globalThis.fetch） */
export const withCloudFetch: CloudFetchRunner = createCloudFetchRunner()
