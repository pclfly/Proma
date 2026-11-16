/**
 * Shared type definitions for proma
 */

// Placeholder types - will be expanded as needed
export interface Workspace {
  id: string
  name: string
  path: string
}

// 运行时相关类型
export * from './runtime'

// 渠道（AI 供应商）相关类型
export * from './channel'

// 输入框常驻额度汇总（多来源快照与 IPC 通道）
export * from './plan-quota'

// 代理配置相关类型
export * from './proxy'

// 共享消息、附件与搜索类型
export * from './message'

// Agent 相关类型
export * from './agent'
export * from './enterprise-skills'
export * from './knowledge-change'
export * from './browser'
export * from './network'
export * from './computer-use'
export * from './reasoning-profile'

// Agent Provider 适配器接口
export * from './agent-provider'
export * from './agent-runtime'
export * from './terminal'

// 环境检测相关类型
export * from './environment'

// 第三方安装包（Git、Node.js 等）相关类型
export * from './installer'

// GitHub Release 相关类型
export * from './github'

// 系统提示词相关类型
export * from './system-prompt'

// Chat 工具（function calling）相关类型
export * from './chat-tool'

// 飞书集成相关类型
export * from './feishu'

// 钉钉集成相关类型
export * from './dingtalk'

// Slack 集成相关类型
export * from './slack'

// 微信集成相关类型
export * from './wechat'

// 定时任务（Automation）相关类型
export * from './automation'
// 本地任务与日程（Planning）相关类型
export * from './planning'

// 用户授权的 Markdown Vault 相关类型
export * from './vault'
export * from './skill-usage'

// 会话变更请求（GitHub PR）相关类型
export * from './change-request'

// 每轮文件改动记录（连续改动视图）
export * from './turn-changes'
