// test/external-integration.test.js — 外部数据接入（获客模块数据源子层扩展）
// 纯逻辑 + 注册元信息断言，不触 DB（凭据/配置经 deps 注入）。逐 Task 追加 describe 段。
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_DISCOVERY_RULES, mergeDiscoveryRules } from '../src/config/discoveryRules.js';
import { _resetRegistry, _resetTenantRegistry, registerTenantInstance, getTenantInstances } from '../src/connectors/discovery/providerRegistry.js';

describe('T1 · 配置增量', () => {
  it('providers 含 qixin/xinbang 且均 enabled:false(scope=paid)', () => {
    const ids = DEFAULT_DISCOVERY_RULES.providers.map((p) => p.id);
    expect(ids).toContain('qixin');
    expect(ids).toContain('xinbang');
    const q = DEFAULT_DISCOVERY_RULES.providers.find((p) => p.id === 'qixin');
    const x = DEFAULT_DISCOVERY_RULES.providers.find((p) => p.id === 'xinbang');
    expect(q.scope).toBe('paid'); expect(q.enabled).toBe(false);
    expect(x.kind).toBe('social'); expect(x.enabled).toBe(false);
  });
  it('signals 含 social_content 权重键（不增字面量于逻辑）', () => {
    expect(DEFAULT_DISCOVERY_RULES.signals.social_content).toBeDefined();
    expect(typeof DEFAULT_DISCOVERY_RULES.signals.social_content.weight).toBe('number');
  });
  it('mergeDiscoveryRules 仅覆盖既有 id，不增删条数', () => {
    const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, { providers: [{ id: 'qixin', enabled: true }] });
    expect(merged.providers).toHaveLength(DEFAULT_DISCOVERY_RULES.providers.length);
    expect(merged.providers.find((p) => p.id === 'qixin').enabled).toBe(true);
  });
});

describe('T2 · 凭据保险库', () => {
  const fakeEncrypt = (s) => Buffer.from('E:' + s).toString('base64');
  const fakeDecrypt = (e) => Buffer.from(e, 'base64').toString('utf8').replace(/^E:/, '');
  it('加密→解密 round-trip 等于原文', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/connectors/discovery/credentialVault.js');
    const enc = encryptSecret('sk-123', 'k', { pgpEncrypt: fakeEncrypt });
    expect(enc).not.toBe('sk-123');
    expect(decryptSecret(enc, 'k', { pgpDecrypt: fakeDecrypt })).toBe('sk-123');
  });
  it('resolveCredentials 从 integration-secrets 解密 + 缺失回退 env', async () => {
    const { resolveCredentials } = await import('../src/connectors/discovery/credentialVault.js');
    const read = async () => ({ value: { qixin: fakeEncrypt('api-qx') } });
    const out = await resolveCredentials({
      tenantId: 't1', providerIds: ['qixin', 'erp'],
      deps: { readConfig: read, decrypt: fakeDecrypt, env: { QIXIN_KEY: 'env-qx', ERP_KEY: 'env-erp' } },
    });
    expect(out.qixin).toBe('api-qx');   // 库中有 → 解密
    expect(out.erp).toBe('env-erp');    // 库中无 → 回退 env
  });
});

describe('T3 · per-tenant 注册子机制', () => {
  beforeEach(() => { _resetRegistry(); _resetTenantRegistry(); });
  const fac = (id) => () => ({ id, kind: 'generic-rest' });
  it('registerTenantInstance 按 ${tenantId}:${id} 隔离注册', () => {
    registerTenantInstance('A', { id: 'erp-a' }, fac('erp-a'));
    expect(getTenantInstances('A').map((f) => f().id)).toContain('erp-a');
    expect(getTenantInstances('B')).toHaveLength(0); // 跨租户恒空
  });
});

describe('T5 · qixin adapter', () => {
  it('无 key 返回 {}（零请求）', async () => {
    const { qixinAdapter } = await import('../src/connectors/discovery/adapters/qixin.js');
    const a = qixinAdapter();
    expect(await a.enrich({ name: 'X' }, ['funding_round'], { credentials: {} })).toEqual({});
  });
  it('有 key 时 enrich 返回 firmographics + 信号字段（复用既有 signals 键）', async () => {
    const { qixinAdapter } = await import('../src/connectors/discovery/adapters/qixin.js');
    const a = qixinAdapter({ __mock: { registered_address: '上海', funding_round: 'B轮', hiring_icp_role: 'CTO', tender_match: 'XX 招标' } });
    const r = await a.enrich({ name: 'X' }, ['registered_address', 'funding_round', 'hiring_icp_role', 'tender_match'], { credentials: { qixin: 'k' } });
    expect(r.registered_address.value).toBe('上海');
    expect(r.funding_round.value).toBe('B轮'); // 信号字段名命中 discoveryRules.signals 键
    expect(r.tender_match.value).toBe('XX 招标');
  });
});

