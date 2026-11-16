/**
 * Proma 自操作安全策略。
 *
 * 官方 0.22.80 允许 Agent 通过内部调试通道观察并操作 Proma 自身界面，但以下边界不可越过：
 * - 只操作用户主会话与当前 Proma 主窗口，不扩展为任意应用控制；
 * - 发送、审批、AskUser 答案、密码、删除、支付、授权等控件一律拒绝；
 * - 新建项目必须先拿到用户的肯定回答凭据，Agent 不能自己点 AskUser 选项。
 *
 * 本文件保持纯函数、无 Electron 依赖，既供主进程判定，也生成注入渲染进程的固定保护函数。
 * 所有动态数据只用 JSON.stringify 拼接，生成的脚本里不包含 Agent 提供的可执行代码。
 */

/** 受保护控件选择器：命中自身或祖先即拒绝操作。 */
export const PROMA_SELF_PROTECTED_SELECTORS: readonly string[] = [
  '[data-proma-self-protected]',
  '[data-proma-self-sensitive]',
  '[data-proma-ask-user-option]',
  '[data-proma-composer]',
  '[data-proma-composer-send]',
  '[data-proma-password]',
  'input[type="password"]',
  '[autocomplete="current-password"]',
  '[autocomplete="new-password"]',
  '[role="alertdialog"]',
]

/** 新建项目入口标记；点击这些控件需要用户肯定回答。 */
export const PROMA_SELF_PROJECT_CREATION_SELECTORS: readonly string[] = [
  '[data-proma-project-creation]',
  '[data-proma-project-create]',
]

/** 删除、支付、授权、发送等动作标签。 */
const PROTECTED_ACTION_LABEL_PATTERN = /删\s*除|移除|支付|付款|购买|订阅|授权|批准|拒绝|允许|同意|退出登录|退出账号|退出帐号|登出|注销|停止|终止|发送|确认|退款|解绑|重置|卸载|\bdelete\b|\bremove\b|\bpay\b|\bpayment\b|\bpurchase\b|\bsubscribe\b|\bauthorize\b|\bapprove\b|\breject\b|\blog\s*out\b|\bsign\s*out\b|\bstop\b|\bsend\b|\bconfirm\b|\brefund\b|\bunsubscribe\b/i

/** 敏感输入字段：密码与 Agent 自己的消息输入框。 */
const SENSITIVE_FIELD_LABEL_PATTERN = /密码|口令|passcode|password|发送消息|消息输入|输入消息|composer/i

/** 新建/添加项目、选择项目目录等入口。 */
const PROJECT_CREATION_LABEL_PATTERN = /(?:新建|创建|新增|添加)(?:一个)?(?:新)?项目|项目(?:创建|新建)|(?:新建|创建|新增|添加)\s*project|new\s*project|create\s*project|add\s*project|选择文件夹|选择目录|打开文件夹|choose\s*folder|select\s*folder|open\s*folder/i

/** 中文错误文案；主进程与工具适配层共用，避免同一拒绝原因出现多种说法。 */
export const PROMA_SELF_CONTROL_ERRORS = {
  refInvalid: '元素引用已失效，请先重新调用 PromaObserve 或 PromaFind。',
  refForeignSession: '元素引用不属于当前会话；Proma 自操作只能用于发起它的用户主会话。',
  protectedElement: '该控件受保护（发送、审批、密码、删除、支付、授权等），Proma 不能自行操作，请让用户手动完成。',
  askUserOption: 'Proma 不能点击自己的 AskUserQuestion 选项，请等待用户回答。',
  projectApprovalRequired: '新建项目前必须先获得用户明确同意；缺少用户肯定回答凭据时不能执行项目创建。',
  projectAlreadyApproved: '本次观察中已经执行过一次项目创建；再次创建需要用户重新确认。',
  domActionUnsupported: 'PromaDomAction 只支持 focus、fill、click、inspect 四种动作。',
  domScriptRejected: 'PromaDomAction 只接受固定动作和数据参数，不能执行 Agent 提供的 JavaScript。',
  domExecutionFailed: 'PromaDomAction 执行失败，请重新观察界面后再试。',
  aborted: 'Proma 自操作已取消。',
  timeout: 'Proma 界面未在限定时间内响应，请稍后重试。',
  elementMissing: '目标元素已从界面移除，请重新观察后再操作。',
  notEditable: '目标元素不是可编辑字段，请重新观察后选择输入框、文本域或可编辑区域。',
  disabled: '目标元素当前不可用，请重新观察界面状态。',
  selectorRequired: 'CSS selector 不能为空。',
  selectorTooLong: 'CSS selector 不能超过 1000 个字符。',
  textTooLong: '单次输入不能超过 10000 个字符。',
  textRequired: '输入文本必须是字符串。',
  invalidPress: 'PromaPress 需要导航键或非空文本。',
  invalidScroll: '滚动只能指定 deltaY 或 position 其中之一。',
  invalidScrollDelta: 'deltaY 必须是绝对值不超过 50000 的有限数字。',
  invalidScrollPosition: '不支持的滚动位置。',
  invalidWait: '等待条件必须是 text 或 selector。',
  invalidWaitValue: '等待条件不能为空。',
  invalidTimeout: '等待超时必须在 100 到 30000 毫秒之间。',
  invalidMaxElements: 'maxElements 必须是 1 到 400 的整数。',
  invalidMaxResults: 'maxResults 必须是 1 到 50 的整数。',
  invalidRef: 'ref 必须是非空字符串。',
  screenshotEmpty: '截图为空，Proma 窗口可能尚未完成渲染，请稍后重试。',
  screenshotTooLarge: '截图过大，请缩小窗口或改用 PromaObserve。',
} as const

