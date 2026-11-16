import { describe, expect, test } from 'bun:test'
import { createAgentContextRequestPolicy, type ContextMessage } from './agent-context-request-policy'

const user = (text: string): ContextMessage => ({ role: 'user', content: text })
const result = (id: string, name: string, text: string): ContextMessage => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false })
const call = (id: string, name: string, args: Record<string, unknown>): ContextMessage => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] })
function text(message: ContextMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}
function reference(message: ContextMessage): string { return text(message).match(/ctx_[a-f0-9]{64}/)![0] }

const limits = { maxActiveChars: 1800, maxSingleChars: 1200, historicalPreviewChars: 100, maxArgumentChars: 400 }

describe('按需文件与工具上下文请求副本', () => {
  test('Given 新任务 When 投影历史读取 Then 用原文引用替代正文，用户要求和助手结论不变', () => {
    const messages = [user('必须保留透明背景'), call('r', 'read', { path: '/project/a.txt' }), result('r', 'read', 'secret-source\n'.repeat(900)), { role: 'assistant', content: [{ type: 'text', text: '已确认尺寸和透明背景；无需重新生成。' }] }, user('归档，不要重跑')]
    const original = JSON.stringify(messages)
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project(messages)
    expect(text(projected[2]!)).not.toContain('secret-source\nsecret-source')
    expect(text(projected[2]!)).toContain('ReadContext')
    expect(text(projected[2]!)).toContain('/project/a.txt')
    expect(projected[0]).toBe(messages[0])
    expect(projected[3]).toBe(messages[3])
    expect(projected[4]).toBe(messages[4])
    expect(JSON.stringify(messages)).toBe(original)
    expect(policy.read(reference(projected[2]!), { limit: 20 }).text).toBe('secret-source\n'.repeat(900).slice(0, 20))
  })

  test('Given 当前多个读取 When 超过工作集 Then 最近片段优先，单条与总节选有界', () => {
    const messages = [user('检查三个文件'), result('a', 'read', 'A'.repeat(1100)), result('b', 'read', 'B'.repeat(1100)), result('c', 'read', 'C'.repeat(1100))]
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project(messages)
    expect(text(projected[3]!)).toContain('C'.repeat(1100))
    expect(text(projected[1]!)).not.toContain('A'.repeat(1100))
    expect(policy.getLastProjectionStats().activeChars).toBeLessThanOrEqual(1800)
    expect(policy.getLastProjectionStats().referencedMaterials).toBeGreaterThan(0)
  })

  test('Given 旧文件选区 When 新用户任务 Then 只替换quoted_file内正文，不删除标签外要求', () => {
    const body = '这是文件数据。'.repeat(800)
    const messages = [user(`先遵守不覆盖文件。\n<quoted_file path="C:/a&amp;b.txt">\n${body}\n</quoted_file>\n禁止联网。`), user('继续归档')]
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project(messages)
    expect(text(projected[0]!)).toContain('先遵守不覆盖文件。')
    expect(text(projected[0]!)).toContain('禁止联网。')
    expect(text(projected[0]!)).toContain('C:/a&amp;b.txt')
    expect(text(projected[0]!)).not.toContain(body)
    expect(policy.read(reference(projected[0]!), { limit: 20 }).text).toBe(`\n${body}\n`.slice(0, 20))
  })

  test('Given 当前大选区和刚读取的工具片段 When 工作集紧张 Then 两者都有准备机会', () => {
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project([user(`<quoted_file path="a.txt">${'Q'.repeat(5000)}</quoted_file>检查`), result('new', 'read', 'R'.repeat(900))])
    expect(text(projected[0]!)).toContain('Q'.repeat(100))
    expect(text(projected[1]!)).toContain('R'.repeat(100))
    expect(policy.getLastProjectionStats().activeChars).toBeLessThanOrEqual(1800)
  })

  test('Given 完整内部续接 When 投影 Then 不将当前文件误作旧任务', () => {
    const continuation = '<internal>continue</internal>'
    const policy = createAgentContextRequestPolicy({ limits, internalUserPrompt: continuation })
    const messages = [user('检查'), result('a', 'read', 'current file'), user(continuation + '\n<output_format>text</output_format>')]
    expect(text(policy.project(messages)[1]!)).toContain('current file')
    expect(text(policy.project([...messages, user('用户提及' + continuation)])[1]!)).not.toContain('current file')
  })

  test('Given 长写入和已执行脚本 When 新任务 Then 参数结构和配对保留、原文可取回、未完成调用不动', () => {
    const args = { path: '/a.txt', content: 'original-write'.repeat(1000) }
    const messages = [user('创建'), call('w', 'write', args), result('w', 'write', '已写入'), user('检查'), call('pending', 'bash', { command: 'P'.repeat(10000) })]
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project(messages)
    const block = (projected[1]!.content as Array<{ id: string; name: string; arguments: Record<string, string> }>)[0]!
    expect(block.id).toBe('w')
    expect(block.name).toBe('write')
    expect(block.arguments.path).toBe('/a.txt')
    expect(block.arguments.content!.length).toBeLessThan(1000)
    expect(policy.read(reference(projected[1]!), { offset: 100, limit: 20 }).text).toBe(args.content.slice(100, 120))
    expect(projected[4]).toBe(messages[4])
    expect(projected[2]!.toolCallId).toBe('w')
    expect(args.content.length).toBe(14000)
  })

  test('Given edit多项替换 When 投影 Then 数组、键和空替换保留，长锚点有原文引用', () => {
    const messages = [user('修改'), call('e', 'edit', { path: 'x', edits: [{ oldText: 'old'.repeat(2000), newText: '' }] }), result('e', 'edit', 'done'), user('总结')]
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project(messages)
    const args = (projected[1]!.content as Array<{ arguments: { edits: Array<{ oldText: string; newText: string }> } }>)[0]!.arguments
    expect(args.edits[0]!.newText).toBe('')
    expect(args.edits[0]!.oldText).toContain('ctx_')
    expect(policy.read(reference(projected[1]!), { limit: 6 }).text).toBe('oldold')
  })

  test('Given 当前刚取回原文 When 再次请求 Then 片段可见而非立刻引用化', () => {
    const policy = createAgentContextRequestPolicy({ limits })
    const messages = [user('旧任务'), result('old', 'read', 'X'.repeat(3000)), user('核对原文')]
    const ref = reference(policy.project(messages)[1]!)
    const chunk = policy.read(ref, { offset: 2500, limit: 100 }).text
    const next = policy.project([...messages, result('fetch', 'ReadContext', chunk)])
    expect(text(next.at(-1)!)).toContain('X'.repeat(100))
  })

  test('Given 错误或短进度结果 When 投影历史 Then 保留错误标志和实际完成状态', () => {
    const error = { ...result('err', 'bash', '失败：未写入文件'), isError: true }
    const progress = result('p', 'TaskUpdate', '{"status":"completed","taskId":"one"}')
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project([user('旧任务'), error, progress, user('总结')])
    expect(projected[1]).toBe(error)
    expect(projected[2]).toBe(progress)
    expect(projected[1]!.isError).toBe(true)
  })

  test('Given 当前用户普通大段要求与system规则 When 投影 Then 不截断或猜测摘要', () => {
    const messages = [{ role: 'system', content: '规则'.repeat(6000) }, user('重要要求'.repeat(6000)), { role: 'assistant', content: [{ type: 'text', text: '决策'.repeat(6000) }] }, user('继续')]
    expect(createAgentContextRequestPolicy({ limits }).project(messages)).toEqual(messages)
  })

  test('Given 非法引用/越界参数/取消 When 取回 Then 明确拒绝，不读取任意路径', () => {
    const policy = createAgentContextRequestPolicy({ limits })
    const projected = policy.project([user('old'), result('r', 'read', 'text'.repeat(1000)), user('new')])
    const ref = reference(projected[1]!)
    expect(() => policy.read('C:/secrets.txt')).toThrow()
    expect(() => policy.read('ctx_' + '0'.repeat(64))).toThrow()
    expect(() => policy.read(ref, { offset: -1 })).toThrow()
    expect(() => policy.read(ref, { limit: 0 })).toThrow()
    expect(() => policy.read(ref, { limit: 900000 })).toThrow()
    const abort = new AbortController(); abort.abort()
    expect(() => policy.read(ref, {}, abort.signal)).toThrow('取消')
    expect(() => policy.project([], abort.signal)).toThrow('取消')
  })

  test('Given 外部原生分支原文源 When 分支变更或原文被隐藏 Then 不相信旧投影缓存', () => {
    let source = [user('old'), result('r', 'read', 'branch-private'.repeat(1000)), user('new')]
    const policy = createAgentContextRequestPolicy({ limits, getSourceMessages: () => source })
    const ref = reference(policy.project(source)[1]!)
    expect(policy.read(ref, { limit: 14 }).text).toBe('branch-private')
    const restored = createAgentContextRequestPolicy({ getSourceMessages: () => source })
    expect(restored.read(ref, { limit: 14 }).text).toBe('branch-private')
    source = [user('old')]
    expect(() => policy.read(ref)).toThrow('当前分支')
    expect(() => restored.read(ref)).toThrow('当前分支')
  })
})

