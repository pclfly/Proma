/**
 * Nano Banana MCP Server（Agent 模式）
 *
 * 基于 Gemini Image Generation API 的内置 MCP 服务器。
 * 通过 Pi custom tool 注入到启用 Nano Banana 的 Agent 会话。
 * 支持文生图、多轮连续修改。凭据复用 chat-tools.json 配置。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, extname, resolve, isAbsolute, join, relative } from 'node:path'
import { getToolState, getToolCredentials } from '../chat-tool-config'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { saveAttachment, isImageAttachment } from '../attachment-service'
import {
  generateOpenAICompatibleImages,
  getImageFileExtension,
  resolveImageGenerationProvider,
  type OpenAIReferenceImage,
} from './openai-image-provider'

// ===== Gemini API 类型（REST API 使用 camelCase） =====

interface GeminiInlineData {
  mimeType: string
  data: string
}

interface GeminiPart {
  text?: string
  inlineData?: GeminiInlineData
  /** Gemini 多轮对话必需：模型生成图片时附带的签名，回传时原样保留 */
  thoughtSignature?: string
  /** snake_case 兼容（部分 API 版本） */
  thought_signature?: string
  /** Flash 思考模式下的 reasoning part，不应作为输出图展示 */
  thought?: boolean
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[]
    role: string
  }
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  error?: { message: string; code: number }
}

// ===== 多轮对话历史（按 sessionId 隔离） =====

const sessionHistory = new Map<string, GeminiContent[]>()

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'

// ===== MCP 内容块类型 =====

interface McpTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
  [key: string]: unknown
}

type McpContent = McpTextContent | McpImageContent

interface McpToolResult {
  content: McpContent[]
  [key: string]: unknown
}

// ===== Gemini API 调用 =====

interface AgentImageGenerationOptions {
  size?: string
  aspectRatio?: string
  imageSize?: string
  referenceImagePaths?: string[]
  cwd?: string
  allowedRoots?: string[]
  numberOfImages?: number
}

/** 已知图片扩展名 → MIME 类型映射 */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 从文件路径列表读取参考图，转换为 GeminiPart[]
 *
 * 支持绝对路径和相对路径（相对于 cwd 解析）。
 * 跳过不存在、非图片、读取失败的文件。
 */
function resolveAuthorizedReferenceImagePath(
  rawPath: string,
  cwd?: string,
  allowedRoots: string[] = [],
): string | null {
  const roots = [cwd, ...allowedRoots]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => {
      const resolved = resolve(root)
      try { return realpathSync(resolved) } catch { return resolved }
    })
  const requestedPath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)
  if (!existsSync(requestedPath)) return null
  const filePath = realpathSync(requestedPath)
  const authorized = roots.some((root) => {
    const rel = relative(root, filePath)
    return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
  })
  return authorized ? filePath : null
}

function readReferenceImages(paths: string[], cwd?: string, allowedRoots: string[] = []): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const rawPath of paths) {
    try {
      const filePath = resolveAuthorizedReferenceImagePath(rawPath, cwd, allowedRoots)
      if (!filePath) {
        console.warn(`[Nano Banana MCP] 拒绝读取不存在或授权目录外的参考图: ${rawPath}`)
        continue
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType || !isImageAttachment(mimeType)) {
        console.warn(`[Nano Banana MCP] 非图片文件，跳过: ${filePath}`)
        continue
      }
      const data = readFileSync(filePath).toString('base64')
      parts.push({ inlineData: { mimeType, data } })
    } catch (error) {
      console.warn(`[Nano Banana MCP] 读取参考图失败: ${rawPath}`, error)
    }
  }
  return parts
}

/**
 * Gemini 多轮对话中，模型响应包含 thoughtSignature 后，
 * 后续所有 user 消息的 text part 也必须携带 thoughtSignature。
 * 使用 Gemini 官方提供的跳过验证占位符。
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** 检查对话历史中是否存在 thoughtSignature */
function historyHasThoughtSignature(history: GeminiContent[]): boolean {
  return history.some((c) =>
    c.parts.some((p) => p.thoughtSignature || p.thought_signature),
  )
}

/**
 * 构建 Gemini API 请求体
 */
