import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(import.meta.dir, '..', '..', '..')
const read = (relativePath: string): string =>
  readFileSync(join(appRoot, relativePath), 'utf8').replaceAll(String.fromCharCode(13), '')

describe('Agent 附件 file:* 接线', () => {
  test('Given READ_ATTACHMENT When 读取 Then 先校验会话上下文再读文件', () => {
    const ipc = read('src/main/ipc.ts')
    expect(ipc).toContain('createAttachmentContextResolver')
    expect(ipc).toContain('resolveAgentAttachmentPath')
    const readHandler = ipc.slice(ipc.indexOf('ATTACHMENT_IPC_CHANNELS.READ_ATTACHMENT'))
    expect(readHandler.slice(0, 500)).toContain('resolveAttachmentReadContext(localPath, context)')
    expect(readHandler.slice(0, 500)).toContain('readAttachmentAsBase64(localPath)')
  })

  test('Given SAVE_IMAGE_AS When 另存 Then 对话框前后各校验一次', () => {
    const ipc = read('src/main/ipc.ts')
    const start = ipc.indexOf('ATTACHMENT_IPC_CHANNELS.SAVE_IMAGE_AS')
    const handler = ipc.slice(start, start + 1800)
    expect(handler.match(/resolveAttachmentReadContext\(localPath, context\)/g)?.length).toBe(2)
    expect(handler.indexOf('showSaveDialog')).toBeGreaterThan(-1)
  })

  test('Given preload 与 renderer When 读取附件 Then 都携带 Agent 会话上下文', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('AgentAttachmentReadContext')
    expect(preload).toContain('READ_ATTACHMENT, localPath, context')
    expect(preload).toContain('SAVE_IMAGE_AS, localPath, defaultFilename, context')
    const message = read('src/renderer/components/ai-elements/message.tsx')
    expect(message).toContain('useMessageSessionId')
    expect(message).toContain('readAttachment(attachment.localPath, context)')
    const sdk = read('src/renderer/components/agent/SDKMessageRenderer.tsx')
    expect(sdk).toContain('readAttachment(file.path, context)')
    expect(sdk).toContain('saveImageAs(file.path, file.filename, attachmentContext)')
  })
})
