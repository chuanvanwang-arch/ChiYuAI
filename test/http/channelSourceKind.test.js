// test/http/channelSourceKind.test.js — P2 接入三形态（source_kind）的行为验证
// 设计：docs/2026-09-18-unified-integration-design-v2.md §5.1 / §5.2 / §5.4
// 判据（§5.4）：
//   4 三形态不互相冒充：验证通过只写该形态的记录，其余形态仍未验证
//   5 同一通道只允许一个已验证形态生效（防双写）
//   + 非法 source_kind 必须**拒**而非静默回落（静默回落＝「以为凭据留本机、实际传了平台」）
import { describe, it, expect } from 'vitest';
import { createChannelRouter } from '../../src/http/channelRouter.js';
import { SOURCE_KINDS, DEFAULT_SOURCE_KIND, PREFERRED_SOURCE_KIND, LEGACY_SOURCE_KIND, sourceKindOf, verifiedKindsOf } from '../../src/channels/sourceKinds.js';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
const mkReq = (body = {}) => ({ method: 'POST', path: '/api/channels/connect', url: '/api/channels/connect', body, query: {}, params: {}, headers: {} });

function makeDeps(overrides = {}) {
  const store = {};
  const deps = {
    readConfig: async (key, { tenantId } = {}) => ({ value: store[`${tenantId}:${key}`] || null }),
    writeConfig: async (key, value, { tenantId } = {}) => { store[`${tenantId}:${key}`] = value; },
    persistSecret: async () => ({ ok: true }),
    reviewGate: { hasApproval: async () => ({ ok: true }) },
    verifyScope: async () => ({ ok: true, probe: 'imap_login' }),
    produceDecision: async () => ({ decisionId: 'd-1' }),
    ...overrides,
  };
  return { deps, store };
}
const connect = async (r, body) => {
  const res = fakeRes();
  await r.handlers.connect(mkReq({
    tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email',
    credentials: { host: 'h', user: 'u', pass: 'p' }, ...body,
  }), res);
  return res;
};

describe('P2 形态取值域（单一事实源）', () => {
  it('三形态固定；界面首选=connector 而**接口缺省=direct**（两者必须分开，否则静默改语义）', () => {
    expect(SOURCE_KINDS).toEqual(['connector', 'local-bridge', 'direct']);
    expect(PREFERRED_SOURCE_KIND).toBe('connector');  // 向导默认选中的卡（产品策略，在界面层）
    expect(DEFAULT_SOURCE_KIND).toBe('direct');       // 接口缺省（向后兼容：既有调用与存量描述符都是直连）
    expect(LEGACY_SOURCE_KIND).toBe('direct');
    // 若接口缺省也设成 connector，既有调用会「形态升级」并跳过平台侧校验，而界面显示「凭据不在我方」——与事实相反
    expect(sourceKindOf({ id: 'x' })).toBe('direct');
    expect(sourceKindOf({ source_kind: 'local-bridge' })).toBe('local-bridge');
    expect(sourceKindOf({ source_kind: 'nonsense' })).toBe('direct'); // 非法值按最保守的 direct 展示
  });
});

