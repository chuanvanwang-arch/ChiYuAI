// test/http/channelRouter.test.js — T6：/api/channels 配置读写 + 接入三步后端
// 判据（设计 §4.5 + §8 裁决）：
//   GET /api/channels → 租户通道列表（integration-providers 描述符）
//   POST /api/channels/connect → ①凭据入 vault（明文不落响应）→ ②verifyScope 真探测（fail-closed）
//                                → ③接入=first-connect 过 review-gate（HITL）→ 描述符 upsert
//   POST /api/channels/:id/disconnect → 软停用 enabled=false（禁删铁律）
import { describe, it, expect } from 'vitest';
import { createChannelRouter } from '../../src/http/channelRouter.js';

// handlers 直调 helper（与既有 configRouter.test.js 同范式）
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
// mkReq(path, {body, query, params}) → 拟 req（GET 用 query；POST/PATCH 用 body/params）
const mkReq = (path, { body = {}, query = {}, params = {} } = {}) => ({ method: 'POST', path, url: path, body, query, params, headers: {} });

function makeDeps(overrides = {}) {
  const store = {};
  const deps = {
    readConfig: async (key, { tenantId } = {}) => ({ value: store[`${tenantId}:${key}`] || null }),
    writeConfig: async (key, value, { tenantId } = {}) => { store[`${tenantId}:${key}`] = value; },
    persistSecret: async ({ providerId, raw }) => { store[`secret:${providerId}`] = { raw, encrypted: true }; return { ok: true }; },
    reviewGate: null,
    verifyScope: null,
    ...overrides,
  };
  return { deps, store };
}

describe('channelRouter 契约（T6）', () => {
  it('GET /api/channels 返回租户通道列表（enabled/trust_level/objects）', async () => {
    const { deps, store } = makeDeps();
    store['t1:integration-providers'] = [
      { id: 'channel-email-1', kind: 'generic-email', label: '邮箱', enabled: true, trust_level: 'L1', objects: [{ name: 'email' }] },
      { id: 'neocrm-1', kind: 'neocrm', label: '销售易', enabled: true }, // 非 generic-* 不过滤
    ];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.get(mkReq('/api/channels', { query: { tenant_id: 't1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0]).toMatchObject({ id: 'channel-email-1', kind: 'generic-email', enabled: true, trust_level: 'L1' });
    expect(res.body.channels[0].objects).toEqual([{ name: 'email' }]);
  });

  it('POST /api/channels/connect 凭据入 vault 且响应不落明文', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { user: 'alice', pass: 'secret-pass' } },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('secret-pass'); // 明文不落响应
    expect(JSON.stringify(res.body)).not.toContain('alice'); // 账号也不落响应
    expect(store['secret:channel-email-1']).toBeTruthy(); // 已入 vault（加密落库）
    expect(store['secret:channel-email-1'].raw.pass).toBe('secret-pass'); // vault 存了（加密态）
    // 描述符已 upsert
    expect(store['t1:integration-providers'].some((d) => d.id === 'channel-email-1' && d.enabled === true)).toBe(true);
  });

  it('POST /api/channels/connect 缺凭据 → verifyScope fail-closed（credentials_missing 明确提示）', async () => {
    const { deps } = makeDeps({
      verifyScope: async () => ({ ok: false, error: 'credentials_missing' }),
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email' },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('credentials_missing');
    expect(res.body.hint).toContain('credentials_missing'); // 明确提示「需补齐凭据」
  });

  it('POST /api/channels/connect 接入=first-connect 过 review-gate（HITL 人工闸）', async () => {
    const { deps } = makeDeps({ reviewGate: { hasApproval: async () => null } }); // 人工未批准
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { user: 'u', pass: 'p' } },
    }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('approval_required');
  });

  it('kind 判据单一源：generic-rest/mcp/cli 不是通道（不展示、不可接入）', async () => {
    const { deps, store } = makeDeps();
    store['t1:integration-providers'] = [
      { id: 'src-rest', kind: 'generic-rest', enabled: true },   // 通用数据源（非通道）
      { id: 'src-mcp', kind: 'generic-mcp', enabled: true },
      { id: 'ch-email', kind: 'generic-email', enabled: true, trust_level: 'L1' }, // 真通道
    ];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.get(mkReq('/api/channels', { query: { tenant_id: 't1' } }), res);
    expect(res.body.channels.map((c) => c.id)).toEqual(['ch-email']); // 只列通道
    // 同判据用于接入校验：generic-rest 不得经通道向导入库
    const res2 = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'src-rest', kind: 'generic-rest' },
    }), res2);
    expect(res2.statusCode).toBe(400);
    expect(res2.body.error).toBe('kind_invalid');
  });

  it('配置写第 0 闸：connect/disconnect 铸 config-change 决策并落 decisionId', async () => {
    const seen = [];
    const { deps, store } = makeDeps({
      produceDecision: async (scene, ctx) => { seen.push({ scene, ctx }); return { decisionId: 'dec-1', ok: true }; },
      writeConfig: async (key, value, opt = {}) => { store[`t1:${key}`] = value; seen.push({ write: key, decisionId: opt.decisionId }); },
    });
    store['t1:integration-providers'] = [{ id: 'ch-email', kind: 'generic-email', enabled: true }];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'ch-email', kind: 'generic-email' },
    }), res);
    expect(res.body.decision).toBe('dec-1');
    expect(seen.some((s) => s.scene === 'config-change' && s.ctx?.key === 'integration-providers')).toBe(true);
    expect(seen.some((s) => s.write === 'integration-providers' && s.decisionId === 'dec-1')).toBe(true);
    // disconnect 同源
    const res2 = fakeRes();
    await r.handlers.disconnect(mkReq('/api/channels/ch-email/disconnect', { params: { id: 'ch-email' }, query: { tenant_id: 't1' } }), res2);
    expect(res2.body.decision).toBe('dec-1');
  });

  it('POST /api/channels/:id/disconnect 软停用（enabled=false，禁删铁律）', async () => {
    const { deps, store } = makeDeps();
    store['t1:integration-providers'] = [{ id: 'channel-email-1', kind: 'generic-email', enabled: true, trust_level: 'L1' }];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.disconnect(mkReq('/api/channels/channel-email-1/disconnect', { params: { id: 'channel-email-1' }, query: { tenant_id: 't1' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.channel.enabled).toBe(false);
    // 描述符仍在（未物理删除），只是 enabled=false
    expect(store['t1:integration-providers'].some((d) => d.id === 'channel-email-1')).toBe(true);
    expect(store['t1:integration-providers'][0].enabled).toBe(false);
  });
});
