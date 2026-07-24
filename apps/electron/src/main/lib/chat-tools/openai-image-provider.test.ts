import { describe, expect, test } from 'bun:test'
import {
  generateOpenAICompatibleImages,
  getImageFileExtension,
  resolveImageGenerationProvider,
  resolveOpenAIImageEditEndpoint,
  resolveOpenAIImageEndpoint,
  resolveOpenAIImageSize,
  type ImageProviderFetch,
} from './openai-image-provider'

describe('OpenAI Images 兼容生图提供方', () => {
  test('Given API 根地址或完整地址 When 解析端点 Then 只补全一次 generations 路径', () => {
    expect(resolveOpenAIImageEndpoint('https://image.example.com')).toBe('https://image.example.com/v1/images/generations')
    expect(resolveOpenAIImageEndpoint('https://image.example.com/v1')).toBe('https://image.example.com/v1/images/generations')
    expect(resolveOpenAIImageEndpoint('https://image.example.com/v1/images/generations')).toBe('https://image.example.com/v1/images/generations')
    expect(resolveOpenAIImageEndpoint('https://image.example.com/v1/images/edits')).toBe('https://image.example.com/v1/images/generations')
  })

  test('Given generations 地址 When 解析参考图编辑端点 Then 替换为同级 edits 路径', () => {
    expect(resolveOpenAIImageEditEndpoint('https://image.example.com/v1/images/generations'))
      .toBe('https://image.example.com/v1/images/edits')
    expect(resolveOpenAIImageEditEndpoint('https://image.example.com/v1/images/edits'))
      .toBe('https://image.example.com/v1/images/edits')
    expect(resolveOpenAIImageEditEndpoint('https://image.example.com/v1'))
      .toBe('https://image.example.com/v1/images/edits')
  })

  test('Given 工具尺寸、默认尺寸或宽高比 When 解析尺寸 Then 按优先级选择兼容值', () => {
    expect(resolveOpenAIImageSize({ size: '1024x1536', defaultSize: '1024x1024', aspectRatio: '16:9' })).toBe('1024x1536')
    expect(resolveOpenAIImageSize({ defaultSize: '1536x1024', aspectRatio: '9:16' })).toBe('1536x1024')
    expect(resolveOpenAIImageSize({ aspectRatio: '9:16' })).toBe('1024x1536')
    expect(resolveOpenAIImageSize({})).toBe('1024x1024')
  })

  test('Given 未配置新协议 When 解析提供方 Then 保持 Gemini 向后兼容', () => {
    expect(resolveImageGenerationProvider({})).toBe('gemini')
    expect(resolveImageGenerationProvider({ provider: 'openai-images' })).toBe('openai-images')
  })

  test('Given 图片 MIME 类型 When 生成文件名 Then 使用匹配的扩展名', () => {
    expect(getImageFileExtension('image/jpeg')).toBe('.jpg')
    expect(getImageFileExtension('image/webp')).toBe('.webp')
    expect(getImageFileExtension('image/png')).toBe('.png')
  })

  test('Given b64_json 响应 When 调用生图 Then 携带 Bearer 请求并返回可保存图片', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: ImageProviderFetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', revised_prompt: 'revised' }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    const images = await generateOpenAICompatibleImages({
      apiKey: 'TOKEN',
      endpoint: 'https://image.example.com/v1/images/generations',
      model: 'gpt-image-2',
      prompt: 'a cat on the moon',
      size: '1024x1024',
    }, fetcher)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://image.example.com/v1/images/generations')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'a cat on the moon',
      size: '1024x1024',
    })
    expect(images).toEqual([{
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      mediaType: 'image/png',
      revisedPrompt: 'revised',
    }])
  })

  test('Given URL 响应 When 调用生图 Then 下载图片并保留 MIME 类型', async () => {
    const fetcher: ImageProviderFetch = async (url) => {
      if (url === 'https://cdn.example.com/generated.jpg') {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          headers: { 'Content-Type': 'image/jpeg' },
        })
      }
      return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example.com/generated.jpg' }] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const images = await generateOpenAICompatibleImages({
      apiKey: 'TOKEN',
      endpoint: 'https://image.example.com',
      prompt: 'test',
    }, fetcher)

    expect(images).toEqual([{
      base64: '/9j/',
      mediaType: 'image/jpeg',
      revisedPrompt: undefined,
    }])
  })

  test('Given 原始产品参考图 When 调用生图 Then 使用 edits multipart 与高保真输入', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: ImageProviderFetch = async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    await generateOpenAICompatibleImages({
      apiKey: 'TOKEN',
      endpoint: 'https://image.example.com/v1/images/generations',
      prompt: 'Keep the exact product identity and change only the background',
      referenceImages: [{
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mediaType: 'image/png',
        filename: 'product.png',
      }],
    }, fetcher)

    const request = calls[0]
    const formData = request?.init?.body as FormData
    expect(request?.url).toBe('https://image.example.com/v1/images/edits')
    expect((request?.init?.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    expect(formData.get('model')).toBe('gpt-image-2')
    expect(formData.get('input_fidelity')).toBe('high')
    expect(formData.get('image')).toBeInstanceOf(Blob)
  })
})
