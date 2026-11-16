/**
 * Cloud 认证 API
 *
 * 与官方 0.22.0 `packages/cloud/src/api/auth.ts` 对齐。
 */

import type { CloudApiClient } from '../types/api.ts'
import type {
  CloudAuthSession,
  CloudForgotPasswordRequest,
  CloudGoogleOAuthStatus,
  CloudLoginRequest,
  CloudRawAuthResponse,
  CloudRefreshTokenResponse,
  CloudRegisterRequest,
  CloudResendCodeRequest,
  CloudResetPasswordRequest,
  CloudUpdateProfileRequest,
  CloudUser,
  CloudVerifyEmailRequest,
  CloudWelcomeBonusInfo,
} from '../types/user.ts'

/** 把服务端 snake_case 响应归一化为客户端登录态 */
export function transformAuthResponse(response: CloudRawAuthResponse): CloudAuthSession {
  return {
    user: response.user,
    token: response.access_token,
    refreshToken: response.refresh_token ?? null,
  }
}

/**
 * 构造 Google 登录地址。
 *
 * 与官方实现一致：仅对 redirect_url 做 URLSearchParams 编码。
 */
export function buildGoogleLoginUrl(baseUrl: string, redirectUrl = '/'): string {
  const params = new URLSearchParams({ redirect_url: redirectUrl })
  return `${baseUrl}/auth/google?${params.toString()}`
}

export interface CloudAuthApi {
  login(data: CloudLoginRequest): Promise<CloudAuthSession>
  register(data: CloudRegisterRequest): Promise<CloudAuthSession>
  verifyEmail(data: CloudVerifyEmailRequest): Promise<void>
  forgotPassword(data: CloudForgotPasswordRequest): Promise<void>
  resetPassword(data: CloudResetPasswordRequest): Promise<void>
  resendCode(data: CloudResendCodeRequest): Promise<void>
  getMe(): Promise<CloudUser>
  refreshToken(refreshToken: string): Promise<CloudRefreshTokenResponse>
  getGoogleOAuthStatus(): Promise<CloudGoogleOAuthStatus>
  getGoogleLoginUrl(baseUrl: string, redirectUrl?: string): string
  getWelcomeBonusInfo(): Promise<CloudWelcomeBonusInfo>
  updateProfile(data: CloudUpdateProfileRequest): Promise<CloudUser>
}

export function createAuthApi(client: CloudApiClient): CloudAuthApi {
  return {
    /** 登录 */
    login: async (data) => {
      const response = await client.post<CloudRawAuthResponse>('/auth/login', data)
      return transformAuthResponse(response.data)
    },
    /** 注册 */
    register: async (data) => {
      const response = await client.post<CloudRawAuthResponse>('/auth/register', data)
      return transformAuthResponse(response.data)
    },
    /** 邮箱验证 */
    verifyEmail: async (data) => {
      await client.post<unknown>('/auth/verify-email', data)
    },
    /** 忘记密码 */
    forgotPassword: async (data) => {
      await client.post<unknown>('/auth/forgot-password', data)
    },
    /** 重置密码 */
    resetPassword: async (data) => {
      await client.post<unknown>('/auth/reset-password', data)
    },
    /** 重发验证码 */
    resendCode: async (data) => {
      await client.post<unknown>('/auth/resend-code', data)
    },
    /** 获取当前用户信息 */
    getMe: async () => {
      const response = await client.get<CloudUser>('/auth/me')
      return response.data
    },
    /** 刷新 token */
    refreshToken: async (refreshToken) => {
      const response = await client.post<CloudRefreshTokenResponse>('/auth/refresh', {
        refresh_token: refreshToken,
      })
      return response.data
    },
    /** 获取 Google OAuth 状态 */
    getGoogleOAuthStatus: async () => {
      const response = await client.get<CloudGoogleOAuthStatus>('/auth/google/status')
      return response.data
    },
    /** 获取 Google 登录 URL */
    getGoogleLoginUrl: buildGoogleLoginUrl,
    /** 获取欢迎奖励信息 */
    getWelcomeBonusInfo: async () => {
      const response = await client.get<CloudWelcomeBonusInfo>('/auth/welcome-bonus')
      return response.data
    },
    /** 更新用户档案 */
    updateProfile: async (data) => {
      const response = await client.patch<CloudUser>('/user/profile', data)
      return response.data
    },
  }
}
