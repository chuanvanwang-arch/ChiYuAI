// src/portal/mcpIdentity.js — 连接器/MCP 身份配置（第 27 项）
// 零信任：token 仅存哈希（crm.mcp_identity.token_hash），明文仅创建时一次性返回前端
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { newStructuredToken } from '../mcp/tokenFormat.js';
import { hasRole } from '../http/middleware/rbac.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function roleOptions(roles = []) {
  return (roles || [])
    .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`)
    .join('');
}

// 状态徽标：启用 / 已吊销 / 过期（过期 = enabled 且 expires_at < now）
export function statusBadge(row = {}) {
  if (row.revoked_at) return `<span class="badge revoked">已吊销</span>`;
  if (row.enabled && row.expires_at && new Date(row.expires_at) < new Date()) return `<span class="badge expired">过期</span>`;
  return row.enabled ? `<span class="badge enabled">启用</span>` : `<span class="badge disabled">停用</span>`;
}

export function renderScopes(scopes = {}) {
  const s = scopes || {};
  if (!Object.keys(s).length) return `<span class="scopes empty">（全量）</span>`;
  const deny = Array.isArray(s.deny_domains) && s.deny_domains.length ? s.deny_domains.join(', ') : '';
  return `<span class="scopes">${deny ? `拒绝域: ${esc(deny)}` : esc(JSON.stringify(s))}</span>`;
}

export function renderMcpIdentities(rows = [], roles = []) {
  const list = rows || [];
  if (!list.length) return `<div class="empty">尚未配置任何 MCP 身份（crm.mcp_identity）</div>`;
  const roleOpts = roleOptions(roles);
  const trs = list
    .map((r) => `<tr class="mcp-row" data-id="${esc(r.id)}">
      <td class="m-actor"><input class="f-actor" value="${esc(r.actor)}" /></td>
      <td class="m-role"><select class="role-tag-select">${roleOpts}</select></td>
      <td class="m-scopes">${renderScopes(r.scopes)}</td>
      <td class="m-status">${statusBadge(r)}</td>
      <td class="m-exp">${r.expires_at ? esc(r.expires_at) : '—'}</td>
      <td class="m-ops">
        <button class="save-row">保存</button>
        <button class="revoke-row" ${r.revoked_at ? 'disabled' : ''}>吊销</button>
      </td>
    </tr>`)
    .join('');
  return `<table class="mcp-table"><thead><tr>
    <th>接入方(actor)</th><th>角色</th><th>域范围</th><th>状态</th><th>过期</th><th>操作</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

export function mcpIdentitySummary(rows = []) {
  const list = rows || [];
  const enabled = list.filter((r) => r.enabled && !r.revoked_at).length;
  const revoked = list.filter((r) => r.revoked_at).length;
  return { count: list.length, enabled, revoked };
}

