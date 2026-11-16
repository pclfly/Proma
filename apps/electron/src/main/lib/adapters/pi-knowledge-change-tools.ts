/**
 * Pi 同步知识工具变更包装。
 *
 * Memory* 与 ProjectInstructions* 工具在返回前同步完成磁盘写入；
 * 包装器在 execute 前后采样目标，只把真实变化回传给上层事件总线。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TrackedKnowledgeChange } from '@proma/shared'
import type { AgentMemoryContext } from '../agent-memory'
import { createKnowledgeChangeTracker } from '../knowledge-change-tracker'

export function wrapSynchronousKnowledgeTools(
  tools: ToolDefinition[],
  memoryContext: AgentMemoryContext,
  onChanges: (changes: TrackedKnowledgeChange[]) => void = () => undefined,
): ToolDefinition[] {
  const tracker = createKnowledgeChangeTracker({
    memoryContext,
    cwd: memoryContext.projectRoot,
    onChanges,
  })
  return tools.map((tool) => ({
    ...tool,
    execute(...args: Parameters<ToolDefinition['execute']>) {
      return tracker.runSynchronous(tool.name, args[1] as Record<string, unknown>, () =>
        tool.execute(...args))
    },
  }))
}