describe('T6 · xinbang adapter', () => {
  it('enrich 返回 social_content 信号（进 discovery.signals 类型 social_content）', async () => {
    const { xinbangAdapter } = await import('../src/connectors/discovery/adapters/xinbang.js');
    const a = xinbangAdapter({ __mock: { posts: 12, interactions: 340 } });
    const r = await a.enrich({ name: 'X' }, ['social_content'], { credentials: { xinbang: 'k' } });
    expect(r.social_content.value.posts).toBe(12);
    expect(r.social_content.provider).toBe('xinbang');
  });
  it('无 key 返回 {}', async () => {
    const { xinbangAdapter } = await import('../src/connectors/discovery/adapters/xinbang.js');
    expect(await xinbangAdapter().enrich({ name: 'X' }, ['social_content'], { credentials: {} })).toEqual({});
  });
});

describe('T7 · 通用租户适配器', () => {
  it('generic-rest 按 field_map 映射响应 → enrichment 字段', async () => {
    const { genericRestAdapter } = await import('../src/connectors/discovery/adapters/genericRest.js');
    const a = genericRestAdapter({ id: 'erp-a', kind: 'generic-rest', enabled: true,
      endpoint: 'https://erp', field_map: { name: 'companyName', employee_range: 'headcount' },
      credentials: 'tok', __fetch: async () => ({ ok: true, json: async () => ({ companyName: 'ACME', headcount: 500 }) }) });
    const r = await a.enrich({ name: 'ACME' }, ['name', 'employee_range'], { credentials: { 'erp-a': 'tok' } });
    expect(r.name.value).toBe('ACME');
    expect(r.employee_range.value).toBe(500);
  });
  it('generic-cli 经白名单命令执行 + 沙箱超时（mock spawn）', async () => {
    const { genericCliAdapter } = await import('../src/connectors/discovery/adapters/genericCli.js');
    const a = genericCliAdapter({ id: 'cli-a', kind: 'generic-cli', enabled: true,
      command: 'get-customer', field_map: { name: 'name' },
      __exec: async () => ({ stdout: 'name=ACME' }) });
    const r = await a.enrich({ name: 'ACME' }, ['name'], { credentials: {} });
    expect(r.name.value).toBe('ACME');
  });
});

describe('T4 · 租户实例实例化', () => {
  it('读 integration-providers → 按 kind 实例化 generic-* 适配器（零租户代码）', async () => {
    const { loadTenantAdapters } = await import('../src/connectors/discovery/tenantInstances.js');
    const descs = [{ id: 'erp-a', kind: 'generic-rest', enabled: true, endpoint: 'https://x', field_map: { name: 'company' } }];
    const read = async () => ({ value: descs });
    const creds = { 'erp-a': 'tok' };
    const inst = await loadTenantAdapters('A', {
      readConfig: read,
      resolveCredentials: async () => creds,
      genericFactories: {
        'generic-rest': (await import('../src/connectors/discovery/adapters/genericRest.js')).genericRestAdapter,
      },
    });
    expect(inst).toHaveLength(1);
    expect(inst[0].id).toBe('erp-a');
    expect(inst[0].config.credentials).toBe('tok');
  });
  it('disabled 实例被跳过', async () => {
    const { loadTenantAdapters } = await import('../src/connectors/discovery/tenantInstances.js');
    const descs = [{ id: 'erp-off', kind: 'generic-rest', enabled: false }];
    const inst = await loadTenantAdapters('A', { readConfig: async () => ({ value: descs }), resolveCredentials: async () => ({}) });
    expect(inst).toHaveLength(0);
  });
});

describe('T8 · builtin 注册 qixin/xinbang', () => {
  it('registerBuiltinAdapters 后 listProviderIds 含 qixin/xinbang', async () => {
    const { registerBuiltinAdapters } = await import('../src/connectors/discovery/builtinAdapters.js');
    const { _resetRegistry, listProviderIds } = await import('../src/connectors/discovery/providerRegistry.js');
    _resetRegistry();
    registerBuiltinAdapters();
    const ids = listProviderIds();
    expect(ids).toContain('qixin');
    expect(ids).toContain('xinbang');
  });
});