describe('按需索引、压缩副本与准备边界', () => {
  test('Given 压缩后不再知道旧ref When 查询索引 Then 可发现文件和脚本快照并分页，查询本身不进入索引', () => {
    let source = [user('old'), call('r', 'read', { path: '/old/report.txt' }), result('r', 'read', 'original-file'.repeat(1000)), call('w', 'write', { path: '/old/out.txt', content: 'written-data'.repeat(1000) }), result('w', 'write', 'saved')]
    const policy = createAgentContextRequestPolicy({ getSourceMessages: () => source })
    const index = policy.list('report.txt')
    expect(index.materials).toHaveLength(1)
    const ref = index.materials[0]!.reference
    expect(policy.read(ref, { limit: 13 }).text).toBe('original-file')
    expect(policy.list('out.txt').materials[0]!.source).toContain('write')
    const first = policy.list('', { maxItems: 1 })
    expect(first.nextCursor).toBe(1)
    expect(policy.list('', { cursor: 1, maxItems: 1 }).materials).toHaveLength(1)
    source = [...source, result('index', 'ReadContext', 'index-contents'.repeat(1000))]
    expect(policy.list('').totalMatches).toBe(2)
    expect(policy.list('index-contents').materials).toHaveLength(0)
    source = [user('rewound')]
    expect(policy.list().materials).toHaveLength(0)
    expect(() => policy.read(ref)).toThrow('当前分支')
  })

  test('Given 摘要切片中只有旧user/长参数没有工具结果 When 投影摘要 Then 文件和脚本原文均不进入请求', () => {
    const body = 'FILE_SENTINEL'.repeat(10000), command = 'SCRIPT_SENTINEL'.repeat(10000)
    const messages = [user(`<quoted_file path="a.txt">${body}</quoted_file>必须保留用户要求。`), call('b', 'bash', { command })]
    const before = JSON.stringify(messages)
    const policy = createAgentContextRequestPolicy()
    const projected = policy.projectForSummary(messages)
    expect(JSON.stringify(projected)).not.toContain(body)
    expect(JSON.stringify(projected)).not.toContain(command)
    expect(JSON.stringify(projected)).toContain('必须保留用户要求。')
    expect(JSON.stringify(projected)).toContain('ctx_')
    expect(JSON.stringify(messages)).toBe(before)
  })

  test('Given 两万个未闭合标记 When 单向解析 Then 不做二次重扫且保留原文', () => {
    const malformed = '<quoted_file path="x">'.repeat(20000)
    const messages = [user(malformed)]
    const start = performance.now()
    const result = createAgentContextRequestPolicy().project(messages)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(result[0]).toBe(messages[0])
  })

  test('Given 过多文件标记或非法索引参数 When 准备 Then 明确拒绝而非静默发送全部原文', () => {
    const policy = createAgentContextRequestPolicy()
    expect(() => policy.project([user('<quoted_file path="x">a</quoted_file>'.repeat(16385))])).toThrow('上限')
    expect(() => policy.list('x'.repeat(201))).toThrow()
    expect(() => policy.list('', { maxItems: 100 })).toThrow()
    expect(() => policy.list('', { cursor: -1 })).toThrow()
  })
})