function buildGeminiRequest(
  prompt: string,
  referenceImageParts: GeminiPart[],
  history: GeminiContent[],
  options: { aspectRatio?: string; imageSize?: string; numberOfImages?: number },
): Record<string, unknown> {
  // 多轮对话中 model 响应含 thoughtSignature 时，新 user 的 text part 也必须带签名
  const needsSignature = history.length > 0 && historyHasThoughtSignature(history)

  const userParts: GeminiPart[] = [
    ...referenceImageParts,
    {
      text: prompt,
      ...(needsSignature && { thoughtSignature: DUMMY_THOUGHT_SIGNATURE }),
    },
  ]

  const contents: GeminiContent[] = [
    ...history,
    { role: 'user', parts: userParts },
  ]

  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  }

  const imageConfig: Record<string, unknown> = {}
  if (options.aspectRatio && options.aspectRatio !== '1:1') {
    imageConfig.aspectRatio = options.aspectRatio
  }
  if (options.imageSize && options.imageSize !== 'auto') {
    imageConfig.imageSize = options.imageSize
  }
  // NOTE: numberOfImages is kept in schema for future API support but not forwarded.
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig
  }

  return { contents, generationConfig }
}

/**
 * 调用 Gemini Image Generation API 并返回 MCP 工具结果
 */
