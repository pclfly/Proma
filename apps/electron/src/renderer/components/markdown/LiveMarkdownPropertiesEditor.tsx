import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { MarkdownPropertiesDocument, MarkdownPropertyChange, MarkdownPropertyEdit, MarkdownPropertyNode, MarkdownScalarType } from './live-markdown-properties'

interface PropertiesEditorProps {
  model: MarkdownPropertiesDocument
  readOnly: boolean
  onEdit: (edit: MarkdownPropertyEdit) => MarkdownPropertyChange
  onSource: () => void
}

const TYPE_LABELS: Record<MarkdownScalarType, string> = { string: '文本', number: '数字', boolean: '布尔', null: '空值' }

interface NodeProps {
  node: MarkdownPropertyNode
  readOnly: boolean
  commit: (edit: Omit<MarkdownPropertyEdit, 'expectedFrontmatter'>) => boolean
}

function propertyLabel(node: MarkdownPropertyNode): string {
  return node.path.map((part) => typeof part === 'number' ? `[${part + 1}]` : part).join('.') || 'Properties'
}

function ScalarEditor({ node, readOnly, commit }: NodeProps): React.ReactElement {
  const [draft, setDraft] = React.useState(node.value ?? '')
  const [type, setType] = React.useState<MarkdownScalarType>(node.scalarType ?? 'string')
  const label = propertyLabel(node)
  const changed = type !== node.scalarType || draft !== (node.value ?? '')
  const reset = (): void => { setDraft(node.value ?? ''); setType(node.scalarType ?? 'string') }
  return <form className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" onSubmit={(event) => {
    event.preventDefault()
    if (!readOnly && changed) commit({ kind: 'set', path: node.path, scalarType: type, value: draft })
  }}>
    <Input className="h-7 min-w-24 flex-1 text-xs" aria-label={`${label} 属性值`} value={draft}
      readOnly={readOnly || type === 'null'} spellCheck={false}
      placeholder={type === 'null' ? 'null（空值）' : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); reset() }
        if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
      }} />
    <Select value={type} disabled={readOnly} onValueChange={(value: MarkdownScalarType) => {
      setType(value)
      if (value === 'null') setDraft('')
      else if (value === 'boolean' && draft !== 'true' && draft !== 'false') setDraft('false')
      else if (value === 'number' && !draft) setDraft('0')
    }}>
      <SelectTrigger className="h-7 w-20 text-xs" aria-label={`${label} 属性类型`}><SelectValue /></SelectTrigger>
      <SelectContent>{Object.entries(TYPE_LABELS).map(([value, text]) => <SelectItem key={value} value={value}>{text}</SelectItem>)}</SelectContent>
    </Select>
    {!readOnly && <Button type="submit" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={!changed} aria-label={`应用 ${label}`}>应用</Button>}
  </form>
}

function PropertyNodeEditor({ node, readOnly, commit }: NodeProps): React.ReactElement {
  const [renaming, setRenaming] = React.useState(false)
  const [name, setName] = React.useState(node.label)
  const label = propertyLabel(node)
  const hasParent = node.path.length > 0
  const mappingChild = typeof node.path.at(-1) === 'string'
  const heading = <div className="flex min-w-0 flex-wrap items-center gap-2 py-1">
    {renaming ? <form className="flex min-w-0 items-center gap-1" onSubmit={(event) => {
      event.preventDefault()
      if (commit({ kind: 'rename', path: node.path, key: name })) setRenaming(false)
    }}>
      <Input className="h-7 w-32 text-xs" aria-label={`${label} 新名称`} value={name} onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setRenaming(false); setName(node.label) }
          if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault()
        }} />
      <Button type="submit" variant="ghost" size="sm" className="h-7 text-xs">保存名称</Button>
      <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setRenaming(false)}>取消</Button>
    </form> : <span className="min-w-16 break-all text-xs font-medium" title={label}>{node.label}</span>}
    {!readOnly && hasParent && mappingChild && !renaming && <Button type="button" variant="ghost" size="sm" className="h-6 px-1 text-[11px] text-muted-foreground" aria-label={`重命名 ${label}`} onClick={() => setRenaming(true)}>改名</Button>}
    {!readOnly && hasParent && <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-1 text-[11px] text-muted-foreground hover:text-destructive" aria-label={`删除属性 ${label}`} onClick={() => commit({ kind: 'remove', path: node.path })}>删除</Button>}
  </div>
  if (node.kind === 'scalar') return <div className="border-b border-border/30 py-1 last:border-0">{heading}<ScalarEditor node={node} readOnly={readOnly} commit={commit} /></div>
  if (node.kind === 'raw') return <div className="border-b border-border/30 py-1">{heading}<p className="text-xs text-muted-foreground">{node.reason ?? '此属性保留 YAML 源码'}</p></div>
  return <div className="min-w-0">{hasParent && heading}<details open className="min-w-0">
    <summary className="cursor-pointer py-1 text-xs text-muted-foreground" aria-label={`折叠或展开 ${label}`}>{node.kind === 'sequence' ? '列表' : '映射'} · {node.children.length} 项</summary>
    <div className={hasParent ? 'ml-2 border-l border-border/50 pl-3' : ''}>
      {node.children.length ? node.children.map((child) => <PropertyNodeEditor key={JSON.stringify(child.path)} node={child} readOnly={readOnly} commit={commit} />) : <p className="py-2 text-xs text-muted-foreground">尚无属性</p>}
      {!readOnly && <InsertProperty node={node} commit={commit} />}
    </div>
  </details></div>
}

