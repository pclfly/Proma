import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ChannelModel } from '@proma/shared'
import { mergeFetchedChannelModels } from './channel-model-state'

const source = readFileSync(new URL('./ChannelForm.tsx', import.meta.url), 'utf8')

describe('OAuth 异步登录保留最新上下文', () => {
  for (const [handler, end, login] of [
    ['handleCodexLogin', 'handleCancelGithubCopilotLogin', 'codexOAuthLogin'],
    ['handleGithubCopilotLogin', 'handleCancelXaiLogin', 'githubCopilotOAuthLogin'],
    ['handleXaiLogin', '/** 从供应商 API', 'xaiOAuthLogin'],
  ]) {
    test(`Given ${handler} 等待获取模型 When 用户修改上下文 Then 界面和保存使用最新值`, async () => {
      const startAt = source.indexOf(`  const ${handler} =`)
      const endAt = source.indexOf(end!.startsWith('/') ? `  ${end}` : `  const ${end} =`, startAt)
      expect(startAt).toBeGreaterThan(0)
      expect(endAt).toBeGreaterThan(startAt)
      const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(startAt, endAt))
      const original: ChannelModel[] = [{ id: 'test', name: 'Test', enabled: true, contextWindow: 64000 }]
      const modelsRef = { current: original }
      let visible: ChannelModel[] = original
      let saved: ChannelModel[] | undefined
      let resolveFetch: ((value: unknown) => void) | undefined
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve })
      const noop = () => {}
      const dependencies: Record<string, unknown> = {
        models: original, modelsRef, mergeFetchedChannelModels,
        provider: 'openai-codex', baseUrl: '', githubCopilotEnterpriseUrl: '',
        name: 'Test', enabled: true, isEdit: false, onSaved: noop,
        PROVIDER_LABELS: { 'openai-codex': 'Codex', 'github-copilot': 'Copilot', xai: 'xAI' },
        setApiKey: noop, setTestResult: noop, setFetchResult: noop,
        setModels: (models: ChannelModel[]) => { visible = models; modelsRef.current = models },
        toast: { error: noop, success: noop },
        codexLoggingInRef: { current: false }, setCodexLoggingIn: noop, setCodexDeviceCode: noop,
        githubCopilotLoggingInRef: { current: false }, setGithubCopilotLoggingIn: noop, setGithubCopilotDeviceCode: noop,
        xaiLoggingInRef: { current: false }, setXaiLoggingIn: noop, setXaiDeviceCode: noop,
        window: { electronAPI: {
          [login!]: async () => ({ success: true, credentials: 'fixture' }),
          fetchModels: () => fetchPromise,
          createChannel: async (input: { models: ChannelModel[] }) => { saved = input.models; return input },
        } },
      }
      const execute = new Function(...Object.keys(dependencies), `${js}\nreturn ${handler}`)(...Object.values(dependencies)) as () => Promise<void>
      const pending = execute()
      await Promise.resolve()
      modelsRef.current = [{ ...original[0]!, contextWindow: 96000 }]
      resolveFetch!({ success: true, models: [{ id: 'test', name: 'Test', enabled: true, builtInContextWindow: 128000 }] })
      await pending
      expect(visible[0]?.contextWindow).toBe(96000)
      expect(saved?.[0]?.contextWindow).toBe(96000)
    })
  }
})
