/**
 * ReasoningProfileSettings - 推理能力配置
 *
 * 在模型配置首页编辑模型推理能力配置，方便适配最新模型（打包后可改）。
 *
 * 四项配置：
 * 1. levels 档位集合
 * 2. thinkingLevelMap 档位 → 上游协议参数映射（encodings[transport].effortMap）
 * 3. reasoning 标志（模型是否支持思考）
 * 4. 模型匹配规则（matchRules → profile 命中哪个模型）
 *
 * 数据来源：~/.proma/reasoning-profiles.json（通过主进程 IPC 读写）
 */

import * as React from 'react'
import { Plus, Trash2, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ALL_THINKING_LEVELS,
  type AgentThinkingLevel,
  type ReasoningProfileConfigData,
  type ReasoningMatchRule,
  type ReasoningEncodingKind,
  type ReasoningTransport,
} from '@proma/shared'
import { SettingsSection, SettingsCard, SettingsRow, SettingsToggle } from './primitives'

/** 可编辑的 transport 协议列表 */
const TRANSPORTS: { value: ReasoningTransport; label: string }[] = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'other', label: '其他' },
]

const ENCODING_KINDS: { value: ReasoningEncodingKind; label: string }[] = [
  { value: 'adaptive-effort', label: 'adaptive-effort' },
  { value: 'deepseek-output-effort', label: 'deepseek-output-effort' },
  { value: 'openai-reasoning-effort', label: 'openai-reasoning-effort' },
  { value: 'zai-thinking-effort', label: 'zai-thinking-effort' },
]

/** 深拷贝一个 profile（避免编辑时污染共享引用） */
function cloneProfile(profile: ReasoningProfileConfigData): ReasoningProfileConfigData {
  return {
    ...profile,
    levels: [...profile.levels],
    matchRules: profile.matchRules.map((rule) => ({ ...rule })),
    encodings: Object.fromEntries(
      Object.entries(profile.encodings).map(([transport, enc]) => [
        transport,
        enc ? { ...enc, effortMap: { ...enc.effortMap } } : enc,
      ]),
    ),
  }
}

/** 生成一个全新的空白 profile */
function createBlankProfile(): ReasoningProfileConfigData {
  return {
    id: '',
    levels: ['off', 'low', 'high', 'max'],
    defaultLevel: 'high',
    reasoning: true,
    matchRules: [{ type: 'prefix', value: '' }],
    encodings: {},
  }
}

