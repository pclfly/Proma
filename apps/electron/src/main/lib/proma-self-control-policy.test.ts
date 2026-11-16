import { describe, expect, test } from 'bun:test'
import {
  PROMA_SELF_CONTROL_ERRORS,
  PROMA_SELF_PROJECT_CREATION_SELECTORS,
  PROMA_SELF_PROTECTED_SELECTORS,
  buildPromaSelfControlGuardSource,
  buildPromaSelfGuardFactorySource,
  buildPromaSelfGuardProbeSource,
  isPromaSelfControlActionLabelProtected,
  isPromaSelfControlAxNodeProtected,
  isPromaSelfControlNodeProjectCreation,
  isPromaSelfControlNodeProtected,
  isPromaSelfControlProjectCreationLabel,
  parsePromaSelfGuardDescription,
  type PromaSelfGuardDescription,
} from './proma-self-control-policy'

interface FakeElement {
  nodeType: number
  tagName: string
  innerText: string
  textContent: string
  isContentEditable: boolean
  disabled: boolean
  getAttribute: (name: string) => string | null
  closest: (selector: string) => unknown
  matches: (selector: string) => boolean
}

interface FakeElementOptions {
  tagName?: string
  label?: string
  attributes?: Record<string, string>
  actionElement?: boolean
  protectedSelector?: string
  projectSelector?: string
  contentEditable?: boolean
  disabled?: boolean
}

function fakeElement(options: FakeElementOptions = {}): FakeElement {
  const attributes = options.attributes ?? {}
  return {
    nodeType: 1,
    tagName: options.tagName ?? (options.actionElement === false ? 'div' : 'BUTTON'),
    innerText: options.label ?? '',
    textContent: options.label ?? '',
    isContentEditable: options.contentEditable === true,
    disabled: options.disabled === true,
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: (selector: string) => {
      if (selector === options.protectedSelector) return {}
      if (selector === options.projectSelector) return {}
      if (selector === 'input[type="password"]' && attributes.type === 'password') return {}
      return null
    },
    matches: (selector: string) => options.actionElement !== false && selector.includes('button'),
  }
}

function buildGuard(): (element: FakeElement) => PromaSelfGuardDescription {
  return new Function(`return (${buildPromaSelfGuardFactorySource()})`)() as (element: FakeElement) => PromaSelfGuardDescription
}

describe('Proma 自操作保护标签', () => {
  test.each([
    '删除',
    '移除成员',
    '支付',
    '购买会员',
    '订阅',
    '授权',
    '批准',
    '拒绝',
    '允许',
    '同意',
    '退出登录',
    '登出',
    '停止 Agent',
    '发送',
    '确认',
    'Delete',
    'Sign out',
    'Confirm',
  ])('动作标签「%s」受保护', (label) => {
    expect(isPromaSelfControlActionLabelProtected(label)).toBe(true)
  })

  test.each(['设置', '打开设置', '外观', '取消', '新建项目', '项目名称', ''])('普通标签「%s」不按动作保护', (label) => {
    expect(isPromaSelfControlActionLabelProtected(label)).toBe(false)
  })

  test('密码与消息输入框按敏感字段保护，普通文本框不受影响', () => {
    expect(isPromaSelfControlActionLabelProtected('  密  码  ')).toBe(true)
    expect(isPromaSelfControlActionLabelProtected('Password')).toBe(true)
    expect(isPromaSelfControlActionLabelProtected('输入消息')).toBe(true)
    expect(isPromaSelfControlAxNodeProtected('textbox', '项目名称')).toBe(false)
    expect(isPromaSelfControlAxNodeProtected('textbox', '密码')).toBe(true)
    expect(isPromaSelfControlAxNodeProtected('searchbox', '搜索设置')).toBe(false)
    expect(isPromaSelfControlAxNodeProtected('alertdialog', '删除确认')).toBe(true)
  })
})

describe('Proma 新建项目识别', () => {
  test.each(['新建项目', '创建项目', '添加项目', '选择文件夹', '选择目录', 'New Project', 'Create project'])('标签「%s」识别为项目创建', (label) => {
    expect(isPromaSelfControlProjectCreationLabel(label)).toBe(true)
  })

  test.each(['删除项目', '打开设置', '项目名称', '保存'])('标签「%s」不识别为项目创建', (label) => {
    expect(isPromaSelfControlProjectCreationLabel(label)).toBe(false)
  })
})

