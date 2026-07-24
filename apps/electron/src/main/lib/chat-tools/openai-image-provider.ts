export type ImageGenerationProvider = 'gemini' | 'openai-images'

export interface OpenAIImageGenerationInput {
  apiKey: string
  endpoint?: string
  model?: string
  prompt: string
  size?: string
  aspectRatio?: string
  defaultSize?: string
  numberOfImages?: number
  referenceImages?: OpenAIReferenceImage[]
}

export interface OpenAIReferenceImage {
  data: Uint8Array
  mediaType: string
  filename: string
}

export interface GeneratedImageData {
  base64: string
  mediaType: string
  revisedPrompt?: string
}

interface OpenAIImageResponseItem {
  b64_json?: unknown
  url?: unknown
  revised_prompt?: unknown
}

interface OpenAIImageResponse {
  data?: unknown
  error?: { message?: unknown }
}

export type ImageProviderFetch = (url: string, init?: RequestInit) => Promise<Response>

export const DEFAULT_OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations'
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2'
export const DEFAULT_OPENAI_IMAGE_SIZE = '1024x1024'

const MAX_GENERATED_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_IMAGES = 4
const OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 180_000
const SUPPORTED_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536'])

export function resolveImageGenerationProvider(credentials: Record<string, string>): ImageGenerationProvider {
  return credentials.provider === 'openai-images' ? 'openai-images' : 'gemini'
}

export function getImageFileExtension(mediaType: string): string {
  if (mediaType === 'image/jpeg') return '.jpg'
  if (mediaType === 'image/webp') return '.webp'
  return '.png'
}

export function resolveOpenAIImageEndpoint(endpoint?: string): string {
  const normalized = endpoint?.trim().replace(/\/+$/, '')
  if (!normalized) return DEFAULT_OPENAI_IMAGE_ENDPOINT
  if (/\/images\/edits$/i.test(normalized)) {
    return normalized.replace(/\/images\/edits$/i, '/images/generations')
  }
  if (/\/images\/generations$/i.test(normalized)) return normalized
  if (/\/v1$/i.test(normalized)) return `${normalized}/images/generations`
  return `${normalized}/v1/images/generations`
}

export function resolveOpenAIImageEditEndpoint(endpoint?: string): string {
  const generationEndpoint = resolveOpenAIImageEndpoint(endpoint)
  return generationEndpoint.replace(/\/images\/generations$/i, '/images/edits')
}

export function resolveOpenAIImageSize(input: {
  size?: string
  aspectRatio?: string
  defaultSize?: string
}): string {
  const requested = input.size?.trim()
  if (requested && SUPPORTED_SIZES.has(requested)) return requested

  const configured = input.defaultSize?.trim()
  if (configured && SUPPORTED_SIZES.has(configured)) return configured

  if (input.aspectRatio === '16:9' || input.aspectRatio === '4:3') return '1536x1024'
  if (input.aspectRatio === '9:16' || input.aspectRatio === '3:4') return '1024x1536'
  return DEFAULT_OPENAI_IMAGE_SIZE
}

function inferImageMediaType(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

function parseBase64Image(value: string): { base64: string; mediaType: string } {
  const dataUrlMatch = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (dataUrlMatch?.[1] && dataUrlMatch[2]) {
    return { mediaType: dataUrlMatch[1], base64: dataUrlMatch[2] }
  }
  return { base64: value, mediaType: inferImageMediaType(value) }
}

async function downloadGeneratedImage(url: string, fetcher: ImageProviderFetch): Promise<GeneratedImageData> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(OPENAI_IMAGE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`生成图片下载失败 (${response.status})`)
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error('生成图片超过 50MB 限制')
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('生成图片内容为空')
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('生成图片超过 50MB 限制')

  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim()
  return {
    base64: bytes.toString('base64'),
    mediaType: mediaType?.startsWith('image/') ? mediaType : 'image/png',
  }
}

export async function generateOpenAICompatibleImages(
  input: OpenAIImageGenerationInput,
  fetcher: ImageProviderFetch = fetch,
): Promise<GeneratedImageData[]> {
  const model = input.model?.trim() || DEFAULT_OPENAI_IMAGE_MODEL
  const imageCount = Math.min(Math.max(Math.round(input.numberOfImages ?? 1), 1), 4)
  const referenceImages = (input.referenceImages ?? []).slice(0, MAX_REFERENCE_IMAGES)
  const hasReferenceImages = referenceImages.length > 0
  const endpoint = hasReferenceImages
    ? resolveOpenAIImageEditEndpoint(input.endpoint)
    : resolveOpenAIImageEndpoint(input.endpoint)

  let body: BodyInit
  let headers: Record<string, string>
  if (hasReferenceImages) {
    const formData = new FormData()
    formData.append('model', model)
    formData.append('prompt', input.prompt)
    formData.append('size', resolveOpenAIImageSize(input))
    formData.append('input_fidelity', 'high')
    if (imageCount > 1) formData.append('n', String(imageCount))

    const imageField = referenceImages.length > 1 ? 'image[]' : 'image'
    for (const image of referenceImages) {
      if (!image.mediaType.startsWith('image/')) throw new Error('参考文件不是图片')
      if (image.data.byteLength === 0) throw new Error('参考图片内容为空')
      if (image.data.byteLength > MAX_REFERENCE_IMAGE_BYTES) throw new Error('单张参考图片超过 20MB 限制')
      formData.append(
        imageField,
        new Blob([new Uint8Array(image.data)], { type: image.mediaType }),
        image.filename,
      )
    }
    body = formData
    headers = { Authorization: `Bearer ${input.apiKey}` }
  } else {
    const requestBody: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      size: resolveOpenAIImageSize(input),
    }
    if (imageCount > 1) requestBody.n = imageCount
    body = JSON.stringify(requestBody)
    headers = {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  const response = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(OPENAI_IMAGE_REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI Images API 请求失败 (${response.status}): ${errorText.slice(0, 300)}`)
  }

  const payload = (await response.json()) as OpenAIImageResponse
  if (payload.error?.message) {
    throw new Error(`OpenAI Images API 错误: ${String(payload.error.message)}`)
  }
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error('OpenAI Images API 未返回图片')
  }

  const images: GeneratedImageData[] = []
  for (const rawItem of payload.data) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as OpenAIImageResponseItem
    const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined

    if (typeof item.b64_json === 'string' && item.b64_json.length > 0) {
      const parsed = parseBase64Image(item.b64_json)
      images.push({ ...parsed, revisedPrompt })
      continue
    }
    if (typeof item.url === 'string' && item.url.length > 0) {
      const downloaded = await downloadGeneratedImage(item.url, fetcher)
      images.push({ ...downloaded, revisedPrompt })
    }
  }

  if (images.length === 0) {
    throw new Error('OpenAI Images API 响应中没有可用的 b64_json 或 url')
  }
  return images
}