export function ReasoningProfileSettings(): React.ReactElement {
  const [profiles, setProfiles] = React.useState<ReasoningProfileConfigData[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

  const loadProfiles = React.useCallback(async (): Promise<void> => {
    try {
      const data = await window.electronAPI.getReasoningProfiles()
      setProfiles(data)
    } catch (error) {
      console.error('[推理配置] 加载失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  /** 更新某个 profile（按 id 匹配，保留未编辑的字段） */
  const updateProfile = React.useCallback((updated: ReasoningProfileConfigData): void => {
    setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
  }, [])

  /** 新增一个 profile */
  const addProfile = React.useCallback((): void => {
    const blank = createBlankProfile()
    const uniqueId = `custom-profile-${Date.now()}`
    blank.id = uniqueId
    setProfiles((prev) => [...prev, blank])
    setExpandedId(uniqueId)
  }, [])

  /** 删除一个 profile */
  const removeProfile = React.useCallback((id: string): void => {
    setProfiles((prev) => prev.filter((p) => p.id !== id))
    setExpandedId((cur) => (cur === id ? null : cur))
  }, [])

  /** 恢复为纯内置默认 */
  const restoreDefaults = React.useCallback(async (): Promise<void> => {
    if (!window.confirm('确定恢复为内置默认推理能力配置？自定义修改将被清除。')) return
    try {
      setSaving(true)
      const merged = await window.electronAPI.updateReasoningProfiles([])
      setProfiles(merged)
    } catch (error) {
      console.error('[推理配置] 恢复默认失败:', error)
    } finally {
      setSaving(false)
    }
  }, [])

  /** 保存全部 profile */
  const handleSave = React.useCallback(async (): Promise<void> => {
    // 校验 id 非空
    for (const p of profiles) {
      if (!p.id.trim()) {
        window.alert('存在未命名的 profile，请为每个 profile 填写唯一 id')
        return
      }
    }
    setSaving(true)
    try {
      const merged = await window.electronAPI.updateReasoningProfiles(profiles)
      setProfiles(merged)
    } catch (error) {
      console.error('[推理配置] 保存失败:', error)
    } finally {
      setSaving(false)
    }
  }, [profiles])

  return (
    <SettingsSection
      title="推理能力配置"
      description="自定义模型思考档位、上游协议参数、思考开关与模型匹配规则，适配最新模型。配置保存到 ~/.proma/reasoning-profiles.json，打包后也可修改。"
      action={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={restoreDefaults} disabled={saving}>
            <RotateCcw size={14} />
            <span>恢复默认</span>
          </Button>
          <Button size="sm" variant="outline" onClick={addProfile}>
            <Plus size={14} />
            <span>新增 profile</span>
          </Button>
        </div>
      }
    >
      <SettingsCard>
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
        ) : profiles.length === 0 ? (
          <div className="text-sm text-muted-foreground py-12 text-center">
            未配置任何 profile
          </div>
        ) : (
          profiles.map((profile) => (
            <ReasoningProfileRow
              key={profile.id}
              profile={profile}
              expanded={expandedId === profile.id}
              onToggleExpand={() =>
                setExpandedId((cur) => (cur === profile.id ? null : profile.id))
              }
              onChange={updateProfile}
              onRemove={() => removeProfile(profile.id)}
            />
          ))
        )}
      </SettingsCard>

      <div className="flex justify-end pt-2">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>
    </SettingsSection>
  )
}

// ===== 单个 profile 编辑行 =====

interface ReasoningProfileRowProps {
  profile: ReasoningProfileConfigData
  expanded: boolean
  onToggleExpand: () => void
  onChange: (profile: ReasoningProfileConfigData) => void
  onRemove: () => void
}

function ReasoningProfileRow({
  profile,
  expanded,
  onToggleExpand,
  onChange,
  onRemove,
}: ReasoningProfileRowProps): React.ReactElement {
  const set = (patch: Partial<ReasoningProfileConfigData>): void => {
    onChange({ ...profile, ...patch })
  }

  const setMatchRule = (index: number, patch: Partial<ReasoningMatchRule>): void => {
    const matchRules = profile.matchRules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule))
    set({ matchRules })
  }

  const setEncoding = (transport: ReasoningTransport, patch: Partial<{ kind: ReasoningEncodingKind; effortMap: Record<string, string | null> }>): void => {
    const current = profile.encodings[transport]
    const nextCurrent = current
      ? { ...current, ...patch, effortMap: { ...current.effortMap, ...patch.effortMap } }
      : { kind: patch.kind ?? 'adaptive-effort', effortMap: { ...(patch.effortMap ?? {}) } }
    set({
      encodings: {
        ...profile.encodings,
        [transport]: nextCurrent,
      },
    })
  }

  const setEffort = (transport: ReasoningTransport, level: AgentThinkingLevel, value: string | null): void => {
    const current = profile.encodings[transport]
    if (!current) return
    const effortMap = { ...current.effortMap }
    // 空字符串表示未映射：删掉该档位 key，避免空串被当成有效上游值
    if (value === '') {
      delete effortMap[level]
    } else {
      effortMap[level] = value
    }
    setEncoding(transport, { effortMap })
  }

  const removeEncoding = (transport: ReasoningTransport): void => {
    const next = { ...profile.encodings }
    delete next[transport]
    set({ encodings: next })
  }

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-3">
        <button
          onClick={onToggleExpand}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{profile.id}</div>
          <div className="text-xs text-muted-foreground truncate">
            {profile.reasoning ? '支持思考 · ' : '不支持思考 · '}
            {profile.levels.join(' / ')} · {profile.matchRules.length} 条匹配规则
          </div>
        </div>
        <button
          onClick={onRemove}
          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          title="删除"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border/60">
          <SettingsRow label="Profile ID" description="唯一标识（与运行时 profile.id 对应）">
            <Input
              className="w-64"
              value={profile.id}
              onChange={(e) => set({ id: e.target.value })}
              placeholder="如 deepseek-v4-flash"
            />
          </SettingsRow>

          <SettingsToggle
            label="支持思考 (reasoning)"
            description="模型是否支持思考。关闭后该 profile 不参与思考档位映射。"
            checked={profile.reasoning}
            onCheckedChange={(checked) => set({ reasoning: checked })}
          />

          <ProfileEditor
            profile={profile}
            set={set}
            setMatchRule={setMatchRule}
            setEffort={setEffort}
            setEncoding={setEncoding}
            removeEncoding={removeEncoding}
          />
        </div>
      )}
    </div>
  )
}

interface ProfileEditorProps {
  profile: ReasoningProfileConfigData
  set: (patch: Partial<ReasoningProfileConfigData>) => void
  setMatchRule: (index: number, patch: Partial<ReasoningMatchRule>) => void
  setEffort: (transport: ReasoningTransport, level: AgentThinkingLevel, value: string | null) => void
  setEncoding: (transport: ReasoningTransport, patch: Partial<{ kind: ReasoningEncodingKind; effortMap: Record<string, string | null> }>) => void
  removeEncoding: (transport: ReasoningTransport) => void
}

