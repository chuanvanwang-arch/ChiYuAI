// src/http/channelRouter.js — 需求② §4.5/§4.6 后端：通道配置读写 + 接入向导三步（WorkBuddy/网页两入口共用）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5（系统主导 Onboarding 向导）+ §8 裁决
// 红线（§4.5.1/§8）：
//   ① 凭据直进 credentialVault（明文不落响应/审计/会话）——persistSecret 加密落库；
//   ② 接入=四类动作 first-connect → 过 review-gate（HITL 人工闸）；
//   ③ verifyScope 真探测 fail-closed（不 mock 代真）；
//   ④ 禁删铁律：disconnect=enabled:false 软停用（不物理删除描述符）。
// 范式：handlers 直调式（与 configRouter.test.js 同范式），routes.js 里以 app.get/post 接线。
// 契约：
//   GET  /api/channels                  → 租户通道列表（来自 integration-providers，含 enabled/trust_level）
//   POST /api/channels/connect          → 接入向导③确认入库（凭据入 vault→verifyScope 探测→review-gate→描述符 upsert）
//   POST /api/channels/:id/disconnect   → 软停用（enabled=false）
// 写闸（与 configRouter 同源，同一键 `integration-providers` 不得两套写语义）：
//   config-store 写前铸 `config-change` 决策（produceConfigDecision 单一实现）→ decisionId 落 writeConfig。
//   connect 另加 review-gate（§4.5.1 ③ first-connect HITL）；两者是不同闸，缺一不可。
// 通道 kind 判据单一事实源（channels/kinds.js）：
//   ⚠ 不得用 `kind.startsWith('generic-')` 判定——`generic-rest/mcp/cli` 同前缀但**不是通道**
//   （会把通用数据源错当通道展示/接入＝同名前缀两义）。configRouter 的 VALID_KINDS 与之 kind 域不相交。
import { isChannelKind } from '../channels/kinds.js';

export function createChannelRouter({ readConfig, writeConfig, reviewGate, verifyScope, persistSecret, produceDecision } = {}) {
  // 凭据落密默认走 credentialVault.persistSecret（若不注入）
  const saveSecret = persistSecret || (async ({ tenantId, providerId, raw }) => {
    const m = await import('../connectors/discovery/credentialVault.js');
    return m.persistSecret({ tenantId, providerId, raw });
  });

  async function get(req, res) {
    const tenantId = req.query.tenant_id || req.body?.tenant_id || 'system';
    try {
      const row = await readConfig('integration-providers', { tenantId });
      // 只呈现**通道**（isChannelKind）；通用数据源（generic-rest/mcp/cli）归 /api/integration/providers 面
      const list = (Array.isArray(row?.value) ? row.value : []).filter((d) => isChannelKind(d.kind));
      res.json({
        ok: true,
        channels: list.map(({ id, kind, label, enabled, trust_level, objects }) => ({
          id, kind, label, enabled, trust_level, objects: Array.isArray(objects) ? objects : [],
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  async function connect(req, res) {
    const tenantId = req.body?.tenant_id || req.query.tenant_id || 'system';
    const { id, kind, credentials, trust_level = 'L1', objects = [], label } = req.body || {};
    if (!id || !isChannelKind(kind)) return res.status(400).json({ ok: false, error: 'kind_invalid' });
    // ① 凭据直进 vault（明文不落响应/审计）
    if (credentials && typeof credentials === 'object' && Object.keys(credentials).length) {
      try {
        await saveSecret({ tenantId, providerId: id, raw: credentials });
      } catch (e) {
        return res.status(500).json({ ok: false, error: `credential_store_failed: ${e?.code || e?.message || e}` });
      }
    }
    // ② verifyScope 真探测（fail-closed；缺凭据→credentials_missing 明确提示）
    if (typeof verifyScope === 'function') {
      const v = await verifyScope({ tenantId, id, kind }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!v?.ok) return res.status(400).json({ ok: false, error: v?.error || 'verify_failed', hint: '该通道需补齐凭据（credentials_missing）' });
    }
    // ③ 接入=四类动作 first-connect → 过 review-gate（HITL 人工闸）
    if (reviewGate && typeof reviewGate.hasApproval === 'function') {
      const a = await reviewGate.hasApproval({ action: 'first-connect', tenantId, ctx: { id, kind } }).catch(() => null);
      if (!a) return res.status(403).json({ ok: false, error: 'approval_required' });
    }
    // 描述符 upsert（禁删铁律：改 enabled/trust_level 不动删除）
    const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
    const list = Array.isArray(row?.value) ? row.value : [];
    const idx = list.findIndex((d) => d.id === id);
    const desc = { id, kind, label: label || kind, enabled: true, trust_level, objects: Array.isArray(objects) ? objects : [] };
    if (idx >= 0) list[idx] = desc; else list.push(desc);
    // 配置写第 0 闸（与 configRouter 同源）：铸 config-change 决策，decisionId 落库（写无决策不留白）
    const decision = typeof produceDecision === 'function'
      ? await produceDecision('config-change', { key: 'integration-providers', action: 'connect', id, kind }).catch(() => null)
      : null;
    await writeConfig('integration-providers', list, {
      tenantId, decisionId: decision?.decisionId || null, updatedBy: req?.user?.id || 'system',
    });
    res.json({
      ok: true, stored: true, channel: { id, kind, enabled: true, trust_level },
      decision: decision?.decisionId || null,
      hint: '首次只读（L1），信任提升过独立闸门',
    });
  }

  async function disconnect(req, res) {
    const tenantId = req.query.tenant_id || req.body?.tenant_id || 'system';
    try {
      const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
      const list = Array.isArray(row?.value) ? row.value : [];
      const d = list.find((x) => x.id === req.params.id);
      if (!d) return res.status(404).json({ ok: false, error: 'channel_not_found' });
      d.enabled = false;
      // 配置写第 0 闸（与 configRouter 同源）
      const decision = typeof produceDecision === 'function'
        ? await produceDecision('config-change', { key: 'integration-providers', action: 'disconnect', id: d.id }).catch(() => null)
        : null;
      await writeConfig('integration-providers', list, {
        tenantId, decisionId: decision?.decisionId || null, updatedBy: req?.user?.id || 'system',
      });
      res.json({ ok: true, channel: { id: d.id, enabled: false }, decision: decision?.decisionId || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  return { handlers: { get, connect, disconnect } };
}