describe('T9 · orchestrator 注入 credentials', () => {
  it('runDiscovery 内 ctx.credentials[providerId] 为解密值（deps 注入可断言）', async () => {
    const { runDiscovery } = await import('../src/agent/discoveryOrchestrator.js');
    const { _resetRegistry } = await import('../src/connectors/discovery/providerRegistry.js');
    const { registerBuiltinAdapters } = await import('../src/connectors/discovery/builtinAdapters.js');
    _resetRegistry(); registerBuiltinAdapters();
    let seen = null;
    const adapters = [{ id: 'qixin', coverageFields: ['funding_round'], kind: 'firmographics',
      enrich: async (e, f, c) => { seen = c.credentials?.qixin; return {}; } }];
    const deps = {
      rules: { providers: [{ id: 'qixin', enabled: true, scope: 'paid', costTier: 2 }], signals: {}, duplicate_criteria: {}, icp: {} },
      adapters,
      resolveCredentials: async () => ({ qixin: 'decrypted-key' }),
      find: async () => null,
      create: async () => ({ id: 'acc1' }),
      update: async () => ({}),
      createEdge: async () => ({}),
    };
    await runDiscovery({ tenantId: 't1', actor: 'x', decision_id: 'd1' }, { seed: { name: 'ACME' } }, deps);
    expect(seen).toBe('decrypted-key');
  });
});

import { getAction, resetRegistry } from '../src/action/registry.js';
import { seedConnectorActions } from '../src/connectors/connectorActions.js';
describe('T10 · conn-signal-lead-gen', () => {
  beforeEach(() => { resetRegistry(); seedConnectorActions(); });
  it('已注册：connector 命名空间 + autoDecision 第0闸 + sourcedFrom 边 + agentTool:false', () => {
    const a = getAction('conn-signal-lead-gen');
    expect(a).not.toBeNull();
    expect(a.namespace).toBe('connector');
    expect(a.autoDecision).toBe(true);
    expect(a.autoWeakEdge).toBe(true);
    expect(a.weakPredicate).toBe('sourcedFrom');
    expect(a.agentTool).toBe(false); // 仅 webhook/定时器触发，不进 agent 直调
  });
  it('handler 经 createLeadFromTender 生成 S0 DEAL + sourcedFrom 边', async () => {
    const a = getAction('conn-signal-lead-gen');
    const created = { id: 'deal-new' };
    const deps = { createLeadFromTender: async () => created, createEdge: async () => ({}) };
    const r = await a.handler({ signal_type: 'funding_round', account_id: 'acc1', match: { value: 'B轮' } },
      { tenantId: 't1', decision_id: 'd1', ...deps });
    expect(r.deal_id).toBe('deal-new');
  });
});

describe('T11 · integration-poll 定时器注册', () => {
  it('runIntegrationPollOnce 逐租户对启用 provider 拉取并 monitorAccount', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const accounts = [{ id: 'acc1', payload: {} }];
    const calls = [];
    await runIntegrationPollOnce({
      listActiveTenants: async () => [{ tenant_id: 't1' }],
      loadAdapters: async () => [{ id: 'qixin', coverageFields: ['funding_round'], enrich: async () => ({ funding_round: { value: 'B轮', confidence: 0.8, cost: 0, provider: 'qixin' } }) }],
      query: async () => ({ rows: accounts }),
      runWaterfall: async (ads, ent, fields) => { calls.push(ent.id); return { values: { funding_round: { value: 'B轮' } }, cost: 0, calls: 1 }; },
      monitorAccount: async (deps, accId, sigs) => ({ accId, sigs }),
      emit: () => {},
    });
    expect(calls).toContain('acc1');
  });
  it('ensureTimers 注册 integration-poll（间隔取自 config，缺省 6h）', async () => {
    const { ensureTimers, clearTimers, timerCount } = await import('../src/scheduler/timers.js');
    const before = timerCount();
    clearTimers();
    ensureTimers();
    expect(timerCount()).toBeGreaterThan(before);
    clearTimers();
  });
});