async function callGeminiAndBuildResult(
  prompt: string,
  sessionId: string,
  options: AgentImageGenerationOptions,
): Promise<McpToolResult> {
  const credentials = getToolCredentials('nano-banana')
  const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
  const model = credentials.model?.trim() || DEFAULT_MODEL

  // 获取会话历史
  const history = sessionHistory.get(sessionId) ?? []

  // 读取参考图
  const referenceImageParts = options.referenceImagePaths?.length
    ? readReferenceImages(options.referenceImagePaths, options.cwd, options.allowedRoots)
    : []
  if (referenceImageParts.length > 0) {
    console.log(`[Nano Banana MCP] 加载了 ${referenceImageParts.length} 张参考图`)
  }

  // 构建请求
  const requestBody = buildGeminiRequest(prompt, referenceImageParts, history, {
    aspectRatio: options.aspectRatio,
    imageSize: options.imageSize,
    numberOfImages: options.numberOfImages,
  })
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${credentials.apiKey}`

  console.log(`[Nano Banana MCP] 调用 Gemini API: model=${model}, prompt="${prompt.slice(0, 50)}..."`)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Nano Banana MCP] API 请求失败 (${response.status}):`, errorText)
    return {
      content: [{ type: 'text' as const, text: `Gemini API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }],
    }
  }

  const data = (await response.json()) as GeminiResponse

  if (data.error) {
    return {
      content: [{ type: 'text' as const, text: `Gemini API 错误: ${data.error.message}` }],
    }
  }

  if (!data.candidates || data.candidates.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '未生成任何内容' }],
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- candidates[0] 已通过上方 length 检查
  const parts = data.candidates![0]!.content.parts
  console.log(`[Nano Banana MCP] 响应包含 ${parts.length} 个 parts，类型:`,
    parts.map((p) => p.inlineData ? `image(${p.inlineData.mimeType})` : `text(${(p.text ?? '').slice(0, 30)})`))

  const mcpContent: McpContent[] = []
  const textParts: string[] = []
  const savedWorkspacePaths: string[] = []

  // 解析响应：提取图片和文本（跳过 thought parts，它们是推理过程图，不作为输出）
  for (const part of parts) {
    if (part.thought) continue
    if (part.inlineData) {
      // 保存图片到附件目录（供 UI 渲染）
      const ext = part.inlineData.mimeType === 'image/jpeg' ? '.jpg' : '.png'
      const filename = `nano-banana-${randomUUID().slice(0, 8)}${ext}`
      const result = saveAttachment({
        conversationId: sessionId,
        filename,
        mediaType: part.inlineData.mimeType,
        data: part.inlineData.data,
      })

      // 同时保存到 Agent 工作 session 目录（供 Agent 直接引用）
      if (options.cwd) {
        try {
          const imgDir = join(options.cwd, 'generated-images')
          mkdirSync(imgDir, { recursive: true })
          const workspacePath = join(imgDir, filename)
          writeFileSync(workspacePath, Buffer.from(part.inlineData.data, 'base64'))
          savedWorkspacePaths.push(workspacePath)
        } catch (err) {
          console.warn(`[Nano Banana MCP] 保存图片到工作目录失败:`, err)
        }
      }

      // MCP image content block（供 SDK/模型查看）
      mcpContent.push({
        type: 'image' as const,
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType,
      })

      // 嵌入附件标记（供前端 UI 解析渲染）
      const attachmentMeta = JSON.stringify({
        localPath: result.attachment.localPath,
        filename: result.attachment.filename,
        mediaType: result.attachment.mediaType,
      })
      textParts.push(`[PROMA_IMAGE_ATTACHMENT:${attachmentMeta}]`)
    } else if (part.text) {
      textParts.push(part.text)
    }
  }

  // 更新会话历史（保留原始 parts 含 thoughtSignature，多轮编辑必需）
  const userContent: GeminiContent = { role: 'user', parts: [...referenceImageParts, { text: prompt }] }
  const modelContent: GeminiContent = { role: 'model', parts }
  const updatedHistory = [...history, userContent, modelContent]
  sessionHistory.set(sessionId, updatedHistory)

  // 在图片内容块之后追加文本摘要
  const imageCount = mcpContent.filter((c) => c.type === 'image').length
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  const summaryText = imageCount > 0
    ? `图片已生成（${imageCount} 张）${pathInfo}\n${textParts.join('\n')}`
    : textParts.join('\n') || '未生成图片内容'

  mcpContent.push({ type: 'text' as const, text: summaryText })

  return { content: mcpContent }
}

function readOpenAIReferenceImages(
  paths: string[],
  cwd?: string,
  allowedRoots: string[] = [],
): OpenAIReferenceImage[] {
  const images: OpenAIReferenceImage[] = []
  for (const rawPath of paths.slice(0, 4)) {
    try {
      const filePath = resolveAuthorizedReferenceImagePath(rawPath, cwd, allowedRoots)
      if (!filePath) {
        console.warn(`[AI 生图] 拒绝读取不存在或授权目录外的参考图: ${rawPath}`)
        continue
      }
      const mediaType = EXT_TO_MIME[extname(filePath).toLowerCase()]
      if (!mediaType || !isImageAttachment(mediaType)) {
        console.warn(`[AI 生图] 非图片参考文件，已跳过: ${filePath}`)
        continue
      }
      images.push({ data: readFileSync(filePath), mediaType, filename: basename(filePath) })
    } catch (error) {
      console.warn(`[AI 生图] 读取 OpenAI 参考图失败: ${rawPath}`, error)
    }
  }
  return images
}

async function callOpenAIImagesAndBuildResult(
  prompt: string,
  sessionId: string,
  options: AgentImageGenerationOptions,
): Promise<McpToolResult> {
  const credentials = getToolCredentials('nano-banana')
  const referenceImages = options.referenceImagePaths?.length
    ? readOpenAIReferenceImages(options.referenceImagePaths, options.cwd, options.allowedRoots)
    : []
  const images = await generateOpenAICompatibleImages({
    apiKey: credentials.apiKey ?? '',
    endpoint: credentials.baseUrl,
    model: credentials.model,
    prompt,
    size: options.size,
    aspectRatio: options.aspectRatio,
    defaultSize: credentials.defaultSize,
    numberOfImages: options.numberOfImages,
    referenceImages,
  })
  const content: McpContent[] = []
  const attachmentMarkers: string[] = []
  const savedWorkspacePaths: string[] = []
  for (const image of images) {
    const filename = `generated-image-${randomUUID().slice(0, 8)}${getImageFileExtension(image.mediaType)}`
    const result = saveAttachment({
      conversationId: sessionId,
      filename,
      mediaType: image.mediaType,
      data: image.base64,
    })
    if (options.cwd) {
      const imageDirectory = join(options.cwd, 'generated-images')
      mkdirSync(imageDirectory, { recursive: true })
      const workspacePath = join(imageDirectory, filename)
      writeFileSync(workspacePath, Buffer.from(image.base64, 'base64'))
      savedWorkspacePaths.push(workspacePath)
    }
    content.push({ type: 'image', data: image.base64, mimeType: image.mediaType })
    attachmentMarkers.push(`[PROMA_IMAGE_ATTACHMENT:${JSON.stringify({
      localPath: result.attachment.localPath,
      filename: result.attachment.filename,
      mediaType: result.attachment.mediaType,
    })}]`)
    if (image.revisedPrompt) attachmentMarkers.push(`优化后的提示词：${image.revisedPrompt}`)
  }
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((path) => `- ${path}`).join('\n')}`
    : ''
  content.push({
    type: 'text',
    text: `图片已生成（${images.length} 张）${pathInfo}\n${attachmentMarkers.join('\n')}`,
  })
  return { content }
}

export async function executeAgentImageGeneration(
  prompt: string,
  sessionId: string,
  options: AgentImageGenerationOptions,
): Promise<McpToolResult> {
  const credentials = getToolCredentials('nano-banana')
  return resolveImageGenerationProvider(credentials) === 'openai-images'
    ? callOpenAIImagesAndBuildResult(prompt, sessionId, options)
    : callGeminiAndBuildResult(prompt, sessionId, options)
}

// ===== Pi 工具注入 =====

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface PiNanoBananaToolsContext {
  sessionId: string
  agentCwd?: string
  allowedRoots?: string[]
}

function toPiToolResult(result: McpToolResult): AgentToolResult<unknown> {
  // 图片已在生成时保存为 Proma attachment，并在文本里携带渲染标记。Pi 的普通 tool
  // result 保持文本形态即可：避免把 Gemini base64 图片重复写入 Pi transcript。
  const text = result.content
    .filter((item): item is McpTextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  return {
    content: [{ type: 'text', text: text || '图片已生成。' }],
    details: { generated: result.content.some((item) => item.type === 'image') },
  } as AgentToolResult<unknown>
}

/**
 * 构建 Pi custom tool。会话历史仍按 Proma sessionId 隔离，因此连续编辑与 Claude
 * runtime 时代保持相同行为；参考图只从用户已授权的工作目录读取。
 */
export function buildPiNanoBananaTools(
  sdk: PiSdk,
  ctx: PiNanoBananaToolsContext,
): ToolDefinition[] {
  const toolState = getToolState('nano-banana')
  const credentials = getToolCredentials('nano-banana')
  if (!toolState.enabled || !credentials.apiKey) return []

  return [sdk.defineTool({
    name: 'generate_image',
    label: 'AI 生图',
    description: 'Generate finished raster images with Proma\'s configured image API. You MUST call this tool for image generation, product visuals, posters, illustrations, or image editing instead of substituting Python, HTML, SVG, or a text-only prompt. Generate at most 4 images per call. When visual consistency matters, pass the authoritative original image through referenceImagePaths.',
    promptSnippet: 'generate_image: use this tool for finished visual assets; do not replace it with scripted graphics.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Detailed description of the image to generate or edit. English descriptions work best.' }),
      referenceImagePaths: Type.Optional(Type.Array(Type.String({ description: 'Absolute or cwd-relative reference image path.' }))),
      aspectRatio: Type.Optional(Type.Union([Type.Literal('1:1'), Type.Literal('16:9'), Type.Literal('4:3'), Type.Literal('9:16'), Type.Literal('3:4')])),
      imageSize: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('1K'), Type.Literal('2K'), Type.Literal('4K')])),
      size: Type.Optional(Type.Union([
        Type.Literal('auto'),
        Type.Literal('1024x1024'),
        Type.Literal('1536x1024'),
        Type.Literal('1024x1536'),
      ])),
      numberOfImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
    }),
    async execute(_toolCallId, args) {
      try {
        const result = await executeAgentImageGeneration(String(args.prompt), ctx.sessionId, {
          size: typeof args.size === 'string' ? args.size : undefined,
          aspectRatio: typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined,
          imageSize: typeof args.imageSize === 'string' ? args.imageSize : undefined,
          referenceImagePaths: Array.isArray(args.referenceImagePaths)
            ? args.referenceImagePaths.filter((path): path is string => typeof path === 'string')
            : undefined,
          cwd: ctx.agentCwd,
          allowedRoots: ctx.allowedRoots,
          numberOfImages: typeof args.numberOfImages === 'number' ? args.numberOfImages : undefined,
        })
        return toPiToolResult(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Nano Banana Pi 工具] 执行失败:', error)
        return {
          content: [{ type: 'text', text: `图片生成失败: ${message}` }],
          details: { generated: false },
        } as AgentToolResult<unknown>
      }
    },
  })]
}

// ===== 清理 =====

/**
 * 清除 Agent 会话的生图历史（会话删除时调用）
 */
export function clearNanoBananaAgentHistory(sessionId: string): void {
  sessionHistory.delete(sessionId)
}
