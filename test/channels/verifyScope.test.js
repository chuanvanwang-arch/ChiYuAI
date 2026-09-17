// test/channels/verifyScope.test.js — 接入向导② 真探测 fail-closed 守卫
// 判据（设计 §4.5.1 步骤② + §8 红线）：
//   凭据缺 → credentials_missing（明确提示）；探测未交付（P4）→ probe_not_implemented（如实，不假绿）；
//   已注册探针 → 真探测执行且结果如实返回。
import { describe, it, expect } from 'vitest';
import { createVerifyScope, registerChannelProbe } from '../../src/channels/verifyScope.js';

describe('verifyScope 真探测 fail-closed', () => {
  it('缺凭据 → credentials_missing（明确提示需补齐凭据）', async () => {
    const verify = createVerifyScope({ resolveCredentials: async () => ({}) });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('credentials_missing');
    expect(r.hint).toContain('credentials_missing');
  });

  it('未知 kind → unknown_kind', async () => {
    const verify = createVerifyScope({ resolveCredentials: async () => ({ 'x': {} }) });
    const r = await verify({ tenantId: 't1', id: 'x', kind: 'generic-evil' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_kind: generic-evil');
  });

  it('探针被卸下（builtin:false）→ probe_not_implemented（不假绿，不宣称已接通）', async () => {
    // ⚠ P4 已交付内建探针，故本条须显式 builtin:false 才能复现「探针缺失」场景——
    //   「探针没装配」与「探针装配了但连不通」是两种故障，后者必须走真探测并如实报错。
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u', pass: 'p' } }),
      probes: {},
      builtin: false,
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('probe_not_implemented');
    expect(r.probe).toBe('imap_login');
    expect(r.hint).toContain('不宣称已接通');
  });

  it('P4 交付后生产默认装配内建探针（不再 probe_not_implemented，且真探测被调用）', async () => {
    let called = null;
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u', pass: 'p' } }),
      probes: { imap_login: async (a) => { called = a; return { ok: true }; } },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(true);
    expect(called).toBeTruthy();
    expect(called.credentials).toEqual({ user: 'u', pass: 'p' }); // 凭据真的传给了探针（不是空跑）
  });

  it('已注册探针 → 真探测执行且结果如实返回（fail-closed 拦截真实失败）', async () => {
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u', pass: 'p' } }),
      probes: { imap_login: async () => ({ ok: false, error: 'imap_auth_failed' }) },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('imap_auth_failed');
  });

  it('已注册探针通过 → ok:true（含 probe 名与 verified_at）', async () => {
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u', pass: 'p' } }),
      probes: { wecom_api: async () => ({ ok: true }) },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-wechat-1', kind: 'generic-wechat' });
    expect(r.ok).toBe(true);
    expect(r.probe).toBe('wecom_api');
    expect(r.verified_at).toBeTruthy();
  });

  it('显式传入凭据（verify_only 场景）→ **不查 vault**，探针真被调用', async () => {
    // 真实缺陷回归：接入向导② verify_only=true 不落库，若 verifyScope 只查 vault 则恒
    //   credentials_missing ⇒ 探针从不执行 ⇒ 验证步骤结构性不可通过。
    let vaultQueried = false;
    let seen = null;
    const verify = createVerifyScope({
      resolveCredentials: async () => { vaultQueried = true; return {}; },
      probes: { imap_login: async (a) => { seen = a; return { ok: true }; } },
    });
    const r = await verify({
      tenantId: 't1', id: 'channel-email-1', kind: 'generic-email',
      credentials: { host: 'imap.x.com', user: 'u', pass: 'p' },
    });
    expect(r.ok).toBe(true);
    expect(vaultQueried, 'verify_only 不应查 vault（凭据由调用方提供）').toBe(false);
    expect(seen.credentials).toEqual({ host: 'imap.x.com', user: 'u', pass: 'p' });
  });

  it('未传凭据且 vault 空 → credentials_missing（与「凭据不全」是不同故障，不可混淆）', async () => {
    const verify = createVerifyScope({
      resolveCredentials: async () => ({}),
      probes: { imap_login: async () => ({ ok: true }) },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.error).toBe('credentials_missing');
  });

  it('vault 里的 JSON 字符串凭据 → 解析后交给探针（与 vault 读侧同形，不双重编码）', async () => {
    let seen = null;
    const verify = createVerifyScope({
      resolveCredentials: async () => ({ 'channel-email-1': '{"host":"imap.y.com","user":"u","pass":"p"}' }),
      probes: { imap_login: async (a) => { seen = a; return { ok: true }; } },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(true);
    expect(seen.credentials).toEqual({ host: 'imap.y.com', user: 'u', pass: 'p' });
  });

  it('探针报「缺哪个字段」→ missing 必须透传（否则用户只知道不通过、不知道改哪里）', async () => {
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u' } }),
      probes: { imap_login: async () => ({ ok: false, error: 'credentials_incomplete', missing: ['host', 'pass'] }) },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.error).toBe('credentials_incomplete');
    expect(r.missing).toEqual(['host', 'pass']);
  });

  it('探针报的服务端拒因（hint）必须透传（吞掉它＝把「授权机制不符」误读成「密码错」）', async () => {
    // 真实现场（2026-09-18，watchm@163.com 实测）：imap.163.com:993 握手/协议全通，
    //   对**登录密码**回 `A1 NO LOGIN Login error or password error`——真因是国内邮箱须用「客户端授权码」。
    //   探针已把该行脱敏后作为 hint 带出；此处锁定 verifyScope 不得在中间层吞掉它。
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u', pass: 'p' } }),
      probes: {
        imap_login: async () => ({
          ok: false, error: 'auth_failed', hint: 'A1 NO LOGIN Login error or password error',
        }),
      },
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('auth_failed');
    expect(r.hint).toContain('Login error or password error');
  });

  it('探针成功时的 detail 必须透传（证明真的取到数据，而非仅「连上了」）', async () => {
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { url: 'https://cal.example.com/dav/' } }),
      probes: { caldav_propfind: async () => ({ ok: true, detail: { status: 207, calendars: 2 } }) },
    });
    const r = await verify({ tenantId: 't1', id: 'ch-cal', kind: 'generic-calendar' });
    expect(r.ok).toBe(true);
    expect(r.detail).toEqual({ status: 207, calendars: 2 });
  });

  it('resolveCredentials 查询失败 → fail-closed（不因查询失败而放行）', async () => {
    const verify = createVerifyScope({ resolveCredentials: async () => { throw new Error('vault down'); } });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('vault down');
  });
});