describe('原文定位与JSON参数结构', () => {
  test('Given 大文件中间的目标文本 When 索引搜索 Then 给出字符位置并只取所需片段', () => {
    const policy = createAgentContextRequestPolicy()
    const body = 'prefix'.repeat(2000) + 'needle' + 'suffix'.repeat(2000)
    policy.project([user('old'), result('r', 'read', body), user('new')])
    const found = policy.list('needle').materials[0]!
    expect(found.matchOffset).toBe(12000)
    expect(policy.read(found.reference, { offset: found.matchOffset!, limit: 6 }).text).toBe('needle')
  })

  test('Given 带__proto__数据键的JSON参数 When 裁剪长正文 Then 不改变原型或丢失参数字段', () => {
    const args = JSON.parse('{"path":"a","__proto__":{"raw":true},"content":"' + 'data'.repeat(2000) + '"}') as Record<string, unknown>
    const messages = [user('old'), call('w', 'write', args), result('w', 'write', 'saved'), user('new')]
    const projected = createAgentContextRequestPolicy().project(messages)
    const mapped = (projected[1]!.content as Array<{ arguments: Record<string, unknown> }>)[0]!.arguments
    expect(Object.hasOwn(mapped, '__proto__')).toBe(true)
    expect(mapped.__proto__).toEqual({ raw: true })
    expect(Object.getPrototypeOf(mapped)).toBe(Object.prototype)
    expect(typeof mapped.content).toBe('string')
    expect(mapped.content).not.toBe(args.content)
    expect('raw' in {}).toBe(false)
  })
})

