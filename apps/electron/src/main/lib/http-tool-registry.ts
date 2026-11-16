/** 自定义HTTP工具资料投影；加载配置不执行网络请求或自动注册到Pi。 */
import type { ChatToolInfo } from '@proma/shared'
import { getChatToolsConfig } from './chat-tool-config'

export function getHttpToolInfos(): ChatToolInfo[] {
  const config = getChatToolsConfig()
  return config.customTools.map((meta) => ({
    meta,
    enabled: config.toolStates[meta.id]?.enabled ?? false,
    available: Boolean(meta.httpConfig),
  }))
}