function InsertProperty({ node, commit }: Pick<NodeProps, 'node' | 'commit'>): React.ReactElement {
  const [adding, setAdding] = React.useState(false)
  const [name, setName] = React.useState('')
  const [valueSource, setValueSource] = React.useState('""')
  const label = propertyLabel(node)
  if (!adding) return <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 text-xs" aria-label={`向 ${label} 添加${node.kind === 'sequence' ? '列表项' : '属性'}`} onClick={() => setAdding(true)}>＋ {node.kind === 'sequence' ? '添加列表项' : '添加属性'}</Button>
  return <form className="mt-2 flex flex-wrap items-center gap-1.5" aria-label={`添加到 ${label}`} onSubmit={(event) => {
    event.preventDefault()
    if (commit({ kind: 'insert', path: node.path, key: name, valueSource })) { setAdding(false); setName(''); setValueSource('""') }
  }}>
    {node.kind === 'mapping' && <Input className="h-7 w-28 text-xs" aria-label={`${label} 新属性名称`} value={name} placeholder="属性名" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} />}
    <Select value={valueSource} onValueChange={setValueSource}>
      <SelectTrigger className="h-7 w-28 text-xs" aria-label={`${label} 新值类型`}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={'""'}>文本</SelectItem><SelectItem value="0">数字</SelectItem><SelectItem value="false">布尔</SelectItem><SelectItem value="null">空值</SelectItem><SelectItem value="{}">映射</SelectItem><SelectItem value="[]">列表</SelectItem>
      </SelectContent>
    </Select>
    <Button type="submit" variant="ghost" size="sm" className="h-7 text-xs">添加</Button>
    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAdding(false)}>取消</Button>
  </form>
}

/** 本地草稿与折叠只在widget内；每次提交都是带精确首部快照的单操作。 */
export function LiveMarkdownPropertiesEditor({ model, readOnly, onEdit, onSource }: PropertiesEditorProps): React.ReactElement {
  const [error, setError] = React.useState<string | null>(null)
  const committing = React.useRef(false)
  const commit: NodeProps['commit'] = (edit) => {
    if (readOnly || committing.current) return false
    committing.current = true
    try {
      const result = onEdit({ ...edit, expectedFrontmatter: model.source })
      if (result.status === 'changed' || result.status === 'unchanged') { setError(null); return true }
      setError(result.reason ?? '无法安全修改，请编辑 YAML 源码')
      return false
    } finally { queueMicrotask(() => { committing.current = false }) }
  }
  return <section className="vault-properties" aria-label="Properties">
    <div className="vault-properties-heading"><span>Properties</span><span className="vault-properties-count">{model.root?.children.length ?? 0} 个字段</span>
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={onSource}>编辑 YAML 源码</Button>
    </div>
    <div className="vault-properties-list">{model.root && <PropertyNodeEditor node={model.root} readOnly={readOnly} commit={commit} />}</div>
    {error && <p role="status" className="px-3 pb-2 text-xs text-destructive">{error}</p>}
  </section>
}