/** 注入 DOM 的保护函数返回结构。 */
export interface PromaSelfGuardDescription {
  protected: boolean
  protectedSelector: string | null
  projectCreation: boolean
  label: string
  tagName: string
  editable: boolean
  disabled: boolean
}

interface PromaSelfGuardConfig {
  protectedSelectors: readonly string[]
  projectSelectors: readonly string[]
  protectedLabel: string
  sensitiveLabel: string
  projectLabel: string
}

function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

/** 界面标签可能被 CSS 拆成「密 码」；同时匹配折叠空白与完全去空白的写法。 */
function labelVariants(label: string): string[] {
  const normalized = normalizeLabel(label)
  if (!normalized) return []
  const compact = normalized.replace(/\s+/g, '')
  return compact === normalized ? [normalized] : [normalized, compact]
}

/** 动作按钮标签是否受保护（发送/审批/删除/支付/授权等）。 */
export function isPromaSelfControlActionLabelProtected(label: string): boolean {
  return labelVariants(label).some((candidate) => (
    PROTECTED_ACTION_LABEL_PATTERN.test(candidate) || SENSITIVE_FIELD_LABEL_PATTERN.test(candidate)
  ))
}

/** 标签是否代表新建/添加项目入口。 */
export function isPromaSelfControlProjectCreationLabel(label: string): boolean {
  return labelVariants(label).some((candidate) => PROJECT_CREATION_LABEL_PATTERN.test(candidate))
}

/**
 * 输入类 AX 节点只按敏感字段判定：设置里的普通文本框仍可填写，
 * 但密码、口令和 Agent 自己的消息输入框必须拒绝。
 */
export function isPromaSelfControlAxNodeProtected(role: string, name: string): boolean {
  const normalizedRole = role.trim().toLowerCase()
  const normalizedName = normalizeLabel(name)
  if (normalizedRole === 'alertdialog') return true
  if (!normalizedName) return false
  if (normalizedRole === 'textbox' || normalizedRole === 'searchbox' || normalizedRole === 'combobox') {
    return SENSITIVE_FIELD_LABEL_PATTERN.test(normalizedName)
  }
  return isPromaSelfControlActionLabelProtected(normalizedName)
}

function readAttributeMap(attributes: readonly string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const name = attributes[index]
    const value = attributes[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string') continue
    map.set(name.toLowerCase(), value)
  }
  return map
}

/**
 * 用 DOM.describeNode 的 nodeName + attributes 做一次结构性保护判定。
 * 这是在没有执行页面脚本时的兜底；正常流程还会用注入的保护函数检查祖先容器。
 */
export function isPromaSelfControlNodeProtected(nodeName: string, attributes: readonly string[]): boolean {
  const name = nodeName.trim().toLowerCase()
  const attrs = readAttributeMap(attributes)
  if (attrs.has('data-proma-self-protected') || attrs.has('data-proma-self-sensitive')) return true
  if (attrs.has('data-proma-ask-user-option') || attrs.has('data-proma-composer') || attrs.has('data-proma-composer-send')) return true
  if (attrs.has('data-proma-password')) return true
  if (name === 'input' && attrs.get('type')?.toLowerCase() === 'password') return true
  const autocomplete = attrs.get('autocomplete')?.toLowerCase()
  if (autocomplete === 'current-password' || autocomplete === 'new-password') return true
  return attrs.get('role')?.toLowerCase() === 'alertdialog'
}

/** DOM 节点是否带新建项目标记。 */
export function isPromaSelfControlNodeProjectCreation(attributes: readonly string[]): boolean {
  const attrs = readAttributeMap(attributes)
  return attrs.has('data-proma-project-creation') || attrs.has('data-proma-project-create')
}