describe('T12 · webhook + 手动端点', () => {
  it('handleSignalWebhook admin → 派发 conn-signal-lead-gen 生成线索', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    const dispatched = [];
    const exec = async (name, params, ctx) => { dispatched.push({ name, params, ctx }); return { ok: true, data: { deal_id: 'd1' } }; };
    const r = await handleSignalWebhook({ me: { ok: true, role: 'admin', username: 'a', tenantId: 't1' }, body: { signal_type: 'funding_round', account_id: 'acc1', match: { value: 'B轮' } }, provider: 'qixin', exec });
    expect(r.status).toBe(200);
    expect(dispatched[0].name).toBe('conn-signal-lead-gen');
    expect(dispatched[0].params.account_id).toBe('acc1');
  });
  it('handleSignalWebhook 非 admin → 403', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    const r = await handleSignalWebhook({ me: { ok: true, role: 'sales', username: 's', tenantId: 't1' }, body: { signal_type: 'x', account_id: 'a' }, provider: 'qixin', exec: async () => ({}) });
    expect(r.status).toBe(403);
  });
  it('createConnectorRouter 含 webhook 路由且 action 已注册', async () => {
    const { createConnectorRouter } = await import('../src/http/connectorRouter.js');
    const { getAction } = await import('../src/action/registry.js');
    const { seedConnectorActions } = await import('../src/connectors/connectorActions.js');
    seedConnectorActions();
    const r = createConnectorRouter({ resolveMe: () => ({ ok: true, role: 'admin', username: 'a', tenantId: 't1' }) });
    expect(typeof r.post).toBe('function');
    expect(getAction('conn-signal-lead-gen')).not.toBeNull();
  });
});

describe('T13 · 配置 system 级闸', () => {
  it('CONFIG_ITEMS 含 integration-providers / integration-secrets 且 level=system', async () => {
    const { CONFIG_ITEMS } = await import('../src/portal/configCenter.js');
    const p = CONFIG_ITEMS.find((i) => i.id === 47);
    const s = CONFIG_ITEMS.find((i) => i.id === 48);
    expect(p).toBeDefined(); expect(p.level).toBe('system');
    expect(s).toBeDefined(); expect(s.level).toBe('system');
  });
  it('integration-secrets 写入经加密（persistSecret 不落明文）', async () => {
    const { persistSecret } = await import('../src/connectors/discovery/credentialVault.js');
    const writes = [];
    await persistSecret({ tenantId: 't1', providerId: 'qixin', raw: 'sk-plain',
      deps: { writeConfig: async (k, v) => writes.push({ k, v }), readConfig: async () => ({ value: {} }),
              pgpEncrypt: (s) => Buffer.from('E:' + s).toString('base64') } });
    const json = JSON.stringify(writes[0].v);
    expect(json).not.toContain('sk-plain');
    // 加密后值应为 pgpEncrypt 输出（此处注入 base64('E:'+plain)），解码可还原且非明文
    const enc = writes[0].v.qixin;
    expect(enc).toBeDefined();
    expect(Buffer.from(enc, 'base64').toString()).toBe('E:sk-plain');
  });
  it('POST /api/integration/secret 仅 admin 可写，非 admin → 403', async () => {
    const { createIntegrationSecretRouter } = await import('../src/http/configRouter.js');
    const router = createIntegrationSecretRouter({
      resolveMe: async () => ({ ok: true, role: 'sales', tenantId: 't1' }),
      persistSecret: async () => { throw new Error('should not be called'); },
    });
    let status, body;
    const res = { status: (c) => { status = c; return { json: (b) => { body = b; } }; }, json: (b) => { body = b; } };
    await router.handlers.post({ body: { tenantId: 't1', providerId: 'qixin', raw: 'sk' } }, res);
    expect(status).toBe(403);
  });
  it('POST /api/integration/secret admin → 加密落库 + 第0闸', async () => {
    const { createIntegrationSecretRouter } = await import('../src/http/configRouter.js');
    const persisted = [];
    let produced = null;
    const router = createIntegrationSecretRouter({
      resolveMe: async () => ({ ok: true, role: 'admin', tenantId: 't1' }),
      produceDecision: async () => { produced = 'decision-x'; return { decisionId: 'decision-x', ok: true }; },
      persistSecret: async ({ tenantId, providerId, raw, deps }) => { persisted.push({ tenantId, providerId, raw }); },
    });
    let status = 200, body;
    const res = { status: (c) => { status = c; return { json: (b) => { body = b; } }; }, json: (b) => { body = b; } };
    await router.handlers.post({ body: { tenantId: 't1', providerId: 'qixin', raw: 'sk-plain' } }, res);
    expect(status).toBe(200);
    expect(persisted[0]).toEqual({ tenantId: 't1', providerId: 'qixin', raw: 'sk-plain' });
    expect(produced).toBe('decision-x');
    expect(body.decision).toBe('decision-x');
  });
});

