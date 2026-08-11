/**
 * ToolSettings - 工具设置页
 *
 * Chat 模式工具统一管理 tab。
 * 管理联网搜索与可选工具配置。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { ExternalLink, Eye, EyeOff, Loader2, CheckCircle2, XCircle, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection, SettingsCard } from './primitives'
import { chatToolsAtom } from '@/atoms/chat-tool-atoms'
import { toolSettingsFocusAtom, type ToolSettingsFocus } from '@/atoms/settings-tab'

/** 刷新全局工具列表 atom */
async function refreshChatTools(setter: (tools: Awaited<ReturnType<typeof window.electronAPI.getChatTools>>) => void): Promise<void> {
  try {
    const tools = await window.electronAPI.getChatTools()
    setter(tools)
  } catch (err) {
    console.error('[ToolSettings] 刷新工具列表失败:', err)
  }
}

/** 联网搜索工具设置区域 */
function WebSearchSettings(): React.ReactElement {
  const [apiKey, setApiKey] = React.useState('')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)

  // 已保存的 API Key（用于判断是否有变更）
  const savedApiKeyRef = React.useRef('')

  // 从主进程加载当前配置 + 凭据
  React.useEffect(() => {
    Promise.all([
      window.electronAPI.getChatTools(),
      window.electronAPI.getChatToolCredentials('web-search'),
    ]).then(([tools, credentials]) => {
      const searchTool = tools.find((t) => t.meta.id === 'web-search')
      if (searchTool) {
        setEnabled(searchTool.enabled)
      }
      if (credentials.apiKey) {
        setApiKey(credentials.apiKey)
        savedApiKeyRef.current = credentials.apiKey
      }
    }).catch((err: unknown) => {
      console.error('[联网搜索设置] 加载失败:', err)
    }).finally(() => {
      setLoading(false)
    })
  }, [])

  /** 静默保存 API Key（blur 时触发） */
  const handleBlurSave = React.useCallback(async (): Promise<void> => {
    const trimmed = apiKey.trim()
    if (trimmed === savedApiKeyRef.current) return
    try {
      await window.electronAPI.updateChatToolCredentials('web-search', { apiKey: trimmed })
      savedApiKeyRef.current = trimmed
      // 刷新全局工具列表（available 状态可能变化）
      await refreshChatTools(setChatTools)
      toast.success('联网搜索设置已保存')
    } catch (error) {
      console.error('[联网搜索设置] 保存失败:', error)
    }
  }, [apiKey, setChatTools])

  const handleToggle = async (checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState('web-search', { enabled: checked })
      setEnabled(checked)
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[联网搜索设置] 切换失败:', error)
    }
  }

  const handleTest = async (): Promise<void> => {
    // 先保存可能的变更
    const trimmed = apiKey.trim()
    if (trimmed !== savedApiKeyRef.current) {
      try {
        await window.electronAPI.updateChatToolCredentials('web-search', { apiKey: trimmed })
        savedApiKeyRef.current = trimmed
        await refreshChatTools(setChatTools)
      } catch (error) {
        console.error('[联网搜索设置] 保存失败:', error)
      }
    }

    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testChatTool('web-search')
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }

  return (
    <SettingsSection
      title="联网搜索"
      description="启用后 AI 可以实时搜索互联网获取最新信息"
      action={
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      }
    >
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          {/* 引导说明 */}
          <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm text-muted-foreground">
            <p>联网搜索由 <span className="font-medium text-foreground">Tavily</span> 提供，启用后 AI 可以搜索互联网获取实时信息。</p>
            <p className="text-xs">配置步骤：</p>
            <ol className="text-xs list-decimal list-inside space-y-1">
              <li>
                访问{' '}
                <a
                  href="https://tavily.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  Tavily 官网
                  <ExternalLink size={10} />
                </a>
                {' '}注册账号
              </li>
              <li>在控制台获取 API Key（免费额度每月 1000 次搜索）</li>
              <li>将 API Key 填入下方，然后开启开关</li>
            </ol>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">API Key</label>
              <Button
                size="sm"
                variant="outline"
                disabled={testing || !apiKey.trim()}
                onClick={handleTest}
              >
                {testing ? <><Loader2 size={14} className="animate-spin mr-1.5" />测试中...</> : '测试连接'}
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                placeholder="tvly-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={handleBlurSave}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {testResult && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>
              {testResult.success ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

interface ImageToolCredentials extends Record<string, string> {
  provider: 'gemini' | 'openai-images'
  apiKey: string
  baseUrl: string
  model: string
  defaultSize: string
}

const EMPTY_IMAGE_TOOL_CREDENTIALS: ImageToolCredentials = {
  provider: 'gemini',
  apiKey: '',
  baseUrl: '',
  model: '',
  defaultSize: '1024x1024',
}

function normalizeImageToolCredentials(credentials: Record<string, string>): ImageToolCredentials {
  return {
    provider: credentials.provider === 'openai-images' ? 'openai-images' : 'gemini',
    apiKey: credentials.apiKey || '',
    baseUrl: credentials.baseUrl || '',
    model: credentials.model || '',
    defaultSize: credentials.defaultSize || EMPTY_IMAGE_TOOL_CREDENTIALS.defaultSize,
  }
}

function imageToolCredentialsEqual(
  left: ImageToolCredentials,
  right: ImageToolCredentials,
): boolean {
  return left.provider === right.provider
    && left.apiKey === right.apiKey
    && left.baseUrl === right.baseUrl
    && left.model === right.model
    && left.defaultSize === right.defaultSize
}

/** AI 生图工具设置区域 */
function ImageGenerationSettings(): React.ReactElement {
  const [provider, setProvider] = React.useState<ImageToolCredentials['provider']>('gemini')
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [defaultSize, setDefaultSize] = React.useState('1024x1024')
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [enabled, setEnabled] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string } | null>(null)
  const setChatTools = useSetAtom(chatToolsAtom)

  const savedCredentialsRef = React.useRef<ImageToolCredentials>(EMPTY_IMAGE_TOOL_CREDENTIALS)

  React.useEffect(() => {
    Promise.all([
      window.electronAPI.getChatTools(),
      window.electronAPI.getChatToolCredentials('nano-banana'),
    ]).then(([tools, credentials]) => {
      const tool = tools.find((t) => t.meta.id === 'nano-banana')
      if (tool) setEnabled(tool.enabled)
      const loadedCredentials = normalizeImageToolCredentials(credentials)
      setProvider(loadedCredentials.provider)
      setApiKey(loadedCredentials.apiKey)
      setBaseUrl(loadedCredentials.baseUrl)
      setModel(loadedCredentials.model)
      setDefaultSize(loadedCredentials.defaultSize)
      savedCredentialsRef.current = loadedCredentials
    }).catch((err: unknown) => {
      console.error('[AI 生图设置] 加载失败:', err)
    }).finally(() => {
      setLoading(false)
    })
  }, [])

  const currentCredentials = React.useMemo<ImageToolCredentials>(() => ({
    provider,
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    defaultSize,
  }), [apiKey, baseUrl, defaultSize, model, provider])

  const saveCredentials = React.useCallback(async (credentials: ImageToolCredentials): Promise<void> => {
    await window.electronAPI.updateChatToolCredentials('nano-banana', credentials)
    savedCredentialsRef.current = credentials
    await refreshChatTools(setChatTools)
  }, [setChatTools])

  /** 静默保存凭据（blur 时触发） */
  const handleBlurSave = React.useCallback(async (): Promise<void> => {
    if (imageToolCredentialsEqual(currentCredentials, savedCredentialsRef.current)) return
    try {
      await saveCredentials(currentCredentials)
      toast.success('AI 生图设置已保存')
    } catch (error) {
      console.error('[AI 生图设置] 保存失败:', error)
    }
  }, [currentCredentials, saveCredentials])

  const handleProviderChange = async (value: string): Promise<void> => {
    const nextProvider = value === 'openai-images' ? 'openai-images' : 'gemini'
    const nextCredentials: ImageToolCredentials = {
      ...currentCredentials,
      provider: nextProvider,
      baseUrl: '',
      model: '',
    }
    setProvider(nextProvider)
    setBaseUrl('')
    setModel('')
    setTestResult(null)
    try {
      await saveCredentials(nextCredentials)
    } catch (error) {
      console.error('[AI 生图设置] 切换提供方失败:', error)
    }
  }

  const handleDefaultSizeChange = async (value: string): Promise<void> => {
    setDefaultSize(value)
    const nextCredentials: ImageToolCredentials = {
      ...currentCredentials,
      defaultSize: value,
    }
    try {
      await saveCredentials(nextCredentials)
    } catch (error) {
      console.error('[AI 生图设置] 保存默认尺寸失败:', error)
    }
  }

  const handleToggle = async (checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState('nano-banana', { enabled: checked })
      setEnabled(checked)
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[AI 生图设置] 切换失败:', error)
    }
  }

  const handleTest = async (): Promise<void> => {
    // 先保存可能的变更
    if (!imageToolCredentialsEqual(currentCredentials, savedCredentialsRef.current)) {
      try {
        await saveCredentials(currentCredentials)
      } catch (error) {
        console.error('[AI 生图设置] 保存失败:', error)
      }
    }

    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.electronAPI.testChatTool('nano-banana')
      setTestResult(result)
    } catch (error) {
      setTestResult({ success: false, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }

  return (
    <SettingsSection
      title="AI 生图"
      description="配置 Gemini 或 OpenAI Images 兼容接口，供 Chat 与 Agent 自动调用"
      action={
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
        />
      }
    >
      <SettingsCard divided={false}>
        <div className="space-y-4 p-4">
          {/* 引导说明 */}
          <div className="rounded-lg bg-muted/50 p-3 space-y-2 text-sm text-muted-foreground">
            <p>AI 生图支持 <span className="font-medium text-foreground">Gemini Image Generation</span> 和兼容 OpenAI Images generations 协议的服务。</p>
            <p className="text-xs">Gemini 与 OpenAI Images 提供方都支持参考图编辑；开启后，AI 会在生图任务中自动调用。</p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">提供方</label>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gemini">Gemini Image Generation</SelectItem>
                <SelectItem value="openai-images">OpenAI Images 兼容接口</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">API Key</label>
              <Button
                size="sm"
                variant="outline"
                disabled={testing || !apiKey.trim()}
                onClick={handleTest}
              >
                {testing ? <><Loader2 size={14} className="animate-spin mr-1.5" />测试中...</> : '测试连接'}
              </Button>
            </div>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                placeholder={provider === 'openai-images' ? 'sk-...' : 'AIza...'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={handleBlurSave}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">API 地址</label>
            <Input
              type="text"
              placeholder={provider === 'openai-images'
                ? 'https://image.fushengyunsuan.cn/v1/images/generations'
                : 'https://generativelanguage.googleapis.com'}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={handleBlurSave}
            />
            <p className="text-xs text-muted-foreground">
              {provider === 'openai-images'
                ? '支持填写服务根地址、/v1 地址或完整的 /images/generations 地址'
                : '留空则使用 Gemini 官方地址'}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">模型</label>
            <Input
              type="text"
              placeholder={provider === 'openai-images' ? 'gpt-image-2' : 'gemini-3.1-flash-image-preview'}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={handleBlurSave}
            />
            <p className="text-xs text-muted-foreground">
              留空则使用默认模型 {provider === 'openai-images' ? 'gpt-image-2' : 'gemini-3.1-flash-image-preview'}
            </p>
          </div>

          {provider === 'openai-images' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">默认尺寸</label>
              <Select value={defaultSize} onValueChange={handleDefaultSizeChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动</SelectItem>
                  <SelectItem value="1024x1024">1024 x 1024</SelectItem>
                  <SelectItem value="1536x1024">1536 x 1024</SelectItem>
                  <SelectItem value="1024x1536">1024 x 1536</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">测试连接会按此尺寸实际生成 1 张测试图，可能产生 API 费用。</p>
            </div>
          )}

          {testResult && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${testResult.success ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-destructive/10 text-destructive'}`}>
              {testResult.success ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 自定义工具列表区域 */
function CustomToolsSection(): React.ReactElement | null {
  const tools = useAtomValue(chatToolsAtom)
  const setChatTools = useSetAtom(chatToolsAtom)

  const customTools = tools.filter((t) => t.meta.category === 'custom')
  if (customTools.length === 0) return null

  const handleToggle = async (toolId: string, checked: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateChatToolState(toolId, { enabled: checked })
      await refreshChatTools(setChatTools)
    } catch (error) {
      console.error('[自定义工具] 切换失败:', error)
    }
  }

  const handleDelete = async (toolId: string, toolName: string): Promise<void> => {
    try {
      await window.electronAPI.deleteCustomChatTool(toolId)
      await refreshChatTools(setChatTools)
      toast.success(`已删除工具: ${toolName}`)
    } catch (error) {
      console.error('[自定义工具] 删除失败:', error)
      toast.error('删除工具失败')
    }
  }

  return (
    <SettingsSection
      title="自定义工具"
      description="通过 Agent 模式创建的 HTTP API 工具"
    >
      <SettingsCard divided>
        {customTools.map((tool) => (
          <div key={tool.meta.id} className="flex items-center justify-between p-4">
            <div className="flex-1 min-w-0 mr-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{tool.meta.name}</span>
                {tool.meta.httpConfig && (
                  <span className="text-xs text-muted-foreground font-mono">
                    {tool.meta.httpConfig.method}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                {tool.meta.description}
              </p>
              {tool.meta.httpConfig && (
                <p className="text-xs text-muted-foreground/60 mt-0.5 truncate font-mono">
                  {tool.meta.httpConfig.urlTemplate}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={tool.enabled}
                onCheckedChange={(checked) => handleToggle(tool.meta.id, checked)}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => handleDelete(tool.meta.id, tool.meta.name)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}
      </SettingsCard>
    </SettingsSection>
  )
}

export function ToolSettings(): React.ReactElement {
  const [focusedTool, setFocusedTool] = useAtom(toolSettingsFocusAtom)
  const webSearchRef = React.useRef<HTMLDivElement>(null)
  const nanoBananaRef = React.useRef<HTMLDivElement>(null)
  const customToolsRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!focusedTool) return
    const refs: Record<ToolSettingsFocus, React.RefObject<HTMLDivElement>> = {
      'web-search': webSearchRef,
      'nano-banana': nanoBananaRef,
      'custom-tools': customToolsRef,
    }
    window.requestAnimationFrame(() => {
      refs[focusedTool].current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      setFocusedTool(null)
    })
  }, [focusedTool, setFocusedTool])

  return (
    <div className="space-y-8">
      {/* 联网搜索工具 */}
      <div ref={webSearchRef}>
        <WebSearchSettings />
      </div>

      {/* AI 生图工具 */}
      <div ref={nanoBananaRef}>
        <ImageGenerationSettings />
      </div>

      {/* 自定义工具 */}
      <div ref={customToolsRef}>
        <CustomToolsSection />
      </div>
    </div>
  )
}
