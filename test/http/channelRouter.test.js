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
    // 2026-09-18 租户隔离实修：租户从会话推导，忽略客户端 tenant_id。默认模拟 tenant_admin 落在 t1。
    resolveMe: async () => ({ ok: true, role: 'tenant_admin', tenantId: 't1', username: 'u' }),
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

  it('验证成功 → detail 透传（证明「真的取到了数据」，不只是「连上了」）', async () => {
    const { deps } = makeDeps({
      verifyScope: async () => ({ ok: true, probe: 'meeting_api_list', detail: { status: 200, meetings: 3 } }),
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'ch-m', kind: 'generic-meeting', credentials: { endpoint: 'https://api.x/v1', token: 't' }, verify_only: true },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.detail).toEqual({ status: 200, meetings: 3 });
  });

  it('探测失败 → 探针 hint 必须透传（吞掉服务端拒因＝把用户导向改密码，属假失败）', async () => {
    // 真实现场（2026-09-18）：163 IMAP 对登录密码回 `A1 NO LOGIN Login error or password error`，
    //   真因是「须用客户端授权码」。若只回 auth_failed，用户只会反复改密码 → 方向被误导。
    const { deps } = makeDeps({
      verifyScope: async () => ({
        ok: false, error: 'auth_failed', probe: 'imap_login',
        missing: null, hint: 'A1 NO LOGIN Login error or password error',
      }),
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'ch-e', kind: 'generic-email', credentials: { host: 'imap.163.com', user: 'u', pass: 'p' }, verify_only: true },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('auth_failed');
    expect(res.body.hint).toContain('Login error or password error');
  });

  it('verify_only=true → 只探测、零副作用（不落凭据/不写描述符/不铸决策/不过人工闸）', async () => {
    const { deps, store } = makeDeps({
      verifyScope: async () => ({ ok: true, probe: 'imap_login' }),
      reviewGate: { hasApproval: async () => null }, // 人工未批准也不应影响「仅验证」
      produceDecision: async () => { throw new Error('不应铸决策'); },
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { user: 'u', pass: 'p' }, verify_only: true },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.stored).toBe(false);
    expect(store['secret:channel-email-1']).toBeUndefined();          // 凭据未落
    expect(store['t1:integration-providers']).toBeUndefined();        // 描述符未写
    expect(JSON.stringify(res.body)).not.toContain('secret-pass');
  });

  it('verify_only 必须把本次凭据交给 verifyScope（否则只查 vault ⇒ 永远 credentials_missing、探针从不执行）', async () => {
    // 真实缺陷回归：向导② 用 verify_only=true（**不落库**）做探测，而 verifyScope 原先只查 vault
    //   ⇒ vault 里没有本次凭据 ⇒ 恒返回 credentials_missing ⇒ 探针**一次都不会被调用**
    //   ⇒ 「开始验证」永远显示失败，用户永远看不到「探测通过」。零副作用 ≠ 零凭据。
    let seen = null;
    const { deps, store } = makeDeps({
      verifyScope: async (a) => { seen = a; return { ok: true, probe: 'imap_login' }; },
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { host: 'imap.x.com', user: 'u', pass: 'p' }, verify_only: true },
    }), res);
    expect(seen, 'verifyScope 未被调用').toBeTruthy();
    expect(seen.credentials).toEqual({ host: 'imap.x.com', user: 'u', pass: 'p' });
    expect(store['secret:channel-email-1']).toBeUndefined(); // 仍然零副作用：凭据未落库
  });

  it('探测失败 → missing 透传到响应（用户能看到「缺哪个字段」而非笼统失败）', async () => {
    const { deps } = makeDeps({
      verifyScope: async () => ({ ok: false, error: 'credentials_incomplete', missing: ['host'] }),
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'channel-email-1', kind: 'generic-email', credentials: { user: 'u', pass: 'p' } },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('credentials_incomplete');
    expect(res.body.missing).toEqual(['host']);
  });

  it('verify_not_wired：未装配探测时 verify_only 不得谎称已验证（fail-closed）', async () => {
    const { deps } = makeDeps({ verifyScope: null });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 't1', id: 'ch-1', kind: 'generic-email', verify_only: true },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('verify_not_wired');
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

  it('P2.5 POST /api/channels/:id/confirm-user-side 用户侧形态待确认→已验证（ok:false→true，保留其它形态记录）', async () => {
    const { deps, store } = makeDeps();
    // 既有描述符：connector 形态 pending（ok:false），另有一份已验证的 direct 形态记录，确认时不可被抹掉
    store['t1:integration-providers'] = [{
      id: 'channel-email-1', kind: 'generic-email', enabled: true, trust_level: 'L1',
      source_kind: 'connector',
      verifications: {
        connector: { ok: false, pending: true, method: 'tool', recorded_at: '2026-09-18T00:00:00Z' },
        direct: { ok: true, verified_at: '2026-09-17T00:00:00Z', probe: 'scope' },
      },
    }];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.confirmUserSide(mkReq('/api/channels/channel-email-1/confirm-user-side', {
      params: { id: 'channel-email-1' }, body: { sourceKind: 'connector', tool: 'read-calendar' },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.verification.ok).toBe(true);
    expect(res.body.verification.pending).toBe(false);
    expect(res.body.verification.tool).toBe('read-calendar');
    expect(res.body.verification.method).toBe('tool'); // 既有探针元数据保留
    expect(typeof res.body.verification.verified_at).toBe('string');
    // 描述符落库：connector 翻为 ok，direct 记录未被抹掉（合并写）
    const saved = store['t1:integration-providers'][0];
    expect(saved.verifications.connector.ok).toBe(true);
    expect(saved.verifications.direct.ok).toBe(true); // 其它形态记录保留
  });

  it('P2.5 confirm-user-side 缺源描述符 → 404', async () => {
    const { deps } = makeDeps();
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.confirmUserSide(mkReq('/api/channels/nope/confirm-user-side', {
      params: { id: 'nope' }, body: { sourceKind: 'connector' },
    }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('租户隔离（2026-09-18 实修）：GET 忽略客户端 tenant_id，强制用会话租户', async () => {
    const { deps, store } = makeDeps();
    // t1 与 other 各有一通道；前端若误带 other 的 tenant_id，绝不能读到 other 的数据
    store['t1:integration-providers'] = [{ id: 'ch-t1', kind: 'generic-email', enabled: true, trust_level: 'L1' }];
    store['other:integration-providers'] = [{ id: 'ch-other', kind: 'generic-email', enabled: true, trust_level: 'L1' }];
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.get(mkReq('/api/channels', { query: { tenant_id: 'other' } }), res); // 客户端试图越权读 other
    expect(res.statusCode).toBe(200);
    expect(res.body.channels.map((c) => c.id)).toEqual(['ch-t1']); // 只返回会话租户 t1 的数据
    expect(res.body.channels.some((c) => c.id === 'ch-other')).toBe(false);
  });

  it('租户隔离（2026-09-18 实修）：connect 忽略客户端 tenant_id，写入会话租户', async () => {
    const { deps, store } = makeDeps();
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { tenant_id: 'other', id: 'ch-x', kind: 'generic-email' }, // 客户端试图写入 other
    }), res);
    expect(res.statusCode).toBe(200);
    expect(store['t1:integration-providers'].some((d) => d.id === 'ch-x')).toBe(true); // 实际落到 t1
    expect(store['other:integration-providers']).toBeUndefined(); // 未落到 other
  });

  it('未登录（resolveMe 不通过）→ 401', async () => {
    const { deps } = makeDeps({ resolveMe: async () => ({ ok: false, status: 401, error: 'missing token' }) });
    const r = createChannelRouter(deps);
    for (const fn of ['get', 'connect', 'disconnect']) {
      const res = fakeRes();
      const req = fn === 'get'
        ? mkReq('/api/channels', { query: {} })
        : fn === 'connect'
          ? mkReq('/api/channels/connect', { body: { id: 'x', kind: 'generic-email' } })
          : mkReq('/api/channels/x/disconnect', { params: { id: 'x' } });
      await r.handlers[fn](req, res);
      expect(res.statusCode, `${fn} 应 401`).toBe(401);
    }
  });

  it('sysadmin 读用 scopeTenant（通配 *），写用 scopeOf（自身租户，永不通配）', async () => {
    const { deps, store } = makeDeps({ resolveMe: async () => ({ ok: true, role: 'sysadmin', tenantId: 'sys-1', username: 'a' }) });
    store['*:integration-providers'] = [{ id: 'ch-sys', kind: 'generic-email', enabled: true }];
    const r = createChannelRouter(deps);
    const getRes = fakeRes();
    await r.handlers.get(mkReq('/api/channels', {}), getRes);
    expect(getRes.body.channels.map((c) => c.id)).toEqual(['ch-sys']); // 读通配 *
    const connRes = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', { body: { id: 'ch-new', kind: 'generic-email' } }), connRes);
    expect(connRes.statusCode).toBe(200);
    expect(store['sys-1:integration-providers']?.some((d) => d.id === 'ch-new')).toBe(true); // 写落自身租户
  });

  it('P0-1：local-bridge 接入不落平台 vault（红线：不保存密码），credentials_on_platform=false', async () => {
    const calls = [];
    const { deps, store } = makeDeps({
      persistSecret: async ({ providerId, raw, sourceKind }) => { calls.push({ providerId, sourceKind }); store[`secret:${providerId}`] = { raw, encrypted: true }; return { ok: true }; },
      reviewGate: { hasApproval: async () => ({ ok: true }) },
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { id: 'channel-email-1', kind: 'generic-email', source_kind: 'local-bridge', credentials: { user: 'u', pass: 'p' } },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.channel.credentials_on_platform).toBe(false);
    expect(calls.some((c) => c.providerId === 'channel-email-1')).toBe(false); // 平台 vault 未写
    expect(store['secret:channel-email-1']).toBeUndefined(); // 凭据不在平台留存
  });

  it('P0-1：direct 接入仍按既有加密落 vault（向后兼容）', async () => {
    const calls = [];
    const { deps, store } = makeDeps({
      persistSecret: async ({ providerId, sourceKind }) => { calls.push({ providerId, sourceKind }); return { ok: true }; },
      reviewGate: { hasApproval: async () => ({ ok: true }) },
    });
    const r = createChannelRouter(deps);
    const res = fakeRes();
    await r.handlers.connect(mkReq('/api/channels/connect', {
      body: { id: 'channel-email-2', kind: 'generic-email', source_kind: 'direct', credentials: { user: 'u', pass: 'p' } },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(calls.some((c) => c.providerId === 'channel-email-2' && c.sourceKind === 'direct')).toBe(true);
    expect(res.body.channel.credentials_on_platform).toBe(true);
  });
});