function buildGuardConfig(): PromaSelfGuardConfig {
  return {
    protectedSelectors: PROMA_SELF_PROTECTED_SELECTORS,
    projectSelectors: PROMA_SELF_PROJECT_CREATION_SELECTORS,
    protectedLabel: PROTECTED_ACTION_LABEL_PATTERN.source,
    sensitiveLabel: SENSITIVE_FIELD_LABEL_PATTERN.source,
    projectLabel: PROJECT_CREATION_LABEL_PATTERN.source,
  }
}

/**
 * 生成受保护函数表达式：调用后返回 (element) => 描述对象。
 * 唯一拼接进脚本的动态数据是 JSON.stringify(config) 与标签文案。
 */
export function buildPromaSelfGuardFactorySource(): string {
  const configJson = JSON.stringify(buildGuardConfig())
  return `(() => {
  const config = ${configJson};
  const protectedLabel = new RegExp(config.protectedLabel, 'i');
  const sensitiveLabel = new RegExp(config.sensitiveLabel, 'i');
  const projectLabel = new RegExp(config.projectLabel, 'i');
  const actionSelector = 'button,a,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],input[type="button"],input[type="submit"],input[type="reset"],summary';
  const describeText = (element) => {
    const parts = [];
    const aria = element.getAttribute('aria-label');
    if (aria) parts.push(aria);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\\s+/)) {
        const label = document.getElementById(id);
        if (label && label.textContent) parts.push(label.textContent);
      }
    }
    const title = element.getAttribute('title');
    if (title) parts.push(title);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) parts.push(placeholder);
    let isAction = false;
    try { isAction = !!element.matches(actionSelector); } catch { isAction = false; }
    if (isAction) {
      const text = element.innerText || element.textContent || '';
      if (text) parts.push(text);
    }
    return parts.join(' ').replace(/\\s+/g, ' ').trim().slice(0, 500);
  };
  const matches = (element, selector) => {
    try { return !!element.closest(selector); } catch { return false; }
  };
  return (element) => {
    if (!element || element.nodeType !== 1) {
      return { protected: false, protectedSelector: null, projectCreation: false, label: '', tagName: '', editable: false, disabled: false };
    }
    const label = describeText(element);
    let protectedSelector = null;
    for (const selector of config.protectedSelectors) {
      if (matches(element, selector)) { protectedSelector = selector; break; }
    }
    const tagName = (element.tagName || '').toLowerCase();
    const inputType = tagName === 'input' ? String(element.type || 'text').toLowerCase() : '';
    const textInput = tagName === 'input' && ['text','search','email','url','tel','number','password','date','datetime-local','month','week','time'].includes(inputType);
    const editable = textInput || tagName === 'textarea' || !!element.isContentEditable;
    let isAction = false;
    try { isAction = !!element.matches(actionSelector); } catch { isAction = false; }
    const protectedByLabel = (isAction && protectedLabel.test(label)) || sensitiveLabel.test(label);
    let projectBySelector = false;
    for (const selector of config.projectSelectors) {
      if (matches(element, selector)) { projectBySelector = true; break; }
    }
    return {
      protected: !!(protectedSelector || protectedByLabel),
      protectedSelector,
      projectCreation: !!(projectBySelector || (isAction && projectLabel.test(label))),
      label,
      tagName,
      editable,
      disabled: !!(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    };
  };
})()`
}

/** 生成可注入 DOM 的保护函数；重复注入会覆盖为同一实现。 */
export function buildPromaSelfControlGuardSource(): string {
  return `(() => {
  if (typeof window === 'undefined') return false;
  window.__promaSelfControlGuard = ${buildPromaSelfGuardFactorySource()};
  return true;
})()`
}

/** Runtime.callFunctionOn 使用的固定函数，this 绑定目标元素。 */
export function buildPromaSelfGuardProbeSource(): string {
  return `function () {
  const guard = ${buildPromaSelfGuardFactorySource()};
  return guard(this);
}`
}

function readBooleanValue(value: unknown): boolean {
  return value === true
}

function readStringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 宽容解析注入函数或 Runtime.evaluate 返回的描述对象。 */
export function parsePromaSelfGuardDescription(value: unknown): PromaSelfGuardDescription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { protected: false, protectedSelector: null, projectCreation: false, label: '', tagName: '', editable: false, disabled: false }
  }
  const record = value as Record<string, unknown>
  return {
    protected: readBooleanValue(record.protected),
    protectedSelector: typeof record.protectedSelector === 'string' ? record.protectedSelector : null,
    projectCreation: readBooleanValue(record.projectCreation),
    label: readStringValue(record.label),
    tagName: readStringValue(record.tagName),
    editable: readBooleanValue(record.editable),
    disabled: readBooleanValue(record.disabled),
  }
}
