import { createHash, randomUUID } from 'node:crypto'

/** 读票据只绑定本次打开的目标与授权快照；不持久化，不跨工作区复用。 */
export interface KnowledgeReadTicket {
  token: string
  workspaceSlug: string
  kind: 'memory' | 'workspace_agents'
  relativePath: string
  physicalPathKey: string
  boundaryIdentity: string
  contentSha256: string
  createdAt: number
}

const MAX_TICKETS = 512
const TICKET_TTL_MS = 30 * 60 * 1000
const tickets = new Map<string, KnowledgeReadTicket>()

function prune(now: number): void {
  for (const [token, ticket] of tickets) if (now - ticket.createdAt > TICKET_TTL_MS) tickets.delete(token)
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next()
    if (oldest.done) break
    tickets.delete(oldest.value)
  }
}

export function createKnowledgeReadTicket(input: Omit<KnowledgeReadTicket, 'token' | 'createdAt' | 'contentSha256'> & { content: string }): string {
  const now = Date.now()
  prune(now)
  const token = randomUUID()
  // 只保留摘要等元数据；票据不能成为正文的第二份副本。
  tickets.set(token, {
    token,
    workspaceSlug: input.workspaceSlug,
    kind: input.kind,
    relativePath: input.relativePath,
    physicalPathKey: input.physicalPathKey,
    boundaryIdentity: input.boundaryIdentity,
    contentSha256: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    createdAt: now,
  })
  return token
}

/** 授权/撤销后旧票据永久失效：即使同一目录重新授权，旧编辑也不能带着旧票据回写。 */
export function invalidateKnowledgeReadTickets(workspaceSlug: string): void {
  for (const [token, ticket] of tickets) if (ticket.workspaceSlug === workspaceSlug) tickets.delete(token)
}

/** 保存开始时消费一次：换向、撤销授权、重读内容不同都会被拒绝，且票据不能重放。 */
export function consumeKnowledgeReadTicket(token: string, expected: Pick<KnowledgeReadTicket, 'workspaceSlug' | 'kind' | 'relativePath'>): KnowledgeReadTicket {
  const ticket = tickets.get(token)
  if (!ticket) throw new Error('记忆文件已重新载入或保存票据已过期，请重新打开')
  tickets.delete(token)
  if (Date.now() - ticket.createdAt > TICKET_TTL_MS) throw new Error('记忆文件已重新载入或保存票据已过期，请重新打开')
  if (ticket.workspaceSlug !== expected.workspaceSlug || ticket.kind !== expected.kind || ticket.relativePath !== expected.relativePath) {
    throw new Error('记忆文件保存票据与当前目标不匹配，请重新打开')
  }
  return ticket
}

/** 仅供测试断言泄漏；不暴露票据内容。 */
export function knowledgeReadTicketCount(): number { return tickets.size }
export function resetKnowledgeReadTicketsForTest(): void { tickets.clear() }
