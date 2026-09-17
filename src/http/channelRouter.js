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
export function createChannelRouter({ readConfig, writeConfig, reviewGate, verifyScope, persistSecret } = {}) {
  // 凭据落密默认走 credentialVault.persistSecret（若不注入）
  const saveSecret = persistSecret || (async ({ tenantId, providerId, raw }) => {
    const m = await import('../connectors/discovery/credentialVault.js');
    return m.persistSecret({ tenantId, providerId, raw });
  });

  async function get(req, res) {
    const tenantId = req.query.tenant_id || req.body?.tenant_id || 'system';
    try {
      const row = await readConfig('integration-providers', { tenantId });
      const list = (Array.isArray(row?.value) ? row.value : []).filter((d) => d.kind?.startsWith('generic-'));
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
    if (!id || !kind || !kind.startsWith('generic-')) return res.status(400).json({ ok: false, error: 'kind_invalid' });
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
    await writeConfig('integration-providers', list, { tenantId, updatedBy: req?.user?.id || 'system' });
    res.json({ ok: true, stored: true, channel: { id, kind, enabled: true, trust_level }, hint: '首次只读（L1），信任提升过独立闸门' });
  }

  async function disconnect(req, res) {
    const tenantId = req.query.tenant_id || req.body?.tenant_id || 'system';
    try {
      const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
      const list = Array.isArray(row?.value) ? row.value : [];
      const d = list.find((x) => x.id === req.params.id);
      if (!d) return res.status(404).json({ ok: false, error: 'channel_not_found' });
      d.enabled = false;
      await writeConfig('integration-providers', list, { tenantId, updatedBy: req?.user?.id || 'system' });
      res.json({ ok: true, channel: { id: d.id, enabled: false } });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  return { handlers: { get, connect, disconnect } };
}
