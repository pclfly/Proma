import { describe, expect, test } from 'bun:test'
import type { ImageContent } from '@earendil-works/pi-ai'
import { createAgentImageRequestBudget } from './agent-image-request-budget'

interface Message { role: string; content: unknown[]; toolCallId?: string }

/**
 * 构造一个指定原始字节数的假图片块。
 * 不调用 sharp：预算只用 base64 长度反推字节数，测试也不应依赖解码。
 */
function image(bytes = 1024): ImageContent {
  const base64Length = Math.ceil(bytes / 3) * 4
  return { type: 'image', data: 'A'.repeat(base64Length), mimeType: 'image/png' }
}
function images(messages: Message[]): ImageContent[] {
  return messages.flatMap((m) => m.content.filter((b): b is ImageContent => !!b && typeof b === 'object' && 'type' in b && b.type === 'image'))
}
function texts(messages: Message[]): string {
  return JSON.stringify(messages)
}

describe('Agent 请求图片预算', () => {
  test('Given 65个历史图片块 When 新文本任务请求 Then 不读base64且原记录保持不变', async () => {
    const block = image()
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '生成商品图' }] },
      ...Array.from({ length: 65 }, (_, i) => ({ role: 'toolResult', toolCallId: `old-${i}`, content: [block] })),
      { role: 'user', content: [{ type: 'text', text: '把通过的文件归档' }] },
    ]
    const before = JSON.stringify(messages)
    const result = await createAgentImageRequestBudget().project(messages)
    expect(images(result)).toHaveLength(0)
    expect(texts(result)).toContain('按需重新读取')
    expect(JSON.stringify(messages)).toBe(before)
    expect(result[1]!.toolCallId).toBe('old-0')
  })

  test('Given 当前附件与更新的工具图 When 数量受限 Then 当前用户附件优先且原顺序不变', async () => {
    const a = image(100), b = image(200), c = image(300)
    const messages: Message[] = [
      { role: 'user', content: [a] },
      { role: 'toolResult', content: [b, c], toolCallId: 'current' },
    ]
    const result = await createAgentImageRequestBudget({ maxRequestImages: 2 }).project(messages)
    expect(images(result)).toEqual([a, c])
    expect(result[1]!.toolCallId).toBe('current')
    expect(texts(result)).toContain('预算')
    expect(images(messages)).toEqual([a, b, c])
  })

  test('Given 同一个图片对象出现10次 When 限制图片块 Then 按出现次数限制而非对象身份绕过', async () => {
    const block = image()
    const result = await createAgentImageRequestBudget({ maxRequestImages: 3 }).project([{ role: 'user', content: Array(10).fill(block) }])
    expect(images(result)).toHaveLength(3)
    expect(result[0]!.content).toHaveLength(10)
  })

  test('Given 单图合格但合计超限 When 请求投影 Then 总图片字节仍受限', async () => {
    const block = image(1000)
    // 预算按 base64 长度反推的字节数计算，这里取其真值，确保首张恰好通过。
    const perImage = Math.floor((block.data as string).length * 3 / 4)
    const policy = createAgentImageRequestBudget({ maxRequestBytes: perImage + 1 })
    const result = await policy.project([{ role: 'user', content: [block, block, block] }])
    expect(images(result)).toHaveLength(1)
    expect(policy.getLastProjectionStats()).toMatchObject({ sentImages: 1, omittedBudget: 2 })
  })

  test('Given 一轮新增65张工具图 When 默认预算 Then 只保留最近若干张并保持原有顺序', async () => {
    const blocks = Array.from({ length: 65 }, (_, i) => image(100 + i))
    const result = await createAgentImageRequestBudget({ maxRequestImages: 6 }).project([
      { role: 'user', content: [{ type: 'text', text: '查看新图片' }] },
      { role: 'toolResult', content: blocks },
    ])
    const sent = images(result)
    expect(sent.length).toBeLessThanOrEqual(6)
    // 保留的必须是原始顺序的子序列
    const indices = sent.map((b) => blocks.indexOf(b))
    expect(indices).toEqual([...indices].sort((x, y) => x - y))
  })

  test('Given 没有user边界的工具结果 When 投影 Then 当作当前请求而非全部历史', async () => {
    const block = image()
    const messages: Message[] = [{ role: 'toolResult', content: [block] }]
    const result = await createAgentImageRequestBudget().project(messages)
    expect(result[0]).toBe(messages[0])
  })

  test('Given 请求图片预算为零 When 投影 Then 保留正文和原图但不发图片', async () => {
    const block = image()
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: '正文' }, block] }]
    const result = await createAgentImageRequestBudget({ maxRequestImages: 0 }).project(messages)
    expect(images(result)).toHaveLength(0)
    expect(result[0]!.content[0]).toEqual(messages[0]!.content[0])
    expect(messages[0]!.content[1]).toBe(block)
  })
})

