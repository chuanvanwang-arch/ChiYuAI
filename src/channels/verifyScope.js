// src/channels/verifyScope.js — 接入向导② 的 verifyScope 生产默认：真探测 fail-closed
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5.1 步骤②
// 红线：不 mock 代真；凭据缺 → credentials_missing（明确提示「需补齐凭据」）；
//       真实探测未交付（P4）→ probe_not_implemented（**如实上报，不假绿**——
//       未接通不得宣称已接通，对齐需求④ Q2-5 红线）。
// 契约：verifyScope({ tenantId, id, kind }) → { ok, error?, probe?, hint? }
import { resolveCredentials as vaultResolve, parseCredentialPayload } from '../connectors/discovery/credentialVault.js';
// kind→probe 映射单一事实源（见 channels/kinds.js）
import { KIND_PROBE } from './kinds.js';
// P4 真实探针实现（imap_login/caldav_propfind/meeting_api_list/wecom_api，见 probes.js）
import { CHANNEL_PROBE_IMPLS } from './probes.js';

// 探针注册表：**默认装配内建真实探针**（P4 已交付实现）。
//   `builtin:false` 可整体卸下（测试保留「探针缺失 → probe_not_implemented」的 fail-closed 契约）；
//   `probes:{...}` 可逐个覆盖（租户专属探测 / 测试桩）；registerChannelProbe 仍可后置注入。
//   ⚠ 任一探针为 null ⇒ 如实返回 probe_not_implemented（阻塞 connect，不让「未验证」伪装成「已验证」）。
const PROBE_REGISTRY = { ...CHANNEL_PROBE_IMPLS };

// P4 注入点：registerChannelProbe('imap_login', async ({tenantId,id,kind,credentials}) => ({ ok:true }))
export function registerChannelProbe(name, fn) {
  if (typeof fn !== 'function') throw new Error('registerChannelProbe 需要函数');
  PROBE_REGISTRY[name] = fn;
}

export function createVerifyScope({ resolveCredentials = vaultResolve, probes = {}, builtin = true } = {}) {
  // builtin:false → 卸下内建真实探针（用于保留「探针未装配 ⇒ 不许放行」的 fail-closed 契约测试）
  const registry = { ...(builtin ? PROBE_REGISTRY : {}), ...probes };
  return async function verifyScope({ tenantId = 'system', id, kind, credentials } = {}) {
    try {
      const probeName = KIND_PROBE[kind];
      if (!probeName) return { ok: false, error: `unknown_kind: ${kind}` };
      // ① 凭据获取（fail-closed：缺凭据 → credentials_missing 明确提示）
      //    **调用方显式传入优先**（`credentials` 参数）：接入向导② 用 verify_only=true **不落库**，
      //    此时 vault 里必然没有凭据——若仍只查 vault，则永远返回 credentials_missing、
      //    探针**一次都不会被调用**，「验证」步骤结构性不可通过（用户永远看不到探测结果）。
      //    该凭据仅用于当次探测（verify_only 不落库），与落库路径互不替代。
      //    查询本身失败（vault 不可用）→ 如实上报（与「未配凭据」是不同故障，不可混淆）
      let cred = null;
      const inline = credentials && typeof credentials === 'object' && Object.keys(credentials).length ? credentials : null;
      if (inline) {
        cred = inline;
      } else {
        let creds = null;
        try {
          creds = await resolveCredentials({ tenantId, providerIds: [id] });
        } catch (e) {
          return { ok: false, error: String(e?.message || e), hint: '凭据库查询失败（非未配凭据），接入暂停' };
        }
        if (!creds || !creds[id]) {
          return { ok: false, error: 'credentials_missing', hint: '该通道需补齐凭据（credentials_missing）' };
        }
        cred = creds[id];
      }
      // 单串密钥也可能是 JSON 结构化凭据（A-B2）→ 统一解析，与 vault 读侧同形
      if (typeof cred === 'string') cred = parseCredentialPayload(cred);
      // ② 真实探测：未注册（P4 未交付）→ probe_not_implemented（如实，不假绿）
      const probe = registry[probeName];
      if (typeof probe !== 'function') {
        return {
          ok: false, error: 'probe_not_implemented', probe: probeName,
          hint: '真实通道连通（P4）未交付；凭据已保存但未验证（不宣称已接通）',
        };
      }
      const r = await probe({ tenantId, id, kind, credentials: cred })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      // missing 必须透传：否则前端只能显示「credentials_incomplete」，用户不知道缺哪个字段
      //   （「不知道改哪里」的失败与「密码错」一样具有误导性）
      // hint 同样必须透传（2026-09-18）：服务端拒因（如 163 的 `LOGIN Login error or password error`
      //   ＝需用客户端授权码）被吞掉后，用户只会反复改密码，方向被误导（假失败）。
      if (!r?.ok) {
        return {
          ok: false, error: r?.error || 'verify_failed', probe: probeName,
          missing: r?.missing || null, hint: r?.hint || null,
        };
      }
      // detail 保留：证明**真的取到了数据**（如会议条数），而不只是「连上了」
      return { ok: true, probe: probeName, verified_at: new Date().toISOString(), detail: r?.detail ?? null };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  };
}