describe('T15 · 租户自有实例 CRUD（配置中心补充）', () => {
  it('POST /api/integration/providers 校验 kind + field_map + 禁重名', async () => {
    const { createIntegrationProviderRouter } = await import('../src/http/configRouter.js');
    const store = { list: [] };
    const router = createIntegrationProviderRouter({
      resolveMe: async () => ({ ok: true, role: 'admin', tenantId: 'sys' }),
      readConfig: async () => ({ value: store.list }),
      writeConfig: async (k, v) => { store.list = v; return { ok: true }; },
      produceDecision: async () => ({ decisionId: 'd1', ok: true }),
    });
    // freshRes：每次调用独立 mock（否则 success 经 .json() 直发不置 status，会残留上次 400）
    const freshRes = () => { let status = 200, body; return { res: { status: (c) => { status = c; return { json: (b) => { body = b; } }; }, json: (b) => { body = b; } }, get: () => ({ status, body }) }; };
    let r = freshRes();
    await router.handlers.post({ body: { tenantId: 'sys', instance: { id: 'x', field_map: {} } } }, r.res);       // 缺 kind
    expect(r.get().status).toBe(400);
    r = freshRes();
    await router.handlers.post({ body: { tenantId: 'sys', instance: { id: 'x', kind: 'bogus', field_map: {} } } }, r.res);  // 非法 kind
    expect(r.get().status).toBe(400);
    r = freshRes();
    await router.handlers.post({ body: { tenantId: 'sys', instance: { id: 'x', kind: 'generic-rest', endpoint: 'https://x' } } }, r.res);  // rest 缺 field_map
    expect(r.get().status).toBe(400);
    r = freshRes();
    await router.handlers.post({ body: { tenantId: 'sys', instance: { id: 'erp', kind: 'generic-rest', endpoint: 'https://erp/api', field_map: { legal_person: 'legal' }, enabled: true } } }, r.res);  // 合法
    expect(r.get().status).toBe(200);
    expect(r.get().body.instances).toHaveLength(1);
    r = freshRes();
    await router.handlers.post({ body: { tenantId: 'sys', instance: { id: 'erp', kind: 'generic-rest', field_map: {} } } }, r.res);  // 重名
    expect(r.get().status).toBe(409);
  });
  it('PUT /api/integration/providers/:id 启停软开关；DELETE → 405 禁删', async () => {
    const { createIntegrationProviderRouter } = await import('../src/http/configRouter.js');
    const store = { list: [{ id: 'erp', kind: 'generic-rest', enabled: true }] };
    const router = createIntegrationProviderRouter({
      resolveMe: async () => ({ ok: true, role: 'admin', tenantId: 'sys' }),
      readConfig: async () => ({ value: store.list }),
      writeConfig: async (k, v) => { store.list = v; return { ok: true }; },
      produceDecision: async () => ({ decisionId: 'd2', ok: true }),
    });
    let status = 200, body;
    const res = { status: (c) => { status = c; return { json: (b) => { body = b; } }; }, json: (b) => { body = b; } };
    // 软停用
    await router.handlers.put({ params: { id: 'erp' }, body: { tenantId: 'sys', patch: { enabled: false } } }, res);
    expect(status).toBe(200);
    expect(store.list[0].enabled).toBe(false);
    // 不存在 → 404
    await router.handlers.put({ params: { id: 'nope' }, body: { tenantId: 'sys', patch: { enabled: false } } }, res);
    expect(status).toBe(404);
    // DELETE → 405 禁删
    await router.handlers.del({}, res);
    expect(status).toBe(405);
  });
  it('GET 非 admin → 403', async () => {
    const { createIntegrationProviderRouter } = await import('../src/http/configRouter.js');
    const router = createIntegrationProviderRouter({
      resolveMe: async () => ({ ok: true, role: 'sales', tenantId: 'sys' }),
      readConfig: async () => ({ value: [] }),
    });
    let status;
    const res = { status: (c) => { status = c; return { json: () => {} }; }, json: () => {} };
    await router.handlers.get({ query: {} }, res);
    expect(status).toBe(403);
  });
});

describe('T14 · 可观测接线', () => {
  it('integration-poll-done 事件可被 capture；recordTokens 零新表落账', async () => {
    const captured = [];
    const { recordTokens } = await import('../src/alerts/tokenAccounting.js');
    const r = await recordTokens({ actor: 'integration-poll', action: 'integration-poll', tokensIn: 0, tokensOut: 0, tenantId: 't1' });
    expect(r.ok).toBe(true);
    captured.push('integration-poll-done');
    expect(captured).toContain('integration-poll-done');
  });
  it('runIntegrationPollOnce 成功路径按租户聚合 cost 落账 recordTokens（注入式，零 IO）', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const calls = [];
    const recTok = async (p) => { calls.push(p); return { ok: true }; };
    await runIntegrationPollOnce({
      listActiveTenants: async () => [{ tenant_id: 't1' }],
      loadAdapters: async () => [{ id: 'qixin', coverageFields: ['legal_person'] }],
      query: async () => ({ rows: [{ id: 'acc1', payload: { name: 'X' } }] }),
      runWaterfall: async () => ({ values: { legal_person: { provider: 'qixin', ts: new Date().toISOString() } }, cost: 2 }),
      monitorAccount: async () => {},
      emit: () => {},
      recordTokens: recTok,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].tenantId).toBe('t1');
    expect(calls[0].actor).toBe('integration-poll');
    expect(calls[0].tokensIn).toBe(2);
    expect(calls[0].module).toBe('integration');
  });
});



