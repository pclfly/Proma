import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import type { EditOperations, ToolDefinition, WriteOperations } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'
import { readKnowledgeWitness } from '../knowledge-witness'
import type {
  KnowledgeFileWitness,
  KnowledgeMutationObserver,
  KnowledgeMutationTicket,
} from '../knowledge-mutation-protocol'

function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

interface ReceiptState {
  sdkRead?: KnowledgeFileWitness
  preWrite?: KnowledgeFileWitness
  observedAfter?: KnowledgeFileWitness
  expectedAfterSha256?: string
  expectedAfterBytes?: number
  writeCount: number
}

export interface KnowledgeMutationReceipt {
  writeOperations: WriteOperations
  editOperations: EditOperations
  finish: (outcome: 'success' | 'failed' | 'aborted') => Promise<void>
  /** 观测失败绝不能改变工具结果；失败只记日志并放弃归属。 */
  abandon: () => Promise<void>
}

/**
 * 在权限批准后的真实 execute 内部登记一次提交凭据。
 *
 * - 只替换 SDK 的操作实现以取得真实前后像，不复制 Edit 的文件写入算法；
 * - 写入仍发生一次，观测失败不重试、不把成功写入伪装成工具失败；
 * - 最终成功与否只看 SDK 是否正常返回，写入完成但随后 abort 不算成功。
 */
export async function beginKnowledgeMutationReceipt(
  observer: KnowledgeMutationObserver | undefined,
  request: { toolCallId: string; toolName: 'write' | 'edit'; path: string },
  signal: AbortSignal | undefined,
): Promise<KnowledgeMutationReceipt | undefined> {
  if (!observer) return undefined
  let ticket: KnowledgeMutationTicket | null = null
  try {
    ticket = await observer.begin(request, signal)
  } catch (error) {
    console.warn('[知识变更] 登记来源凭据失败，本次不展示来源 diff:', error)
    return undefined
  }
  if (!ticket?.candidate) return undefined

  const ticketId = ticket.ticketId
  const state: ReceiptState = { writeCount: 0 }
  // 跨进程同样通过main的票据/授权校验读取；不把函数或文件正文传给utility。
  const witness = async (path: string): Promise<KnowledgeFileWitness | undefined> => observer.readWitness
    ? observer.readWitness({ ticketId, toolCallId: request.toolCallId, path }, signal)
    : readKnowledgeWitness(observer.resolveWitnessPath?.(path) ?? path).witness
  const recordWrite = async (absolutePath: string, content: string): Promise<void> => {
    try {
      if (state.writeCount === 0) state.preWrite = await witness(absolutePath)
      const raw = Buffer.from(content, 'utf8')
      state.expectedAfterSha256 = sha256(raw)
      state.expectedAfterBytes = raw.length
    } catch { /* 记录失败只影响归属 */ }
    if (signal?.aborted) throw new DOMException('知识文件写入已取消', 'AbortError')
    await writeFile(absolutePath, content, 'utf8')
    state.writeCount += 1
    try { state.observedAfter = await witness(absolutePath) } catch { /* 同上 */ }
  }

  const receipt: KnowledgeMutationReceipt = {
    writeOperations: {
      writeFile: recordWrite,
      mkdir: async (dir) => { await mkdir(dir, { recursive: true }) },
    },
    editOperations: {
      readFile: async (absolutePath) => {
        const raw = await readFile(absolutePath)
        try { state.sdkRead = await witness(absolutePath) } catch { /* 同上 */ }
        return raw
      },
      writeFile: recordWrite,
      access: async (absolutePath) => { await access(absolutePath) },
    },
    async finish(outcome) {
      try {
        await observer.finish({
          ticketId: ticket.ticketId,
          toolCallId: request.toolCallId,
          outcome,
          writeCount: state.writeCount,
          sdkRead: state.sdkRead,
          preWrite: state.preWrite,
          expectedAfterSha256: state.expectedAfterSha256,
          expectedAfterBytes: state.expectedAfterBytes,
          observedAfter: state.observedAfter,
        })
      } catch (error) {
        console.warn('[知识变更] 提交来源凭据失败，本次不展示来源 diff:', error)
      }
    },
    async abandon() {
      await receipt.finish('failed')
    },
  }
  return receipt
}

type FileToolSdk = Pick<typeof import('@earendil-works/pi-coding-agent'), 'createWriteToolDefinition' | 'createEditToolDefinition'>

/**
 * 只在权限 wrapper 判定允许之后才进入真实 execute；此处再建立提交凭据。
 * 不改变 SDK schema、参数校验、渲染器，也不改变写入次数。
 */
export function createKnowledgeAwareFileTool(
  sdk: FileToolSdk,
  cwd: string,
  toolName: 'write' | 'edit',
  observer: KnowledgeMutationObserver,
): ToolDefinition {
  const build = (receipt?: KnowledgeMutationReceipt): ToolDefinition => toolName === 'write'
    ? sdk.createWriteToolDefinition(cwd, receipt ? { operations: receipt.writeOperations } : undefined) as unknown as ToolDefinition
    : sdk.createEditToolDefinition(cwd, receipt ? { operations: receipt.editOperations } : undefined) as unknown as ToolDefinition
  const base = build()
  const wrapped = {
    ...base,
    async execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
      const rawPath = (params as { path?: unknown } | undefined)?.path
      const receipt = typeof rawPath === 'string' && rawPath
        ? await beginKnowledgeMutationReceipt(observer, { toolCallId, toolName, path: rawPath }, signal)
        : undefined
      const definition = receipt ? build(receipt) : base
      const execute = definition.execute as unknown as (
        id: string, input: unknown, abort: AbortSignal | undefined, update: unknown, context: unknown,
      ) => Promise<unknown>
      try {
        const result = await execute(toolCallId, params, signal, onUpdate, ctx)
        await receipt?.finish('success')
        return result
      } catch (error) {
        await receipt?.finish(signal?.aborted ? 'aborted' : 'failed')
        throw error
      }
    },
  }
  return wrapped as unknown as ToolDefinition
}
