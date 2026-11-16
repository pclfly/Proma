import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const tab = read('renderer/components/agent-skills/WorkspaceMemoryTab.tsx')
const windowApp = read('renderer/components/agent-skills/WorkspaceMemoryWindowApp.tsx')
const observer = read('renderer/components/agent-skills/WorkspaceMemoryChangeObserver.tsx')
const ipc = read('main/ipc.ts')
const preload = read('preload/index.ts')
const authorization = read('main/lib/workspace-knowledge-authorization.ts')
const sidePanel = read('renderer/components/agent/SidePanel.tsx')

describe('记忆外置目录授权接线', () => {
  test('Given 授权动作 When 从renderer发起 Then 只传workspaceSlug，路径由main原生picker产生', () => {
    expect(tab).toContain('authorizeWorkspaceKnowledgeDirectory(workspaceSlug)')
    expect(windowApp).toContain('authorizeWorkspaceKnowledgeDirectory(workspaceSlug)')
    expect(tab).not.toContain('authorizeWorkspaceKnowledgeDirectory(workspaceSlug, ')
    // main 自己打开选择器再 canonicalize，不接受调用方路径。
    expect(authorization).toContain('dialog.showOpenDialog')
    expect(authorization).toContain('realpathSync(selected)')
    expect(authorization).toContain('getKnownKnowledgeWorkspace(workspaceSlug)')
  })

  test('Given 授权IPC When 收到请求 Then 校验主窗顶层或该工作区记忆窗顶层', () => {
    expect(ipc).toContain('AUTHORIZE_WORKSPACE_KNOWLEDGE_DIRECTORY')
    expect(ipc).toContain('if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false')
    expect(ipc).toContain('return isWorkspaceMemoryWindowRenderer(workspaceSlug, event.sender.id)')
    expect(ipc).toContain('assertKnowledgeMemorySender(event, workspaceSlug)')
    expect(ipc).toContain('assertKnowledgeGrantSender(event, input.workspaceSlug)')
  })

  test('Given 拖拽或上下文菜单提供路径 When 附加到工作区 Then 旧IPC也await原生确认而非直接持久化', () => {
    const legacy = ipc.slice(ipc.indexOf('AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_DIRECTORY'), ipc.indexOf('AGENT_IPC_CHANNELS.DETACH_WORKSPACE_DIRECTORY'))
    expect(legacy).toContain('await confirmWorkspaceDirectoryAttachment(')
    expect(legacy).toContain('validateActor()')
    expect(legacy).not.toContain('attachWorkspaceDirectory(input.workspaceSlug, input.directoryPath)')
    expect(authorization).toContain('getKnownKnowledgeWorkspace(workspaceSlug).id !== workspaceId')
  })

  test('Given 文件面板选择附加目录 When 打开picker Then 直接走main授权并重读目录列表，拖拽仍保留', () => {
    const picker = sidePanel.slice(sidePanel.indexOf('const handleAttachWorkspaceFolder'), sidePanel.indexOf('const handleWorkspaceFoldersDropped'))
    expect(picker).toContain('authorizeWorkspaceKnowledgeDirectory(workspaceSlug)')
    expect(picker).toContain('getWorkspaceDirectories(workspaceSlug)')
    expect(picker).not.toContain('openFolderDialog()')
    expect(sidePanel).toContain('await attachWorkspaceDir(dirPath)')
  })

  test('Given 撤销授权 When 用户确认 Then 只移除授权记录并释放watcher，不删除文件', () => {
    expect(authorization).toContain('detach(workspaceSlug, directoryPath)')
    expect(authorization).not.toContain('rmSync')
    expect(ipc).toContain('releaseDirectoryWatcherIfUnreferenced(directoryPath)')
    expect(tab).toContain('撤销授权（不删除任何文件）')
  })

  test('Given 读票据 When 保存记忆 Then IPC与两个UI都透传revision', () => {
    expect(windowApp).toContain('writeWorkspaceAutoMemoryFile(workspaceSlug, savedPath, savedText, baseline.content, baseline.revision)')
    // 续票必须来自main按实际提交目标签发，不能在后台重读换绑目标。
    expect(windowApp).toContain('if (written.revision) baselineRef.current')
    expect(tab).toContain('if (!written.revision || written.requiresReopen) {')
    expect(tab).toContain('revision: written.revision')
    expect(tab).toContain('writeWorkspaceAutoMemoryFile(workspaceSlug, target.relativePath, text, baseText, target.revision)')
    expect(tab).toContain('revision: file.revision')
    expect(ipc).toContain('writeWorkspaceAutoMemoryFile(workspaceSlug, relativePath, content, expectedContent, revision)')
  })

  test('Given 授权变化事件 When 两种记忆UI收到 Then 清缓存并按当前权限重读，不静默丢稿', () => {
    // 独立窗：递增授权代际使迟到读取失效；干净清正文，脏稿隔离。
    expect(windowApp).toContain('if (change.accessChanged)')
    expect(windowApp).toContain('accessEpochRef.current += 1')
    expect(windowApp).toContain('if (dirtyRef.current) {')
    expect(windowApp).toContain('if (epoch !== accessEpochRef.current) return')
    // Tab：用授权代际而不是把 accessChanged 当普通变更；脏稿只停保存。
    expect(observer).toContain('if (change.accessChanged)')
    expect(tab).toContain('workspaceKnowledgeAccessAtom')
    expect(tab).toContain('if (saveStateRef.current.isDirty) {')
    expect(tab).toContain('await refreshAccessOnly()')
  })

  test('Given 切换文件或刷新 When 未保存失败 Then 先终止导航而不是覆盖草稿', () => {
    expect(tab).toContain('if (!await flushPendingSave()) return')
    expect(tab).toContain('if (curSaveConflict) return false')
    expect(tab).toContain("const disposition = await p")
    expect(tab).toContain("if (disposition !== 'saved') return false")
    expect(tab).toContain('const epoch = accessEpochRef.current')
    expect(tab).toContain('if (epoch !== accessEpochRef.current) return')
    expect(windowApp).toContain('if (epoch !== accessEpochRef.current) return')
  })

  test('Given 独立记忆窗口 When 展示记忆 Then 使用递归树而非拍平目录', () => {
    expect(windowApp).toContain('function MemoryTreeRow')
    expect(windowApp).toContain('{files.map((node) => (')
    expect(windowApp).not.toContain('{allFiles.map((file) => (')
    expect(windowApp).toContain("node.linkState === 'authorized'")
    expect(windowApp).toContain("const blocked = node.linkState === 'unauthorized'")
  })
})