/** 档位集合、默认档位、匹配规则、协议映射的编辑区 */
function ProfileEditor({
  profile,
  set,
  setMatchRule,
  setEffort,
  setEncoding,
  removeEncoding,
}: ProfileEditorProps): React.ReactElement {
  return (
    <>
      <SettingsRow label="档位集合 (levels)" description="该 profile 可选的全部思考档位，逗号分隔">
        <Input
          className="w-64"
          value={profile.levels.join(', ')}
          onChange={(e) =>
            set({
              levels: e.target.value
                .split(/[,，]/)
                .map((s) => s.trim() as ReasoningProfileConfigData['levels'][number])
                .filter(Boolean),
            })
          }
          placeholder="off, low, high, xhigh, max"
        />
      </SettingsRow>

      <SettingsRow label="默认档位 (defaultLevel)" description="未指定思考档位时使用的默认值">
        <SelectLevel
          value={profile.defaultLevel}
          onChange={(value) => set({ defaultLevel: value })}
          options={ALL_THINKING_LEVELS}
        />
      </SettingsRow>

      {/* 匹配规则 */}
      <div className="px-4 py-3 space-y-2">
        <div>
          <div className="text-sm font-medium text-foreground">模型匹配规则 (matchRules)</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            命中这些规则的模型将应用本 profile 的档位配置
          </div>
        </div>
        {profile.matchRules.map((rule, index) => (
          <div key={index} className="flex items-center gap-2">
            <select
              className="h-9 rounded-md border border-input px-2 text-sm bg-background"
              value={rule.type}
              onChange={(e) => setMatchRule(index, { type: e.target.value as ReasoningMatchRule['type'] })}
            >
              <option value="prefix">前缀</option>
              <option value="exact">精确</option>
              <option value="regex">正则</option>
            </select>
            <Input
              className="flex-1"
              value={rule.value}
              onChange={(e) => setMatchRule(index, { value: e.target.value })}
              placeholder="如 deepseek-v4-flash"
            />
            {profile.matchRules.length > 1 && (
              <button
                onClick={() => set({ matchRules: profile.matchRules.filter((_, i) => i !== index) })}
                className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="删除规则"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => set({ matchRules: [...profile.matchRules, { type: 'prefix', value: '' }] })}
        >
          <Plus size={14} />
          <span>添加规则</span>
        </Button>
      </div>

      {/* 上游协议参数映射 (thinkingLevelMap) */}
      <div className="px-4 py-3 space-y-2">
        <div>
          <div className="text-sm font-medium text-foreground">上游协议参数映射 (thinkingLevelMap)</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            每个 transport 协议下档位 → 上游参数值的映射
          </div>
        </div>
        <EncodingEditor
          profile={profile}
          setEncoding={setEncoding}
          setEffort={setEffort}
          removeEncoding={removeEncoding}
        />
      </div>
    </>
  )
}

function EncodingEditor({
  profile,
  setEncoding,
  setEffort,
  removeEncoding,
}: {
  profile: ReasoningProfileConfigData
  setEncoding: (transport: ReasoningTransport, patch: Partial<{ kind: ReasoningEncodingKind; effortMap: Record<string, string | null> }>) => void
  setEffort: (transport: ReasoningTransport, level: AgentThinkingLevel, value: string | null) => void
  removeEncoding: (transport: ReasoningTransport) => void
}): React.ReactElement {
  const encodings = profile.encodings
  const configuredTransports = Object.keys(encodings) as ReasoningTransport[]
  const available = TRANSPORTS.filter((t) => !configuredTransports.includes(t.value))

  const addTransport = (transport: ReasoningTransport): void => {
    setEncoding(transport, { kind: 'adaptive-effort', effortMap: {} })
  }

  return (
    <div className="space-y-3">
      {configuredTransports.map((transport) => {
        const enc = encodings[transport]
        if (!enc) return null
        return (
          <div key={transport} className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{TRANSPORTS.find((t) => t.value === transport)?.label ?? transport}</span>
              <button
                onClick={() => removeEncoding(transport)}
                className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="移除协议"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-20">编码类型</label>
              <select
                className="h-9 rounded-md border border-input px-2 text-sm bg-background flex-1"
                value={enc.kind}
                onChange={(e) => setEncoding(transport, { kind: e.target.value as ReasoningEncodingKind })}
              >
                {ENCODING_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">档位 → 上游值（null 表示该档位禁用思考）</div>
              {profile.levels.map((level) => {
                const value = enc.effortMap[level] ?? ''
                return (
                  <div key={level} className="flex items-center gap-2">
                    <span className="text-xs w-16 text-muted-foreground">{level}</span>
                    <Input
                      className="flex-1 h-8"
                      value={value}
                      onChange={(e) => setEffort(transport, level, e.target.value)}
                      placeholder="留空 = 未映射，null = 禁用"
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {available.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">添加协议</span>
          <select
            className="h-9 rounded-md border border-input px-2 text-sm bg-background"
            value=""
            onChange={(e) => {
              const t = e.target.value as ReasoningTransport
              if (t) addTransport(t)
            }}
          >
            <option value="" disabled>选择 transport...</option>
            {available.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

/** 档位选择下拉 */
function SelectLevel({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: ReasoningProfileConfigData['defaultLevel']) => void
  options: readonly string[]
}): React.ReactElement {
  return (
    <select
      className="h-9 rounded-md border border-input px-2 text-sm bg-background w-64"
      value={value}
      onChange={(e) => onChange(e.target.value as ReasoningProfileConfigData['defaultLevel'])}
    >
      {options.map((level) => (
        <option key={level} value={level}>{level}</option>
      ))}
    </select>
  )
}