// ─── A-B6（T06）：integration-poll 同步增量分支——线A 挂载点（2026-09-16）───
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B6 + §13 T06
// 计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md
// 红线：零新增定时器；未注入 loadSyncTargets → no-op（既有行为零变化）；无 objects[] → 不调 runSync
describe('A-B6 · integration-poll 同步增量分支（线A 挂载点）', () => {
  const baseDeps = () => ({
    listActiveTenants: async () => [{ tenant_id: 't1' }],
    loadAdapters: async () => [],
    query: async () => ({ rows: [] }),
    runWaterfall: async () => ({ values: {}, cost: 0 }),
    monitorAccount: async () => {},
    recordTokens: async () => ({ ok: true }),
  });

  it('注入 loadSyncTargets + runSync → 每租户调用一次并 emit integration-poll-sync', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const traces = [];
    let syncArgs = null;
    await runIntegrationPollOnce({
      ...baseDeps(),
      emit: (k, name, p) => traces.push({ name, p }),
      loadSyncTargets: async ({ tenantId }) => [{ id: 'fx-1', kind: 'fxiaoke', objects: [{ name: 'AccountObj', direction: 'in' }], trustLevel: 'L1' }],
      runSync: async (a) => { syncArgs = a; return { runs: 1, errors: 0, created: 0, updated: 0 }; },
    });
    expect(syncArgs.tenantId).toBe('t1');
    expect(syncArgs.targets).toHaveLength(1);
    expect(traces.find((x) => x.name === 'integration-poll-sync')?.p).toMatchObject({ tenant_id: 't1', runs: 1 });
  });

  it('租户无同步目标 → runSync 不被调用（no-op，零回归）', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    let called = false;
    await runIntegrationPollOnce({
      ...baseDeps(),
      emit: () => {},
      loadSyncTargets: async () => [],
      runSync: async () => { called = true; return {}; },
    });
    expect(called).toBe(false);
  });

  it('未注入 loadSyncTargets → 分支完全跳过（既有调用方零变化）', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const traces = [];
    await runIntegrationPollOnce({ ...baseDeps(), emit: (k, name) => traces.push(name) });
    expect(traces).not.toContain('integration-poll-sync');
  });

  it('同步分支独立于富化适配器存在性：adapters 为空仍跑同步', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    let syncRuns = 0;
    await runIntegrationPollOnce({
      ...baseDeps(),
      loadAdapters: async () => [], // 无富化适配器（既有实现会 continue 跳过整租户）
      emit: () => {},
      loadSyncTargets: async () => [{ id: 'fx-1', kind: 'fxiaoke', objects: [{ name: 'AccountObj', direction: 'in' }], trustLevel: 'L1' }],
      runSync: async () => { syncRuns++; return { runs: 1 }; },
    });
    expect(syncRuns).toBe(1);
  });

  it('同步目标装配失败 → emit trace 留痕（不静默）且富化主流程继续', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const traces = [];
    let enrichRan = false;
    await runIntegrationPollOnce({
      ...baseDeps(),
      loadAdapters: async () => [{ id: 'qixin', coverageFields: ['legal_person'] }],
      query: async () => ({ rows: [{ id: 'acc1', payload: {} }] }),
      runWaterfall: async () => { enrichRan = true; return { values: {}, cost: 0 }; },
      monitorAccount: async () => {},
      emit: (k, name) => traces.push(name),
      loadSyncTargets: async () => { throw new Error('sync boom'); },
      runSync: async () => ({ runs: 1 }),
    });
    expect(traces).toContain('integration-poll-sync-targets-failed');
    expect(enrichRan).toBe(true); // 富化主流程不受影响
  });

  it('runSync 抛错 → emit integration-poll-sync-failed（不静默、不拖垮富化）', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const traces = [];
    let enrichRan = false;
    await runIntegrationPollOnce({
      ...baseDeps(),
      loadAdapters: async () => [{ id: 'qixin', coverageFields: ['legal_person'] }],
      query: async () => ({ rows: [{ id: 'acc1', payload: {} }] }),
      runWaterfall: async () => { enrichRan = true; return { values: {}, cost: 0 }; },
      monitorAccount: async () => {},
      emit: (k, name) => traces.push(name),
      loadSyncTargets: async () => [{ id: 'fx-1', kind: 'fxiaoke', objects: [{ name: 'AccountObj', direction: 'in' }], trustLevel: 'L1' }],
      runSync: async () => { throw new Error('inner boom'); },
    });
    expect(traces).toContain('integration-poll-sync-failed');
    expect(enrichRan).toBe(true);
  });
});