describe('DOM 节点保护判定', () => {
  test('密码输入框与 alertdialog 受保护', () => {
    expect(isPromaSelfControlNodeProtected('input', ['type', 'password'])).toBe(true)
    expect(isPromaSelfControlNodeProtected('div', ['role', 'alertdialog'])).toBe(true)
    expect(isPromaSelfControlNodeProtected('input', ['autocomplete', 'current-password'])).toBe(true)
  })

  test('保护标记覆盖祖先与 AskUser 选项', () => {
    expect(isPromaSelfControlNodeProtected('button', ['data-proma-self-protected', 'true'])).toBe(true)
    expect(isPromaSelfControlNodeProtected('button', ['data-proma-ask-user-option', ''])).toBe(true)
    expect(isPromaSelfControlNodeProtected('div', ['data-proma-composer', ''])).toBe(true)
  })

  test('普通按钮与普通输入框不误判', () => {
    expect(isPromaSelfControlNodeProtected('button', ['class', 'primary'])).toBe(false)
    expect(isPromaSelfControlNodeProtected('input', ['type', 'text'])).toBe(false)
    expect(isPromaSelfControlNodeProjectCreation(['data-proma-project-creation', ''])).toBe(true)
    expect(isPromaSelfControlNodeProjectCreation(['class', 'card'])).toBe(false)
  })
})

describe('注入 DOM 的固定保护函数', () => {
  test('保护函数源码可编译且选择器经 JSON 序列化注入', () => {
    const source = buildPromaSelfGuardFactorySource()
    expect(typeof new Function(`return (${source})`)()).toBe('function')
    expect(source).toContain(JSON.stringify(PROMA_SELF_PROTECTED_SELECTORS[0]))
    expect(source).toContain(JSON.stringify(PROMA_SELF_PROJECT_CREATION_SELECTORS[0]))
  })

  test('安装脚本与探针脚本可编译', () => {
    expect(() => new Function(buildPromaSelfControlGuardSource())).not.toThrow()
    expect(() => new Function(`return (${buildPromaSelfGuardProbeSource()})`)).not.toThrow()
  })

  test('保护函数识别保护选择器与项目创建标签', () => {
    const guard = buildGuard()
    const protectedButton = guard(fakeElement({
      label: '普通按钮',
      protectedSelector: '[data-proma-self-protected]',
    }))
    expect(protectedButton.protected).toBe(true)
    expect(protectedButton.protectedSelector).toBe('[data-proma-self-protected]')

    const projectButton = guard(fakeElement({ label: '新建项目' }))
    expect(projectButton.projectCreation).toBe(true)
    expect(projectButton.protected).toBe(false)

    const settingsButton = guard(fakeElement({ label: '打开设置' }))
    expect(settingsButton.protected).toBe(false)
    expect(settingsButton.projectCreation).toBe(false)

    const passwordInput = guard(fakeElement({
      tagName: 'INPUT',
      actionElement: false,
      attributes: { type: 'password' },
      label: '登录密码',
    }))
    expect(passwordInput.protected).toBe(true)
    expect(passwordInput.editable).toBe(true)
  })

  test('描述解析对缺失字段宽容', () => {
    expect(parsePromaSelfGuardDescription(null)).toEqual({
      protected: false,
      protectedSelector: null,
      projectCreation: false,
      label: '',
      tagName: '',
      editable: false,
      disabled: false,
    })
    expect(parsePromaSelfGuardDescription({
      protected: true,
      projectCreation: true,
      label: '新建项目',
      tagName: 'button',
    })).toMatchObject({ protected: true, projectCreation: true, label: '新建项目', tagName: 'button' })
  })
})

describe('中文错误文案', () => {
  test('每个拒绝原因都有可读的中文文案', () => {
    const messages = Object.values(PROMA_SELF_CONTROL_ERRORS)
    expect(messages.length).toBeGreaterThan(10)
    for (const message of messages) {
      expect(message.trim().length).toBeGreaterThan(0)
      expect(/[\u4e00-\u9fff]/u.test(message)).toBe(true)
    }
    expect(PROMA_SELF_CONTROL_ERRORS.protectedElement).toContain('受保护')
    expect(PROMA_SELF_CONTROL_ERRORS.projectApprovalRequired).toContain('用户明确同意')
    expect(PROMA_SELF_CONTROL_ERRORS.askUserOption).toContain('AskUserQuestion')
    expect(PROMA_SELF_CONTROL_ERRORS.domActionUnsupported).toContain('focus')
  })
})
