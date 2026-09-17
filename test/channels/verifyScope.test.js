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

  it('凭据在但探针未交付（P4）→ probe_not_implemented（不假绿，不宣称已接通）', async () => {
    const verify = createVerifyScope({
      resolveCredentials: async ({ providerIds }) => ({ [providerIds[0]]: { user: 'u', pass: 'p' } }),
      probes: {}, // 未注册 → P4 未交付
    });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('probe_not_implemented');
    expect(r.probe).toBe('imap_login');
    expect(r.hint).toContain('不宣称已接通');
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

  it('resolveCredentials 查询失败 → fail-closed（不因查询失败而放行）', async () => {
    const verify = createVerifyScope({ resolveCredentials: async () => { throw new Error('vault down'); } });
    const r = await verify({ tenantId: 't1', id: 'channel-email-1', kind: 'generic-email' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('vault down');
  });
});
