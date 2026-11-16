/**
 * @proma/cloud
 *
 * Proma Cloud 客户端协议骨架。
 *
 * 本轮范围：
 * - 配置解析 / URL 拼接 / 模式判定
 * - API 客户端（错误归一化、超时、401 刷新、有限重试）
 * - 认证 / 用量 / 订阅 / 账单 / 通知 / 模型 / 提示词 / API Key 的类型与薄客户端
 *
 * 不在本轮范围：
 * - 真实登录态持久化（safeStorage / 认证文件）
 * - 真实计费、支付下单、system key 轮换
 * - 主进程 IPC 注册与 UI
 */

export * from './config.ts'
export * from './mode.ts'
export * from './types/index.ts'
export * from './api/index.ts'