const defaultDeps = {
  list: async () => {
    const r = await query(
      `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at
         FROM crm.mcp_identity ORDER BY created_at DESC`);
    const roles = await query(`SELECT role_tag FROM crm.role_context_profile ORDER BY role_tag`);
    return { rows: r.rows, roles: roles.rows.map((x) => x.role_tag) };
  },
  create: async (input) => {
    const { id, tokenPlain } = newStructuredToken();
    const r = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, actor, role_tag, enabled, revoked_at, tenant_id`,
      [id, tokenPlain, input.actor, input.person_id || null, input.role_tag,
       JSON.stringify(input.scopes || {}), input.expires_at || null,
       input.tenant_id || 'system']);   // 平台级接入方默认 system；租户接入方由管理页显式指定
    return { row: r.rows[0], token_plaintext: tokenPlain };
  },
  put: async (id, patch) => {
    // 吊销不可逆（与"绝对禁删"同源纪律）：已吊销行拒绝任何再修改，
    // 否则编辑操作会清空 revoked_at 使失效凭据复活（D5 安全事故）。
    const cur = (await query(
      `SELECT id, revoked_at FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
    if (!cur) return { notFound: true };
    if (cur.revoked_at) return { revoked: true };
    // 真 PATCH：只写"显式传入"的列（未传 → 不出现在 SET 中，避免被覆盖为 NULL）
    const COLS = ['actor', 'role_tag', 'scopes', 'enabled', 'expires_at', 'revoked_at'];
    const sets = []; const vals = [id]; let n = 1;
    for (const c of COLS) {
      if (!(c in patch)) continue;
      n += 1;
      sets.push(`${c}=$${n}${c === 'scopes' ? '::jsonb' : ''}`);
      vals.push(c === 'scopes' ? JSON.stringify(patch[c] || {}) : patch[c]);
    }
    if (!sets.length) return { noop: true };
    const r = await query(
      `UPDATE crm.mcp_identity SET ${sets.join(', ')}
        WHERE id=$1 RETURNING id, actor, role_tag, enabled, revoked_at`, vals);
    return { row: r.rows[0] || null };
  },
  // 按 username 反查 user_id（JWT 不含 user_id，方案 B 绑定 person_id 用）；用户不存在返回 null
  findUserId: async (username) => {
    const r = await query(`SELECT user_id FROM crm.crm_users WHERE username=$1 LIMIT 1`, [username]);
    return r.rows[0]?.user_id || null;
  },
  // 个人「我的 API Key」（方案 A→B 升级口径）：person_id 绑定优先，存量 NULL 行按 actor+租户兜底
  listMine: async (username, tenantId) => {
    const uid = await defaultDeps.findUserId(username);
    const r = await query(
      `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at
         FROM crm.mcp_identity
        WHERE ($1::uuid IS NOT NULL AND person_id = $1)
           OR (person_id IS NULL AND actor = $2 AND (tenant_id IS NULL OR tenant_id = $3))
        ORDER BY created_at DESC`, [uid, username, tenantId || 'system']);
    return r.rows;
  },
  // 自助创建（方案 B docs/2026-09-05-my-api-keys-self-service-design.md）：
  // actor/role_tag/person_id/tenant_id 全部服务端强制；token 明文仅本次返回；启用身份上限 5
  createMine: async (me) => {
    const uid = await defaultDeps.findUserId(me.username);
    const cnt = (await query(
      `SELECT COUNT(*)::int AS c FROM crm.mcp_identity
        WHERE enabled IS TRUE AND revoked_at IS NULL
          AND (($1::uuid IS NOT NULL AND person_id = $1) OR (person_id IS NULL AND actor = $2))`,
      [uid, me.username])).rows[0].c;
    if (cnt >= 5) return { error: '启用中的 API Key 已达上限（5 个），请先吊销不用的身份' };
    const { id, tokenPlain } = newStructuredToken();
    const r = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, enabled, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, '{}'::jsonb, TRUE, $6)
       RETURNING id, actor, person_id, role_tag, scopes, enabled, revoked_at`,
      [id, tokenPlain, me.username, uid, me.role, me.tenantId || 'system']);
    return { row: r.rows[0], token_plaintext: tokenPlain };
  },
  // 自助吊销（仅本人身份；仅 revoked_at 软标记，禁删不变）
  revokeMine: async (me, id) => {
    const uid = await defaultDeps.findUserId(me.username);
    const own = (await query(
      `SELECT id FROM crm.mcp_identity
        WHERE id=$1 AND (($2::uuid IS NOT NULL AND person_id = $2) OR (person_id IS NULL AND actor = $3))`,
      [id, uid, me.username])).rows[0];
    if (!own) return null;
    const r = await query(
      `UPDATE crm.mcp_identity SET revoked_at = now(), enabled = FALSE
        WHERE id=$1 RETURNING id, actor, person_id, role_tag, enabled, revoked_at`, [id]);
    return r.rows[0] || null;
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createMcpIdentityRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  // 管理通道统一闸：MCP 身份签发 = 平台最高敏感写，仅 ADMIN。
  // 与 createConfigLevelGate（rbac.js:86，路径精确匹配）纵深防御——
  // 全局闸覆盖 /api/mcp-identities 精确路径，本闸覆盖含参数的子路径（如 PUT /:id）。
  const requireAdmin = async (req, res) => {
    const me = await D.resolveMe(req);
    if (!me?.ok) { res.status(401).json({ error: me?.error || '未登录' }); return null; }
    if (!hasRole(me, 'ADMIN')) {
      res.status(403).json({ error: 'MCP 身份签发仅 ADMIN 可操作（凭据签发为平台最高敏感写）' });
      return null;
    }
    return me;
  };
  const router = Router();
  const handlers = {
    // 个人「我的 API Key」（只读，任意登录角色；零信任：永不回显 token_hash/明文）
    me: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok) return res.status(401).json({ error: me?.error || '未登录' });
        const rows = await D.listMine(me.username, me.tenantId);
        const safe = (rows || []).map(({ token_hash, ...rest }) => rest);
        res.json({ rows: safe });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    // 自助创建（方案 B）：业务角色白名单；平台级角色（admin/sysadmin/ten_admin）须走管理页
    meCreate: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok) return res.status(401).json({ error: me?.error || '未登录' });
        const SELF_ROLES = ['sales', 'manager', 'presales', 'contract_admin', 'finance'];
        if (!SELF_ROLES.includes(me.role)) {
          return res.status(403).json({ error: `角色 ${me.role} 不可自助创建，请管理员在「连接器 / MCP 身份配置」中操作` });
        }
        const created = await D.createMine(me);
        if (created?.error) return res.status(400).json({ error: created.error });
        const decision = await D.produceDecision({ key: 'mcp-identity-self', type: 'mcp_identity_self_create', id: created.row.id });
        res.json({ row: created.row, token_plaintext: created.token_plaintext, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
    // 自助吊销（方案 B）：仅本人身份、仅 revoked_at 软标记
    meRevoke: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok) return res.status(401).json({ error: me?.error || '未登录' });
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'id 必填' });
        const row = await D.revokeMine(me, id);
        if (!row) return res.status(404).json({ error: '身份不存在或不属于你' });
        const decision = await D.produceDecision({ key: 'mcp-identity-self', type: 'mcp_identity_self_revoke', id });
        res.json({ ok: true, row, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
    list: async (req, res) => {
      try {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { rows, roles } = await D.list();
        const safe = (rows || []).map(({ token_hash, ...rest }) => rest);
        res.json({ rows: safe, roles });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    create: async (req, res) => {
      try {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { actor, person_id, role_tag, scopes, expires_at, tenant_id } = req.body || {};
        if (!actor || !role_tag) return res.status(400).json({ error: 'actor 与 role_tag 必填' });
        const created = await D.create({ actor, person_id, role_tag, scopes, expires_at, tenant_id });
        const decision = await D.produceDecision({ key: 'mcp-identity', id: created.row.id });
        res.json({ id: created.row.id, token_plaintext: created.token_plaintext, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
    put: async (req, res) => {
      try {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { id } = req.params;
        const { actor, role_tag, scopes, enabled, expires_at, revoked_at } = req.body || {};
        const patch = {};
        if (actor !== undefined) patch.actor = actor;
        if (role_tag !== undefined) patch.role_tag = role_tag;
        if (scopes !== undefined) patch.scopes = scopes;
        if (enabled !== undefined) patch.enabled = enabled;
        if (expires_at !== undefined) patch.expires_at = expires_at;
        if (revoked_at !== undefined) patch.revoked_at = revoked_at;
        if (patch.revoked_at) patch.enabled = false; // 吊销 = 软标记 + 停用
        const updated = await D.put(id, patch);
        if (updated?.notFound) return res.status(404).json({ error: '身份不存在' });
        if (updated?.revoked)  return res.status(409).json({ error: '身份已吊销，不可再修改（吊销不可逆）' });
        if (updated?.noop)     return res.status(400).json({ error: '无可更新字段' });
        const decision = await D.produceDecision({ key: 'mcp-identity', id });
        res.json({ ok: true, row: updated.row, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
  };
  router.get('/api/mcp-identities/me', handlers.me); // 须在 /api/mcp-identities 之前注册（路径更具体）
  router.post('/api/mcp-identities/me', handlers.meCreate); // 方案 B：自助创建（mine/:id 为两段路径，与 PUT /:id 无冲突，仍先注册求清晰）
  router.put('/api/mcp-identities/mine/:id', handlers.meRevoke);
  router.get('/api/mcp-identities', handlers.list);
  router.post('/api/mcp-identities', handlers.create);
  router.put('/api/mcp-identities/:id', handlers.put);
  router.handlers = handlers; // 无 delete（绝对禁删）
  return router;
}

// 一次性幂等回填：存量 person_id IS NULL 的身份按 username(+租户) 绑定 crm_users.user_id。
// 仅 UPDATE（不违反禁删）；幂等（回填后不再命中 IS NULL）；失败由调用方兜底（仅日志不阻断启动）。
export async function backfillPersonIds() {
  const r = await query(
    `UPDATE crm.mcp_identity m SET person_id = u.user_id
       FROM crm.crm_users u
      WHERE m.person_id IS NULL AND m.actor = u.username
        AND COALESCE(u.tenant_id, 'system') = COALESCE(m.tenant_id, 'system')`);
  return r.rowCount ?? 0;
}
