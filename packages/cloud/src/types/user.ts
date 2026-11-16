/**
 * Proma Cloud 认证与用户类型
 *
 * 字段形状来自官方 0.22.0 bundle 的协议使用点：
 * - `/auth/login` / `/auth/register` 返回 { user, access_token, refresh_token }
 * - `/auth/me` 返回 CloudUser
 * - 用户状态为 PENDING / APPROVED / DISABLED
 */

export type CloudUserStatus = 'PENDING' | 'APPROVED' | 'DISABLED'

export interface CloudUser {
  id: string
  email: string
  name: string
  status: CloudUserStatus
  /** 头像地址（官方同时接受 image / avatar 两种字段） */
  image?: string | null
  avatar?: string | null
}

/** 服务端原始登录/注册响应 */
export interface CloudRawAuthResponse {
  user: CloudUser
  access_token: string
  refresh_token?: string | null
}

/** 客户端归一化后的登录态 */
export interface CloudAuthSession {
  user: CloudUser
  token: string
  refreshToken: string | null
}

export interface CloudRefreshTokenResponse {
  access_token: string
  refresh_token?: string | null
}

export interface CloudLoginRequest {
  email: string
  password: string
}

export interface CloudRegisterRequest {
  email: string
  password: string
  name?: string
  /** 邮箱验证码（若注册流程要求） */
  code?: string
}

export interface CloudVerifyEmailRequest {
  email: string
  code: string
}

export interface CloudForgotPasswordRequest {
  email: string
}

export interface CloudResetPasswordRequest {
  token: string
  password: string
}

export interface CloudResendCodeRequest {
  email: string
}

export interface CloudUpdateProfileRequest {
  name?: string
  image?: string | null
}

/** Google OAuth 状态；后端可能扩展字段。 */
export interface CloudGoogleOAuthStatus {
  enabled: boolean
  [key: string]: unknown
}

/** 欢迎奖励信息；具体金额字段由后端定义。 */
export interface CloudWelcomeBonusInfo {
  total?: number
  claimed?: boolean
  [key: string]: unknown
}