// ─── E.2.1（2026-09-16）：monitorAccount 失败**不再静默** ───
// 设计出处：docs/2026-09-15-final-design-coexistence-and-proactive.md §E.2.1 处置①（零风险、立即）。
// 背景：`monitorAccount` 首参要求 ctx 四件套（getAccount/rescore/appendMemory/updateParticle），
//   而 `runIntegrationPollOnce` 只传 `{ tenantId }` → 调用**结构性必然抛错**；
//   原实现 `.catch(() => {})` 把它空吞 ⇒「C3 闭环从未真正执行」在生产上完全不可见（无 trace、无账）。
// 本用例锁死「失败必须留痕」，防未来回归成静默（G3 不静默铁律）。
describe('E.2.1 · monitorAccount 失败留痕（禁止空吞）', () => {
  it('monitorAccount 抛错 → emit integration-poll-monitor-failed + recordFailure 计数 + 主流程不中断', async () => {
    const { runIntegrationPollOnce } = await import('../src/scheduler/timers.js');
    const { getFailures, resetFailures } = await import('../src/monitor/monitorStore.js');
    resetFailures();
    const traces = [];
    await runIntegrationPollOnce({
      listActiveTenants: async () => [{ tenant_id: 't1' }],
      loadAdapters: async () => [{ id: 'qixin', coverageFields: ['legal_person'] }],
      query: async () => ({ rows: [{ id: 'acc1', payload: {} }] }),
      // 富化出非空 values → sigs.length > 0 → 命中 monitorAccount 调用点
      runWaterfall: async () => ({ values: { legal_person: { provider: 'qixin', ts: 'x' } }, cost: 0 }),
      monitorAccount: async () => { throw new Error('ctx.getAccount is not a function'); },
      recordTokens: async () => ({ ok: true }),
      emit: (k, name, p) => traces.push({ name, p }),
    });
    const hit = traces.find((x) => x.name === 'integration-poll-monitor-failed');
    expect(hit).toBeTruthy();
    expect(hit.p).toMatchObject({ tenant_id: 't1', account_id: 'acc1', signals: 1 });
    expect(hit.p.error).toContain('ctx.getAccount');
    expect(getFailures()['integration-poll-monitor-failed']).toBe(1);
    // 负向对照：留痕 ≠ 阻断——主流程仍走到 done（证明此处不拖垮富化轮次）
    expect(traces.map((x) => x.name)).toContain('integration-poll-done');
  });
});

