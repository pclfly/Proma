// 只读审查 harness：TypeScript transpile + VM 载入生产类，全部外部服务 fail-closed/mock。
// 方法层回归夹具：真实生产类，不启动Electron/IM/provider；默认拒绝未注入的模块与网络。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const WT = path.resolve(__dirname, '../../../../..').replaceAll('\\', '/');
const OUT = path.join(require('node:os').tmpdir(), 'proma-bridge-synthetic');
const ts = require(WT + '/node_modules/typescript/lib/typescript.js');
const root = WT + '/apps/electron/src/main/lib/';
const outcomes = [];
const captures = [];
const hashes = new Map();
function read(file) { const text = fs.readFileSync(file, 'utf8'); hashes.set(file.replace(WT + '/', ''), require('node:crypto').createHash('sha256').update(text).digest('hex')); return text; }
function compile(text, filename, deps = {}, globals = {}) {
    const mod = { exports: {} };
    const context = {
        module: mod, exports: mod.exports, Buffer, URL, Date, Map, Set, Promise, structuredClone,
        AbortController, setTimeout, clearTimeout, setInterval: () => { throw Error('interval disallowed'); }, clearInterval,
        console: { log: (...args) => captures.push(args.join(' ')), warn: (...args) => captures.push(args.join(' ')), error: (...args) => captures.push(args.join(' ')) },
        process: { env: { ...process.env }, platform: process.platform, resourcesPath: OUT + '/fixtures/resources' },
        fetch: () => { throw Error('network forbidden'); },
        require: (name) => { if (Object.hasOwn(deps, name))
            return deps[name]; throw Error('UNMOCKED IMPORT: ' + name + ' in ' + filename); },
        ...globals,
    };
    const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }, fileName: filename }).outputText;
    vm.runInNewContext(js, context, { filename, timeout: 10000 });
    return mod.exports;
}
function source(rel, deps = {}, globals = {}) { return compile(read(root + rel), rel, deps, globals); }
const redaction = { redactSensitiveLogText: x => String(x), redactSensitiveLogValue: x => x };
const workspaceResolution = source('bridge-workspace-resolution.ts');
const pureQueue = source('feishu/scoped-queue.ts');
const pureCoordinator = source('feishu/run-coordinator.ts');
const pureMessage = source('bridge-agent-message-utils.ts');
const connectionStartup = source('network/connection-startup.ts');
const feishuDomain = { getFeishuApiBaseUrl: () => 'https://invalid.invalid', normalizeFeishuDomain: () => 'feishu' };
const feishuChannelOptions = source('feishu-channel-options.ts', { './feishu-domain': feishuDomain });
const fakeFs = { existsSync: () => false, readFileSync: () => { throw Error('no fixture'); }, writeFileSync: () => { throw Error('fs write forbidden unless mocked'); } };
const noWrite = { writeJsonFileAtomic: () => { throw Error('unmocked JSON write'); } };
const switchModule = source('bridge-workspace-switch.ts', { 'node:fs': fakeFs, './safe-file': noWrite });
const bindingsModule = source('bridge-binding-store.ts', { 'node:fs': fakeFs, './safe-file': noWrite, './bridge-workspace-switch': switchModule, './bridge-log-redaction': redaction });
function fixture() {
    const f = { ws: new Map(), sessions: new Map(), created: [], runs: [], saved: [], sent: [], defaults: undefined,
        settings: { agentChannelId: 'channel', agentModelId: 'model' }, persisted: [], fileBindings: [], configFailure: null, bindingFailure: false, mediaFailure: false, mediaSaves: [], savedPaths: new Set(), journalPending: false };
    f.journal = { isPending: () => f.journalPending, begin: () => { f.journalPending = true; }, complete: () => { f.journalPending = false; } };
    f.saveBindings = data => { if (f.bindingFailure) {
        const error = f.bindingFailure;
        if (error === 'once')
            f.bindingFailure = false;
        throw Error('synthetic binding failure');
    } f.saved.push(structuredClone(data)); };
    f.updateDefault = (_id, workspaceId) => { if (f.configFailure)
        throw f.configFailure; f.diskDefault = workspaceId; };
    f.mediaFs = { ...fakeFs, existsSync: p => f.savedPaths.has(p) };
    f.saveMedia = (slug, sessionId, hint) => { const row = { slug, sessionId, hint, path: '/synthetic/' + sessionId + '/' + hint, attempt: f.mediaAttempts = (f.mediaAttempts || 0) + 1 }; if (f.mediaFailure || f.mediaFailureHook?.())
        throw Error('synthetic media failure'); f.mediaSaves.push(row); f.savedPaths.add(row.path); return row.path; };
    f.ws.set('A', { id: 'A', name: 'Project A', slug: 'a' });
    f.ws.set('B', { id: 'B', name: 'Project B', slug: 'b' });
    f.sessions.set('old', { id: 'old', workspaceId: 'A', title: 'old session', channelId: 'channel' });
    f.sessions.set('valid', { id: 'valid', workspaceId: 'B', title: 'valid session', channelId: 'channel' });
    f.sessions.set('orphan', { id: 'orphan', workspaceId: 'gone', title: 'orphan session', channelId: 'channel' });
    f.sessionDeps = {
        createAgentSession: (title, channelId, workspaceId, modelId) => { const s = { id: 'new-' + (f.created.length + 1), title: title ?? '新会话', channelId, workspaceId, modelId }; f.created.push(s); f.sessions.set(s.id, s); return s; },
        getAgentSessionMeta: id => f.sessions.get(id), listAgentSessions: () => [...f.sessions.values()],
    };
    f.workspaceDeps = { getAgentWorkspace: id => f.ws.get(id), listAgentWorkspacesByUpdatedAt: () => [...f.ws.values()], getProjectFilesPath: () => '/synthetic', getWorkspaceCapabilities: () => ({ mcpServers: [], skills: [] }) };
    f.agentDeps = { runAgentHeadless: async (...args) => { f.runs.push(args); }, agentEventBus: { on: () => () => { } }, stopAgent: () => { }, isAgentSessionActive: () => false };
    f.attachmentDeps = { buildAttachedFilesBlock: files => '<attached_files>' + files.map(x => x.path).join(',') + '</attached_files>\n', buildSessionFileTree: () => [], buildFileTree: () => [], inferImageMediaType: () => 'image/png', saveImageToSession: (...args) => f.saveMedia(...args), saveFileToSession: (...args) => f.saveMedia(...args), inferExtension: () => 'png' };
    f.base = { '@proma/shared': { AGENT_IPC_CHANNELS: { TITLE_UPDATED: 'agent:title-updated' }, FEISHU_IPC_CHANNELS: { STATUS_CHANGED: 'feishu:status-changed' }, SLACK_IPC_CHANNELS: { STATUS_CHANGED: 'slack:status-changed' } }, './main-window-store': { getMainWindow: () => null }, './settings-service': { getSettings: () => f.settings }, './agent-session-manager': f.sessionDeps, './agent-workspace-manager': f.workspaceDeps, './agent-service': f.agentDeps, './bridge-workspace-resolution': workspaceResolution, './bridge-workspace-switch': { ...switchModule, createBridgeWorkspaceSwitchJournal: () => f.journal }, './bridge-binding-store': bindingsModule, './bridge-log-redaction': redaction, './bridge-agent-message-utils': pureMessage, './bridge-attachment-utils': f.attachmentDeps, './bridge-model-utils': { listSwitchableChannels: () => [], getEnabledModels: () => [], resolveChannelByIndex: () => undefined, resolveModelByIndex: () => undefined, describeBindingModel: () => ({}) }, './network/connection-startup': connectionStartup };
    f.binding = (sessionId = 'old') => ({ chatId: 'im-chat', sessionId, workspaceId: f.sessions.get(sessionId).workspaceId, channelId: 'channel' });
    f.generic = (extra = {}) => {
        const { BridgeCommandHandler } = source('bridge-command-handler.ts', f.base);
        const h = new BridgeCommandHandler({ platformName: 'fixture', adapter: { sendText: async (id, text, meta) => { f.sent.push({ id, text, meta }); if (f.onSend)
                    await f.onSend(text); } }, getDefaultWorkspaceId: () => f.defaults, bindingStore: { load: () => f.persisted, save: f.saveBindings, workspaceSwitchJournal: f.journal }, ...extra });
        return h;
    };
    f.dingtalk = () => {
        const { BridgeCommandHandler } = source('bridge-command-handler.ts', f.base);
        const { DingTalkBridge } = source('dingtalk-bridge.ts', { ...f.base, 'node:fs': f.mediaFs, electron: { BrowserWindow: { getAllWindows: () => [] } }, './dingtalk-config': { getDecryptedBotClientSecret: () => { throw Error('credentials forbidden'); }, updateDingTalkDefaultWorkspace: f.updateDefault }, './bridge-command-handler': { BridgeCommandHandler }, './config-paths': { getDingTalkBotBindingsPath: () => '/synthetic/bindings' }, './bridge-binding-store': { createJsonBridgeChatBindingStore: () => ({ load: () => f.persisted, save: f.saveBindings, workspaceSwitchJournal: f.journal }) } });
        const h = new DingTalkBridge({ id: 'fixture-bot', name: 'fixture', defaultWorkspaceId: f.defaults });
        h.replyTextViaWebhook = async (_hook, text) => f.sent.push({ text });
        h.commandHandler.config.adapter.sendText = async (_id, text) => { f.sent.push({ text }); if (f.onSend)
            await f.onSend(text); };
        return h;
    };
    f.wechat = () => {
        const { BridgeCommandHandler } = source('bridge-command-handler.ts', f.base);
        const wechatConstants = compile(read(WT + '/packages/shared/src/types/wechat.ts'), 'wechat-types.ts');
        const { wechatBridge } = source('wechat-bridge.ts', { ...f.base, '@proma/shared': { ...f.base['@proma/shared'], ...wechatConstants }, electron: { BrowserWindow: { getAllWindows: () => [] } }, './wechat-config': { getDecryptedCredentials: () => { throw Error('credentials forbidden'); }, saveWeChatCredentials: () => { throw Error('credentials forbidden'); }, clearWeChatCredentials: () => { throw Error('credentials forbidden'); }, getWeChatConfig: () => ({ defaultWorkspaceId: f.defaults }), updateWeChatDefaultWorkspace: id => { if (f.configFailure)
                    throw f.configFailure; f.defaults = id; } }, './config-paths': { getWeChatBindingsPath: () => '/synthetic/bindings', getWeChatSyncPath: () => '/synthetic/sync' }, './bridge-command-handler': { BridgeCommandHandler }, './bridge-binding-store': { createJsonBridgeChatBindingStore: () => ({ load: () => f.persisted, save: f.saveBindings, workspaceSwitchJournal: f.journal }) }, 'node:fs': f.mediaFs, 'node:crypto': {}, qrcode: {}, './wechat-api-utils': { assertWeChatSendSucceeded: () => { } }, './wechat-agent-input': { appendWeChatAgentSourceMarker: x => x + '[wechat-source]' } });
        wechatBridge.client = { sendText: async (_id, text) => { f.sent.push({ text }); if (f.onSend)
                await f.onSend(text); } };
        return wechatBridge;
    };
    f.feishu = () => {
        const cards = new Proxy({}, { get: (_, name) => (...args) => ({ name, args }) });
        const deps = { ...f.base, typebox: { Type: new Proxy({}, { get: () => (...args) => ({ args }) }) }, './feishu-config': { getDecryptedBotAppSecret: () => { throw Error('credentials forbidden'); }, updateFeishuDefaultWorkspace: f.updateDefault }, './config-paths': { getFeishuBotBindingsPath: () => '/synthetic/bindings', getFeishuBotMetadataPath: () => '/synthetic/metadata' }, 'node:fs': { ...f.mediaFs, existsSync: p => p === '/synthetic/bindings' || p === '/synthetic/metadata' || f.savedPaths.has(p), readFileSync: () => JSON.stringify(f.fileBindings), writeFileSync: (_p, text) => f.saved.push(JSON.parse(text)) }, './safe-file': { readJsonFileSafe: () => null, writeJsonFileAtomic: (_p, data) => f.saveBindings(data) }, './feishu-message': cards, './feishu/card-stream': { CardStream: { open: async () => { if (f.onCardOpen)
                        await f.onCardOpen(); const card = { closed: 0, update: async () => { }, flush: async () => { }, close: async () => { card.closed += 1; f.closedCards = (f.closedCards || 0) + 1; } }; return card; } } }, './feishu/card-run-state': { createInitialState: () => ({}), markError: x => x, markInterrupted: x => x, reduce: x => x }, './feishu/card-renderer-v2': { renderCard: () => ({}) }, './feishu/session-mirror': { buildSessionMirrorGroupName: () => 'synthetic', normalizeSessionMirrorUserOpenId: x => x }, './feishu/group-message-policy': { resolveGroupMessageAccess: () => ({}) }, './feishu/scoped-queue': pureQueue, './feishu/run-coordinator': pureCoordinator, './feishu/prompt-builder': { buildAgentUserMessage: ({ userText, attachedFilesBlock }) => (attachedFilesBlock ?? '') + userText, fetchQuotedMessage: async () => undefined }, './feishu-domain': feishuDomain, './feishu-channel-options': feishuChannelOptions };
        const { FeishuBridge } = source('feishu-bridge.ts', deps);
        const h = new FeishuBridge({ id: 'fixture-bot', name: 'fixture', defaultWorkspaceId: f.defaults });
        h.sendMessage = async (id, text) => f.sent.push({ id, text });
        h.sendTextMessage = async (id, text) => f.sent.push({ id, text });
        h.sendCardMessage = async (id, card) => f.sent.push({ id, card });
        h.fetchChatHistory = async () => [];
        return h;
    };
    f.slack = () => {
        const { SlackBridge } = source('slack-bridge.ts', { ...f.base, 'node:crypto': { randomUUID: () => 'synthetic' }, electron: { BrowserWindow: { getAllWindows: () => [] } }, './config-paths': { getSlackBotBindingsPath: () => '/synthetic/bindings', getSlackBotDeliveryPath: () => '/synthetic/delivery' }, './agent-ask-user-service': { askUserService: {} }, './agent-exit-plan-service': { exitPlanService: {} }, './agent-permission-service': { permissionService: {} }, './safe-file': { readJsonFileSafe: () => ({ version: 1, bindings: f.fileBindings }), writeJsonFileAtomic: (_p, data) => f.saved.push(structuredClone(data)) }, './slack/block-kit': { buildAskUserBlocks: () => [], buildPermissionBlocks: () => [], buildPlanApprovalBlocks: () => [], renderSlackMessage: text => ({ text, blocks: [] }) }, './slack/delivery-store': { SlackDeliveryStore: class {
                    constructor() { this.records = new Map(); f.deliveryStore = this; }
                    get(id) { return this.records.get(id); }
                    accept(record) { this.records.set(record.eventId, { ...record, status: 'accepted' }); }
                    update(id, data) { this.records.set(id, { ...this.records.get(id), ...data, eventId: id }); }
                    interruptedRuns() { return [...this.records.values()].filter((r) => r.status === 'accepted' || r.status === 'running'); }
                    pendingFinalDeliveries() { return [...this.records.values()].filter((r) => r.status === 'final-ready' || r.status === 'failed'); }
                } } });
        const h = new SlackBridge({ id: 'fixture-bot', name: 'fixture' });
        h.postThinking = async () => undefined;
        return h;
    };
    f.manager = (platform) => {
        const forbidden = () => { throw Error('删除离线项目不得读取配置或清空既有路由记录'); };
        if (platform === 'dingtalk') {
            return source('dingtalk-bridge-manager.ts', {
                ...f.base,
                './dingtalk-bridge': { DingTalkBridge: class {} },
                './dingtalk-config': { getDingTalkMultiBotConfig: forbidden, getDingTalkBotById: forbidden },
            }).dingtalkBridgeManager;
        }
        return source('feishu-bridge-manager.ts', {
            ...f.base,
            'node:fs': fakeFs,
            './feishu-bridge': { FeishuBridge: class {} },
            './feishu-config': { getFeishuMultiBotConfig: forbidden, getFeishuBotById: forbidden },
            './config-paths': {},
            './safe-file': noWrite,
            './feishu/session-mirror': {},
        }).feishuBridgeManager;
    };
    return f;
}
module.exports = { fixture };
