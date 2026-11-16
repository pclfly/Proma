import type { PiAgentQueryOptions } from './pi-agent-adapter'

/** utility RPC 只传 JSON 数据；reasoningProfiles 原样随每轮请求传入。 */
export function serializePiQueryInput(input: PiAgentQueryOptions): Record<string, unknown> {
  const {
    abortSignal: _abortSignal,
    canUseTool: _canUseTool,
    customTools,
    onSessionId: _onSessionId,
    onPiEntryBindings: _onPiEntryBindings,
    onModelResolved: _onModelResolved,
    onContextWindow: _onContextWindow,
    onRetry: _onRetry,
    onSkillActivated: _onSkillActivated,
    onCodexOAuthCredentialsRefreshed: _onCodexOAuthCredentialsRefreshed,
    onGithubCopilotOAuthCredentialsRefreshed: _onGithubCopilotOAuthCredentialsRefreshed,
    onXaiOAuthCredentialsRefreshed: _onXaiOAuthCredentialsRefreshed,
    knowledgeMutationObserver: _knowledgeMutationObserver,
    ...serializable
  } = input
  const serializedCustomTools = (customTools ?? []).map((tool) => {
    // ToolDefinition 除 execute 外还允许 prepareArguments / prepareLoadout /
    // renderCall 等函数字段；MessagePort 不能克隆函数，必须先降为纯声明。
    const { execute: _execute, ...descriptor } = tool as unknown as Record<string, unknown>
    return JSON.parse(JSON.stringify(descriptor)) as Record<string, unknown>
  })
  const payload = {
    ...serializable,
    // 函数不能跨进程；只传声明，utility 再重建 capability RPC 代理。
    ...(input.knowledgeMutationObserver ? { knowledgeAttribution: true } : {}),
    ...(serializedCustomTools.length > 0 ? { customTools: serializedCustomTools } : {}),
  }
  // 兜底：任何嵌套字段里的函数/undefined 都不能穿过 MessagePort。
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
}
