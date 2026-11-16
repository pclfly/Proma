/**
 * Cloud 提示词类型
 */

export interface CloudPrompt {
  id: string
  title?: string
  content?: string
  [key: string]: unknown
}

export interface CloudPromptsResponse {
  items?: CloudPrompt[]
  prompts?: CloudPrompt[]
  [key: string]: unknown
}