test('Given 一万六千个有效历史选区 When 重写副本 Then 一次拼接且保留标签外要求，不反复复制整个文本', () => {
  const quoted = 'before<quoted_file path="x">data</quoted_file>after'.repeat(16000)
  const policy = createAgentContextRequestPolicy()
  const started = performance.now()
  const output = policy.project([user(quoted), user('new task')])
  expect(performance.now() - started).toBeLessThan(1500)
  const projected = text(output[0]!)
  expect(projected.match(/before/g)?.length).toBe(16000)
  expect(projected.match(/after/g)?.length).toBe(16000)
  expect(projected).not.toContain('>data</quoted_file>')
})

test('Given 超过64M的原始分支 When 按消息范围检索 Then 可发现并读取小片段，不因全分支过大永久失去恢复能力', () => {
  const large = 'x'.repeat(1_000_000)
  const small = result('small', 'read', 'small-snapshot')
  let source = [...Array.from({ length: 65 }, (_, index) => result(`r${index}`, 'read', large)), small]
  const policy = createAgentContextRequestPolicy({ getSourceMessages: () => source })
  const ref = reference(policy.project([small, user('new')])[0]!)
  expect(() => policy.list('small')).toThrow('startMessage/endMessage')
  expect(() => policy.read(ref, { limit: 1 })).toThrow('startMessage/endMessage')
  const index = policy.list('small', { startMessage: 64, endMessage: 66 })
  expect(index.materials).toHaveLength(1)
  expect(index.sourceRange.totalMessages).toBe(66)
  expect(index.materials[0]!.sourceMessage).toBe(65)
  expect(policy.read(index.materials[0]!.reference, { startMessage: 65, endMessage: 66, limit: 5 }).text).toBe('small')
  expect(() => policy.list('', { startMessage: 5, endMessage: 3 })).toThrow()
  expect(() => policy.read(ref, { startMessage: 100 })).toThrow()
  source = []
  expect(() => policy.read(ref, { startMessage: 0, endMessage: 0 })).toThrow('当前分支')
})
