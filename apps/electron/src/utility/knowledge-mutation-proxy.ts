import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import type { KnowledgeFileWitness, KnowledgeMutationObserver } from '../main/lib/knowledge-mutation-protocol'

export interface KnowledgeCapabilityTransport {
  (method: string, request: unknown, signal?: AbortSignal): Promise<unknown>
}

/** 只接收见证元数据，防止把正文或任意对象混入跨进程来源凭据。 */
function parseWitness(value: unknown): KnowledgeFileWitness | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.physicalPath !== 'string' || record.physicalPath.length > 32768) return undefined
  if (record.state === 'missing' || record.state === 'unsupported') {
    return { state: record.state, physicalPath: record.physicalPath }
  }
  if (record.state !== 'text' || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
    || typeof record.byteLength !== 'number' || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0
    || typeof record.version !== 'string' || !record.version) return undefined
  return { state: 'text', physicalPath: record.physicalPath, sha256: record.sha256, byteLength: record.byteLength, version: record.version }
}

/** 函数不经过structured clone；utility在所属query内重建三个capability回调。 */
export function createKnowledgeMutationProxy(send: KnowledgeCapabilityTransport): KnowledgeMutationObserver {
  return {
    async begin(request, signal) {
      const value = await send(AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_BEGIN, request, signal)
      if (!value || typeof value !== 'object') return null
      const result = value as Record<string, unknown>
      return typeof result.ticketId === 'string' && typeof result.candidate === 'boolean'
        ? { ticketId: result.ticketId, candidate: result.candidate } : null
    },
    async finish(request, signal) { await send(AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_FINISH, request, signal) },
    async readWitness(request, signal) {
      return parseWitness(await send(AGENT_RUNTIME_METHODS.CAPABILITY_KNOWLEDGE_MUTATION_WITNESS, request, signal))
    },
  }
}