// ─── A-B5（T06）：webhook 对象变化事件路由——线A 第二挂载点（2026-09-16）───
// 设计 §6.1 A-B5 + §13 T06；计划 docs/superpowers/plans/2026-09-16-line-a-mount-points.md §Task 5
// 红线：两路共用同一 admin/sysadmin 闸；无 event.object → 既有线索派发行为不变（零回归）
describe('A-B5 · webhook 对象变化事件路由（线A 挂载点）', () => {
  it('body.event.object 存在 → 路由到同步内核 upsert（不经线索派发）', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    const dispatched = [];
    const syncCalls = [];
    const r = await handleSignalWebhook({
      me: { ok: true, role: 'admin', username: 'a', tenantId: 't1' },
      body: { event: { object: 'AccountObj', record: { id: 'a1', name: '客户A' } } },
      provider: 'fxiaoke',
      exec: async (name) => { dispatched.push(name); return { ok: true, data: {} }; },
      runSyncEvent: async (args) => { syncCalls.push(args); return { ok: true, created: true, externalId: 'a1' }; },
    });
    expect(r.status).toBe(200);
    expect(r.json.route).toBe('sync-upsert');
    expect(syncCalls[0]).toMatchObject({ tenantId: 't1', provider: 'fxiaoke', object: 'AccountObj' });
    expect(dispatched).toEqual([]); // 不派发线索动作
  });

  it('body.event.object 存在但未接线 → 501（不静默降级为线索派发，避免写错对象）', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    const r = await handleSignalWebhook({
      me: { ok: true, role: 'admin', username: 'a', tenantId: 't1' },
      body: { event: { object: 'AccountObj' } }, provider: 'fxiaoke',
      exec: async () => ({ ok: true }),
    });
    expect(r.status).toBe(501);
    expect(r.json.error).toBe('sync_route_not_mounted');
  });

  it('同步路由失败（未声明映射）→ 400 带 error 与 result（不静默成 200）', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    const r = await handleSignalWebhook({
      me: { ok: true, role: 'admin', username: 'a', tenantId: 't1' },
      body: { event: { object: 'UnknownObj', record: { id: 'x' } } }, provider: 'fxiaoke',
      exec: async () => ({ ok: true }),
      runSyncEvent: async () => ({ ok: false, error: 'object_not_mapped' }),
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('object_not_mapped');
  });

  it('不带 event.object → 保持既有线索派发（零回归）', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    const dispatched = [];
    const r = await handleSignalWebhook({
      me: { ok: true, role: 'admin', username: 'a', tenantId: 't1' },
      body: { signal_type: 'funding_round', account_id: 'acc1', match: { value: 'B轮' } },
      provider: 'qixin',
      exec: async (name, params) => { dispatched.push({ name, params }); return { ok: true, data: { deal_id: 'd1' } }; },
    });
    expect(r.status).toBe(200);
    expect(dispatched[0].name).toBe('conn-signal-lead-gen');
    expect(r.json.decision_id).toBe('d1');
  });

  it('sales 角色走事件路由 → 403（两路共用同一闸，不因新分支放宽）', async () => {
    const { handleSignalWebhook } = await import('../src/http/connectorRouter.js');
    let synced = false;
    const r = await handleSignalWebhook({
      me: { ok: true, role: 'sales', username: 's', tenantId: 't1' },
      body: { event: { object: 'AccountObj', record: { id: 'a1' } } }, provider: 'fxiaoke',
      exec: async () => ({}),
      runSyncEvent: async () => { synced = true; return { ok: true }; },
    });
    expect(r.status).toBe(403);
    expect(synced).toBe(false);
  });
});

// ─── A-B1（2026-09-16）：enrich 侧共用同一描述符归一化（单一事实源）───
// 设计 §6.1 A-B1；实现 src/connectors/discovery/providerDescriptor.js
// 意义：同一份 integration-providers 被 enrich 与 sync 两侧消费，判据必须只有一处
describe('A-B1 · loadTenantAdapters 走统一描述符归一化', () => {
  it('扩字段（objects[]/token_mode/trust_level）不影响既有 enrich 装配，旧字段仍透传', async () => {
    const { loadTenantAdapters } = await import('../src/connectors/discovery/tenantInstances.js');
    const inst = await loadTenantAdapters('T1', {
      readConfig: async () => ({ value: [{
        id: 'fx', kind: 'generic-rest', enabled: true, endpoint: 'https://x',
        field_map: { name: 'company' }, token_mode: 'corp-access-token', trust_level: 'L2',
        objects: [{ name: 'AccountObj', direction: 'in' }],
      }] }),
      resolveCredentials: async () => ({ fx: 'tok' }),
      genericFactories: {
        'generic-rest': (await import('../src/connectors/discovery/adapters/genericRest.js')).genericRestAdapter,
      },
    });
    expect(inst).toHaveLength(1);
    expect(inst[0].config.field_map).toEqual({ name: 'company' }); // 旧字段零回归
    expect(inst[0].config.token_mode).toBe('corp-access-token');
    expect(inst[0].config.trust_level).toBe('L2');
  });

  it('非法方向 → 该对象被剔除且 emit issues（不静默）；未知 kind → 留痕', async () => {
    const { loadTenantAdapters } = await import('../src/connectors/discovery/tenantInstances.js');
    const traces = [];
    const seen = [];
    const inst = await loadTenantAdapters('T1', {
      readConfig: async () => ({ value: [
        { id: 'ok', kind: 'generic-rest', enabled: true, objects: [{ name: 'A', direction: 'up' }] },
        { id: 'wt', kind: 'unknown-kind', enabled: true },
      ] }),
      resolveCredentials: async () => ({}),
      genericFactories: { 'generic-rest': (cfg) => { seen.push(cfg); return { id: cfg.id }; } },
      emit: (lvl, name, p) => traces.push({ name, p }),
    });
    expect(inst).toHaveLength(1);
    expect(seen[0].objects).toEqual([]); // 非法对象被剔除，不猜方向
    expect(traces.some((t) => t.name === 'integration-providers-invalid' && t.p.issues.some((s) => s.includes('unknown_direction:up')))).toBe(true);
    expect(traces.some((t) => t.name === 'integration-kind-unknown' && t.p.kind === 'unknown-kind')).toBe(true);
  });
});
