// test/connectors/discovery/credentialVaultNoPlatform.test.js — P0-1（红线：不保存密码）
// 判据：用户侧形态（connector / local-bridge）凭据**绝不落平台 vault**；direct / 缺省(legacy) 仍按既有加密落库。
import { describe, it, expect } from 'vitest';
import { persistSecret, resolveCredentials } from '../../../src/connectors/discovery/credentialVault.js';

function makeDeps() {
  const store = {};
  return {
    store,
    deps: {
      readConfig: async (key) => (store[key] ? { value: store[key] } : null),
      writeConfig: async (key, value) => { store[key] = value; return { ok: true }; },
      pgpEncrypt: async (raw) => 'ENC:' + raw,
      decrypt: async (enc) => String(enc).replace('ENC:', ''),
      symKey: 'test-key',
    },
  };
}

describe('credentialVault 红线：用户侧形态不落平台（P0-1）', () => {
  it('local-bridge 凭据 → 拒存（ERR_CREDENTIAL_NOT_PLATFORM_HELD），vault 不得含该通道凭据', async () => {
    const { store, deps } = makeDeps();
    await expect(
      persistSecret({ tenantId: 't1', providerId: 'ch-email-1', raw: { user: 'u', pass: 'p' }, sourceKind: 'local-bridge', deps }),
    ).rejects.toThrow(/ERR_CREDENTIAL_NOT_PLATFORM_HELD/);
    const resolved = await resolveCredentials({ tenantId: 't1', providerIds: ['ch-email-1'], deps });
    expect(resolved['ch-email-1']).toBeNull();
  });

  it('connector 凭据 → 同样拒存（仅 direct 归平台持有）', async () => {
    const { store, deps } = makeDeps();
    await expect(
      persistSecret({ tenantId: 't1', providerId: 'ch-email-2', raw: { token: 't' }, sourceKind: 'connector', deps }),
    ).rejects.toThrow(/ERR_CREDENTIAL_NOT_PLATFORM_HELD/);
    const resolved = await resolveCredentials({ tenantId: 't1', providerIds: ['ch-email-2'], deps });
    expect(resolved['ch-email-2']).toBeNull();
  });

  it('direct 凭据 → 可加密落库（向后兼容；legacy 缺省 sourceKind 也按 direct 存）', async () => {
    const { store, deps } = makeDeps();
    await persistSecret({ tenantId: 't1', providerId: 'ch-email-3', raw: { user: 'a', pass: 'p' }, sourceKind: 'direct', deps });
    const resolved = await resolveCredentials({ tenantId: 't1', providerIds: ['ch-email-3'], deps });
    expect(resolved['ch-email-3']).toEqual({ user: 'a', pass: 'p' });

    // 缺省（legacy 调用方不传 sourceKind）→ 仍按 direct 存
    await expect(persistSecret({ tenantId: 't1', providerId: 'ch-email-4', raw: { user: 'b', pass: 'q' }, deps })).resolves.toBeTruthy();
    const r2 = await resolveCredentials({ tenantId: 't1', providerIds: ['ch-email-4'], deps });
    expect(r2['ch-email-4']).toEqual({ user: 'b', pass: 'q' });
  });
});