describe('P2 connect 的形态语义', () => {
  it('未指定 source_kind → 落接口缺省 direct 并走平台侧真探测（既有调用方零行为变化）', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    const res = await connect(r, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.channel.source_kind).toBe('direct');
    expect(res.body.channel.credentials_on_platform).toBe(true); // direct：凭据在我方 vault
    expect(res.body.verified).toBe(true);                        // 平台侧已实测
    const d = store['t1:integration-providers'][0];
    expect(d.verifications.direct.ok).toBe(true);
    expect(d.verifications.direct.probe).toBe('imap_login');
  });

  it('connector：如实记 **pending**（不得写 ok:true，否则防双写判据与界面都会失真）', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    const res = await connect(r, { source_kind: 'connector' });
    expect(res.statusCode).toBe(200);
    expect(res.body.channel.credentials_on_platform).toBe(false);
    expect(res.body.verified).toBe(false);
    expect(res.body.pending_user_side).toBe(true);
    const rec = store['t1:integration-providers'][0].verifications.connector;
    expect(rec.ok).toBe(false);
    expect(rec.pending).toBe(true);
    expect(rec.method).toBe('user_side_connector');
    // pending 不构成「已验证形态」⇒ 不会被当成生效形态（防双写判据以后续 direct 接入不被误拒证明）
    expect(verifiedKindsOf(store['t1:integration-providers'][0])).toEqual([]);
  });

  it('connector 形态不再浪费平台侧探针（平台无该形态凭据，探针必然误判）', async () => {
    let called = 0;
    const { deps } = makeDeps({ verifyScope: async () => { called++; return { ok: true, probe: 'imap_login' }; } });
    const r = createChannelRouter(deps);
    await connect(r, { source_kind: 'connector' });
    expect(called).toBe(0);
  });

  it('pending 形态不阻塞后续 direct 接入（只有真验证过才算「已生效形态」）', async () => {
    const { deps } = makeDeps();
    const r = createChannelRouter(deps);
    await connect(r, { source_kind: 'connector' });           // pending
    const res = await connect(r, { source_kind: 'direct' });  // 应被允许
    expect(res.statusCode).toBe(200);
  });

  it('direct 形态：credentials_on_platform=true（界面据此声明凭据去向）', async () => {
    const { deps } = makeDeps();
    const r = createChannelRouter(deps);
    const res = await connect(r, { source_kind: 'direct' });
    expect(res.body.channel.source_kind).toBe('direct');
    expect(res.body.channel.credentials_on_platform).toBe(true);
  });

  it('非法 source_kind → 400（**不得静默回落**：回落＝「以为本机、实际上传我方」）', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    const res = await connect(r, { source_kind: 'local_bridge' }); // 下划线拼错
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('source_kind_invalid');
    expect(res.body.allowed).toEqual(SOURCE_KINDS);
    expect(store['t1:integration-providers']).toBeUndefined(); // 未落库
  });

  it('三形态不互相冒充：direct 验证通过后，其余形态记录仍不存在（各形态独立）', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    await connect(r, { source_kind: 'direct' });
    const d = store['t1:integration-providers'][0];
    expect(verifiedKindsOf(d)).toEqual(['direct']);         // 只有 direct 已验证
    expect(d.verifications.connector).toBeUndefined();      // 不得被一并点亮
    expect(d.verifications['local-bridge']).toBeUndefined();
  });

  it('防双写：已有 direct 已验证 → 换 connector 再接入被 409 拒（防两条通路各写一次）', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    await connect(r, { source_kind: 'direct' });
    const res = await connect(r, { source_kind: 'connector' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('channel_already_verified');
    expect(res.body.verified_kinds).toEqual(['direct']);
    // 未写入第二个形态（否则两条通路会各写一次同一批数据）
    expect(verifiedKindsOf(store['t1:integration-providers'][0])).toEqual(['direct']);
  });

  it('同形态重复接入 → 允许（幂等改凭据/信任档，不视为冲突）', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    await connect(r, { source_kind: 'direct' });
    const res = await connect(r, { source_kind: 'direct', trust_level: 'L2' });
    expect(res.statusCode).toBe(200);
    expect(store['t1:integration-providers'][0].trust_level).toBe('L2');
    expect(verifiedKindsOf(store['t1:integration-providers'][0])).toEqual(['direct']);
  });

  it('描述符**合并写**：既有 verifications / objects 不被本次接入抹掉', async () => {
    const { deps, store } = makeDeps();
    store['t1:integration-providers'] = [{
      id: 'channel-email-1', kind: 'generic-email', label: '工作邮箱', enabled: true, trust_level: 'L1',
      objects: [{ name: 'email', direction: 'in' }],
      verifications: { direct: { ok: true, verified_at: '2026-09-01T00:00:00Z', probe: 'imap_login' } },
      source_kind: 'direct',
      custom_note: '运营备注：仅供华东团队',
    }];
    const r = createChannelRouter(deps);
    const res = await connect(r, { source_kind: 'direct' }); // 同形态（不触发 409）
    expect(res.statusCode).toBe(200);
    const d = store['t1:integration-providers'][0];
    expect(d.objects).toEqual([{ name: 'email', direction: 'in' }]); // 未传 objects ⇒ 保留既有
    expect(d.custom_note).toBe('运营备注：仅供华东团队');            // 其它字段不得丢
    expect(d.verifications.direct.ok).toBe(true);
  });

  it('GET /api/channels 回形态与已验证清单（界面据此外显，不各自推断）', async () => {
    const { deps, store } = makeDeps();
    store['t1:integration-providers'] = [
      { id: 'c1', kind: 'generic-email', enabled: true, trust_level: 'L1' },                       // 存量：无 source_kind
      { id: 'c2', kind: 'generic-calendar', enabled: true, source_kind: 'local-bridge' },
    ];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.get({ method: 'GET', url: '/api/channels', query: { tenant_id: 't1' }, body: {}, params: {}, headers: {} }, res);
    const [a, b] = res.body.channels;
    expect(a.source_kind).toBe('direct');        // 存量回退，不冒充 connector
    expect(a.verified_kinds).toEqual([]);
    expect(b.source_kind).toBe('local-bridge');
    expect(String(b.source_kind_label)).toContain('本机');
  });
});