describe('Agent 图片预算的成本与业务边界', () => {
  test('Given 65张都放不下的有效图 When 准备预算为3 Then 只检查有限候选', async () => {
    const block = image(1000)
    const policy = createAgentImageRequestBudget({ maxRequestBytes: 1, maxPreparedImages: 3 })
    const result = await policy.project([{ role: 'user', content: Array.from({ length: 65 }, () => block) }])
    expect(images(result)).toHaveLength(0)
    expect(policy.getLastProjectionStats()).toMatchObject({ preparedImages: 3, omittedBudget: 65 })
  })

  test('Given 六个原始附件和一个新工具图 When 继续同任务 Then 最新工具视觉证据不会饥饿', async () => {
    const originals = Array.from({ length: 6 }, (_, i) => image(100 + i))
    const fresh = image(700)
    const result = await createAgentImageRequestBudget({ maxRequestImages: 6 }).project([
      { role: 'user', content: originals },
      { role: 'toolResult', content: [fresh] },
    ])
    expect(images(result)).toContain(fresh)
  })

  test('Given 内部压缩续接 When 原任务附件仍在上下文 Then 不当成显式新用户淘汰附件', async () => {
    const original = image()
    const continuation = '<proma_compaction_continuation>internal test</proma_compaction_continuation>'
    const result = await createAgentImageRequestBudget().project([
      { role: 'user', content: [original] },
      { role: 'user', content: [{ type: 'text', text: continuation + '\n\n<output_format>test</output_format>' }] },
    ], continuation)
    expect(images(result)).toEqual([original])
  })

  test('Given 普通用户只提到内部标记 When 新任务开始 Then 不能误识别为内部续接', async () => {
    const original = image()
    const continuation = '<proma_compaction_continuation>internal test</proma_compaction_continuation>'
    const result = await createAgentImageRequestBudget().project([
      { role: 'user', content: [original] },
      { role: 'user', content: [{ type: 'text', text: '请解释' + continuation }] },
    ], continuation)
    expect(images(result)).toHaveLength(0)
  })

  test('Given 总字节只够最新工具图 When 六附件仍在 Then 工具图仍有发送机会', async () => {
    const original = image(100)
    const fresh = image(700)
    const freshBytes = Math.floor((fresh.data as string).length * 3 / 4)
    const policy = createAgentImageRequestBudget({ maxRequestBytes: freshBytes + 1 })
    const result = await policy.project([{ role: 'user', content: Array(6).fill(original) }, { role: 'toolResult', content: [fresh] }])
    expect(images(result)).toContain(fresh)
  })

  test('Given 超长历史 When 投影 Then 不调用任何图片解码或压缩', async () => {
    // 预算只按 base64 长度估算；若实现里出现解码，这个假图片会抛错。
    const fake = { type: 'image', data: 'not-real-base64!!', mimeType: 'image/png' } as unknown as ImageContent
    const messages: Message[] = [{ role: 'user', content: [fake] }]
    const result = await createAgentImageRequestBudget().project(messages)
    expect(result[0]).toBe(messages[0])
  })
})
