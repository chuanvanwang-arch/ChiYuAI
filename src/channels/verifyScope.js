// src/channels/verifyScope.js — 接入向导② 的 verifyScope 生产默认：真探测 fail-closed
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5.1 步骤②
// 红线：不 mock 代真；凭据缺 → credentials_missing（明确提示「需补齐凭据」）；
//       真实探测未交付（P4）→ probe_not_implemented（**如实上报，不假绿**——
//       未接通不得宣称已接通，对齐需求④ Q2-5 红线）。
// 契约：verifyScope({ tenantId, id, kind }) → { ok, error?, probe?, hint? }
import { resolveCredentials as vaultResolve } from '../connectors/discovery/credentialVault.js';
// kind→probe 映射单一事实源（见 channels/kinds.js）
import { KIND_PROBE } from './kinds.js';

// 探针注册表：P4 交付真实探针后 registerChannelProbe 注入；
//   未注册 → verifyScope 如实返回 probe_not_implemented（阻塞 connect，不让「未验证」伪装成「已验证」）。
const PROBE_REGISTRY = {
  imap_login: null,
  caldav_propfind: null,
  meeting_api_list: null,
  wecom_api: null,
};

// P4 注入点：registerChannelProbe('imap_login', async ({tenantId,id,kind,credentials}) => ({ ok:true }))
export function registerChannelProbe(name, fn) {
  if (typeof fn !== 'function') throw new Error('registerChannelProbe 需要函数');
  PROBE_REGISTRY[name] = fn;
}

export function createVerifyScope({ resolveCredentials = vaultResolve, probes = {} } = {}) {
  const registry = { ...PROBE_REGISTRY, ...probes };
  return async function verifyScope({ tenantId = 'system', id, kind } = {}) {
    try {
      const probeName = KIND_PROBE[kind];
      if (!probeName) return { ok: false, error: `unknown_kind: ${kind}` };
      // ① 凭据存在性（fail-closed：缺凭据 → credentials_missing 明确提示）
      //    查询本身失败（vault 不可用）→ 如实上报（与「未配凭据」是不同故障，不可混淆）
      let creds = null;
      try {
        creds = await resolveCredentials({ tenantId, providerIds: [id] });
      } catch (e) {
        return { ok: false, error: String(e?.message || e), hint: '凭据库查询失败（非未配凭据），接入暂停' };
      }
      if (!creds || !creds[id]) {
        return { ok: false, error: 'credentials_missing', hint: '该通道需补齐凭据（credentials_missing）' };
      }
      // ② 真实探测：未注册（P4 未交付）→ probe_not_implemented（如实，不假绿）
      const probe = registry[probeName];
      if (typeof probe !== 'function') {
        return {
          ok: false, error: 'probe_not_implemented', probe: probeName,
          hint: '真实通道连通（P4）未交付；凭据已保存但未验证（不宣称已接通）',
        };
      }
      const r = await probe({ tenantId, id, kind, credentials: creds[id] })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!r?.ok) return { ok: false, error: r?.error || 'verify_failed', probe: probeName };
      return { ok: true, probe: probeName, verified_at: new Date().toISOString() };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  };
}
