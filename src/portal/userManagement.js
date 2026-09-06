// src/portal/userManagement.js — 用户管理配置（第 12 项，端点 + 可编辑，含 org/角色绑定）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/POST/PUT 端点（决策第0闸 + 字段白名单 + sysadmin 权限）
// 设计输入：docs/superpowers/plans/2026-08-27-user-management-config.md
// 后端事实：crm.crm_users（db/schema.sql 326 行）；密码 crypt hash；无 updated_at 列（变更时间由 config_change 事件承载）
// 红线：密码必 hash、明文不落库不回显、sysadmin(role=admin) 权限、绝对禁 DELETE、写经决策第0闸
import { Router } from 'express';
import { query } from '../db.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
import { SeatLimitError } from '../billing/seatPolicy.js';

// 角色白名单（对齐审批流种子 role 枚举 + role_context_profile；新增 sysadmin/ten_admin）
export const ROLE_TAGS = ['sales', 'manager', 'presales', 'contract_admin', 'finance', 'admin', 'ten_admin', 'sysadmin'];
// PUT 可编辑字段白名单（user_id/username/created_at 锁定）
export const EDITABLE_FIELDS = ['display_name', 'role', 'org_id', 'password', 'enabled', 'expires_at'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 校验 PUT body.patch；返回 { ok, errors, normalized }
export function validateUserPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${EDITABLE_FIELDS.join('/')} 可改）`] };
  }
  if (!keys.length) return { ok: false, errors: ['无有效编辑字段'] };
  const errors = [];
  const n = {};
  if ('display_name' in patch) {
    if (typeof patch.display_name !== 'string' || patch.display_name.length > 64) errors.push('display_name 须为 ≤64 字字符串');
    else n.display_name = patch.display_name;
  }
  if ('role' in patch) {
    if (!ROLE_TAGS.includes(patch.role)) errors.push(`role 须为 ${ROLE_TAGS.join('/')}`);
    else n.role = patch.role;
  }
  if ('org_id' in patch) {
    if (patch.org_id !== null && typeof patch.org_id !== 'string') errors.push('org_id 须为字符串或 null');
    else n.org_id = patch.org_id;
  }
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') errors.push('enabled 须为布尔');
    else n.enabled = patch.enabled;
  }
  if ('password' in patch) {
    if (typeof patch.password !== 'string' || patch.password.length < 8) errors.push('password 须为 ≥8 字字符串');
    else n.password = patch.password;
  }
  if ('expires_at' in patch) {
    // null = 清除有效期（永久）；字符串须为合法可解析时间
    if (patch.expires_at === null) n.expires_at = null;
    else if (typeof patch.expires_at === 'string' && !Number.isNaN(Date.parse(patch.expires_at))) n.expires_at = patch.expires_at;
    else errors.push('expires_at 须为合法时间字符串或 null');
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// 校验 POST body；返回 { ok, errors, normalized }
export function validateCreateUser(body = {}) {
  const errors = [];
  const n = {};
  if (!body.username || typeof body.username !== 'string') errors.push('username 必填');
  else n.username = body.username;
  if (!body.password || typeof body.password !== 'string' || body.password.length < 8) errors.push('password 须为 ≥8 字字符串');
  else n.password = body.password;
  if (!body.role || !ROLE_TAGS.includes(body.role)) errors.push(`role 须为 ${ROLE_TAGS.join('/')}`);
  else n.role = body.role;
  if (body.display_name != null) {
    if (typeof body.display_name !== 'string' || body.display_name.length > 64) errors.push('display_name 须为 ≤64 字字符串');
    else n.display_name = body.display_name;
  }
  if (body.org_id != null) {
    if (typeof body.org_id !== 'string') errors.push('org_id 须为字符串');
    else n.org_id = body.org_id;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

function fmtExpire(v) {
  if (!v) return '永久';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '永久';
  return d.toLocaleString('zh-CN', { hour12: false });
}
function isExpired(v) {
  if (!v) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}
function statusCell(u) {
  if (!u.enabled) return '<span class="badge off">⛔冻结</span>';
  if (isExpired(u.expires_at)) return '<span class="badge off">⏰已过期</span>';
  return '<span class="badge ok">✅启用</span>';
}

function rowHtml(u) {
  return `<tr data-id="${esc(u.user_id || '')}">
    <td><input type="checkbox" class="ucheck" data-uid="${esc(u.user_id || '')}" /></td>
    <td>${esc(u.username || '')}</td>
    <td>${esc(u.display_name || '')}</td>
    <td><span class="role-tag">${esc(u.role || '')}</span></td>
    <td>${esc(u.org_id || '—')}</td>
    <td>${statusCell(u)}</td>
    <td>${esc(fmtExpire(u.expires_at))}</td>
    <td><button class="btn edit" data-id="${esc(u.user_id || '')}">编辑</button></td>
  </tr>`;
}

// 按租户分组的只读表格渲染（成批选择 + 有效期展示）
export function renderUsers(users = []) {
  if (!users.length) return '<div class="empty">无用户配置</div>';
  const byTenant = {};
  for (const u of users) (byTenant[u.tenant_id || 'system'] ||= []).push(u);
  return Object.entries(byTenant)
    .map(
      ([tenant, list]) => `<section class="user-group" data-tenant="${esc(tenant)}">
        <h3><input type="checkbox" class="tenant-all" data-tenant="${esc(tenant)}" /> 租户 ${esc(tenant)} <span class="cnt">${list.length}</span></h3>
        <table class="user-tbl"><thead><tr><th></th><th>用户名</th><th>显示名</th><th>角色</th><th>org</th><th>状态</th><th>有效期</th><th>操作</th></tr></thead>
        <tbody>${list.map(rowHtml).join('')}</tbody></table>
      </section>`
    )
    .join('');
}

// 校验成批操作 body；返回 { ok, errors, normalized }
// action: enable(启用)/freeze(冻结)/set_expiry(设置有效期)；user_ids 非空 uuid 字符串数组；
// set_expiry 时 expires_at 必填（字符串或 null 清除）。
export function validateBatchUsers(body = {}) {
  const errors = [];
  const n = {};
  const ACTIONS = ['enable', 'freeze', 'set_expiry'];
  if (!body.action || !ACTIONS.includes(body.action)) errors.push(`action 须为 ${ACTIONS.join('/')}`);
  else n.action = body.action;
  if (!Array.isArray(body.user_ids) || body.user_ids.length === 0) errors.push('user_ids 须为非空数组');
  else if (body.user_ids.length > 500) errors.push('user_ids 单次上限 500');
  else if (!body.user_ids.every((x) => typeof x === 'string' && x.length > 0)) errors.push('user_ids 元素须为字符串');
  else n.user_ids = body.user_ids;
  if (body.action === 'set_expiry') {
    if (body.expires_at === null) n.expires_at = null; // 清除有效期
    else if (typeof body.expires_at === 'string' && !Number.isNaN(Date.parse(body.expires_at))) n.expires_at = body.expires_at;
    else errors.push('set_expiry 时 expires_at 必填（合法时间字符串或 null 清除）');
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// ---- 端点 ----
const defaultDeps = {
  // scope：具体租户字符串 → 仅该租户；null / '*' → 全量（admin 跨租户用户管理）。
  // 租户收敛（2026-09-04）：修复「切换销售视角」下拉经此端点泄露其它租户用户名。
  listUsers: async (scope) => {
    const scoped = scope && scope !== '*';
    const sql = scoped
      ? `SELECT user_id, username, display_name, role, org_id, enabled, tenant_id, expires_at, created_at FROM crm.crm_users WHERE tenant_id = $1 ORDER BY tenant_id, created_at`
      : `SELECT user_id, username, display_name, role, org_id, enabled, tenant_id, expires_at, created_at FROM crm.crm_users ORDER BY tenant_id, created_at`;
    return (await query(sql, scoped ? [scope] : [])).rows;
  },
  listRoleTags: async () => ROLE_TAGS,
  hashPassword: async (p) => (await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [p])).rows[0].h,
  createUser: async (username, passwordHash, role, displayName, orgId, tenantId) => {
    if (tenantId) {
      const { checkSeatLimit } = await import('../billing/seatPolicy.js');
      const seat = await checkSeatLimit(tenantId);
      if (!seat.ok) throw new SeatLimitError(seat.error);
    }
    const r = await query(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, enabled, tenant_id)
       VALUES($1, $2, $3, $4, $5, TRUE, $6) RETURNING user_id`,
      [username, passwordHash, role, displayName || username, orgId ?? null, tenantId ?? null]
    );
    return r.rows[0];
  },
  updateUser: async (user_id, patch, hashPassword) => {
    const sets = [];
    const params = [user_id];
    let i = 2;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'password') {
        const h = await hashPassword(v);
        sets.push(`password_hash=$${i}`);
        params.push(h);
        i++;
      } else if (k === 'enabled') {
        sets.push(`enabled=$${i}`);
        params.push(!!v);
        i++;
      } else if (['display_name', 'role', 'org_id'].includes(k)) {
        sets.push(`${k}=$${i}`);
        params.push(v);
        i++;
      } else if (k === 'expires_at') {
        sets.push(`expires_at=$${i}`);
        params.push(v); // 字符串或 null（清除有效期）
        i++;
      }
    }
    const r = await query(`UPDATE crm.crm_users SET ${sets.join(', ')} WHERE user_id=$1 RETURNING user_id`, params);
    return r.rows[0];
  },
  // 成批更新（启用/冻结/设置有效期）：单语句 UPDATE ... WHERE user_id = ANY($1::uuid[])
  batchUpdateUsers: async (action, user_ids, expires_at) => {
    const ids = `{${user_ids.map((x) => `"${x}"`).join(',')}}`;
    let sql, params;
    if (action === 'enable') { sql = `UPDATE crm.crm_users SET enabled=TRUE WHERE user_id = ANY($1::uuid[])`; params = [ids]; }
    else if (action === 'freeze') { sql = `UPDATE crm.crm_users SET enabled=FALSE WHERE user_id = ANY($1::uuid[])`; params = [ids]; }
    else { sql = `UPDATE crm.crm_users SET expires_at=$2 WHERE user_id = ANY($1::uuid[])`; params = [ids, expires_at ?? null]; }
    const r = await query(sql, params);
    return r.rowCount ?? 0;
  },
  resolveMe,
  recordDecisionEvent,
};

export function createUserRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const forbid = (res) => res.status(403).json({ error: '需要 sysadmin(admin) 权限' });

  const handlers = {
    get: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok) return forbid(res);
        const isAdmin = me.role === 'admin' || me.role === 'sysadmin';
        const isTenantAdmin = me.role === 'ten_admin';
        // 仅 admin/sysadmin/ten_admin/manager 可读；manager 与 ten_admin 仅限本租户（ten_admin 受自身租户约束，绝不跨租户）
        if (!isAdmin && !isTenantAdmin && me.role !== 'manager') return forbid(res);
        // 租户筛选（2026-09-04 租户作用域条）：复用与 tenantScopeBar 同款 ?tenant 参数
        //   ?tenant=me       → 严格按登录身份的具体租户（连 admin 也不泄露其它租户用户名）
        //   无参 / ?tenant=all → admin 跨租户全量（users.html 默认）
        //   ?tenant=<id>      → admin 收窄到指定租户
        //   manager / ten_admin 恒收敛本租户（ten_admin 仅能看自身租户用户）
        const q = req.query?.tenant;
        const myTenant = me.tenantId || 'system';
        const scope = (me.role === 'manager' || isTenantAdmin)
          ? myTenant
          : (!q || q === 'all') ? null
          : (q === 'me') ? myTenant
          : String(q).trim();
        res.json({ users: await D.listUsers(scope) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    post: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        const isAdmin = me.role === 'admin' || me.role === 'sysadmin';
        const isTenantAdmin = me.role === 'ten_admin';
        if (!me?.ok || (!isAdmin && !isTenantAdmin)) return forbid(res);
        const v = validateCreateUser(req.body || {});
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
        // ten_admin 禁止分配平台级角色（防越权创建 admin/sysadmin）
        if (isTenantAdmin && ['admin', 'sysadmin'].includes(v.normalized.role)) {
          return res.status(403).json({ error: 'ten_admin 不可分配 admin/sysadmin 角色' });
        }
        const hash = await D.hashPassword(v.normalized.password);
        const row = await D.createUser(
          v.normalized.username,
          hash,
          v.normalized.role,
          v.normalized.display_name,
          v.normalized.org_id,
          me.tenantId
        );
        const decision = await D.recordDecisionEvent('config_change', { type: 'user_create', username: v.normalized.username });
        res.json({ ok: true, userId: row?.user_id || null, decision: decision?.event_id || null });
      } catch (e) {
        if (e?.isSeat) return res.status(402).json({ error: e.message });
        res.status(400).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok) return forbid(res);
        const isAdmin = me.role === 'admin' || me.role === 'sysadmin';
        const isTenantAdmin = me.role === 'ten_admin';
        if (!isAdmin && !isTenantAdmin) return forbid(res);
        const { user_id, patch } = req.body || {};
        if (!user_id) return res.status(400).json({ error: 'user_id 必填' });
        // ten_admin 仅能编辑本租户用户，且不可触及平台级角色用户/目标角色
        if (isTenantAdmin) {
          const u = await D.query(`SELECT tenant_id, role FROM crm.crm_users WHERE user_id=$1`, [user_id]);
          if (!u.rows[0] || u.rows[0].tenant_id !== me.tenantId) return res.status(403).json({ error: '仅可编辑本租户用户' });
          if (['admin', 'sysadmin'].includes(u.rows[0].role)) return res.status(403).json({ error: 'ten_admin 不可编辑 admin/sysadmin 用户' });
          if (patch?.role && ['admin', 'sysadmin'].includes(patch.role)) {
            return res.status(403).json({ error: 'ten_admin 不可分配 admin/sysadmin 角色' });
          }
        }
        const v = validateUserPatch(patch);
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
        const decision = await D.recordDecisionEvent('config_change', {
          type: 'user_update',
          user_id,
          fields: Object.keys(v.normalized),
        });
        const row = await D.updateUser(user_id, v.normalized, D.hashPassword);
        if (!row) return res.status(404).json({ error: `未知 user_id: ${user_id}` });
        res.json({ ok: true, decision: decision?.event_id || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/users', handlers.get);
  router.post('/api/config/users', handlers.post);
  router.put('/api/config/users', handlers.put);
  // 成批操作（启用/冻结/设置有效期）：admin 权限 + 决策第0闸 + 单语句 ANY(uuid[]) 更新
  handlers.batch = async (req, res) => {
    try {
      const me = await D.resolveMe(req);
      if (!me?.ok) return forbid(res);
      const isAdmin = me.role === 'admin' || me.role === 'sysadmin';
      const isTenantAdmin = me.role === 'ten_admin';
      if (!isAdmin && !isTenantAdmin) return forbid(res);
      const v = validateBatchUsers(req.body || {});
      if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
      const { action, user_ids, expires_at } = v.normalized;
      // ten_admin 仅能批量操作本租户用户（全量 user_ids 必须均属本租户）
      if (isTenantAdmin) {
        const ids = `{${user_ids.map((x) => `"${x}"`).join(',')}}`;
        const cnt = (await D.query(`SELECT COUNT(*)::int AS c FROM crm.crm_users WHERE user_id = ANY($1::uuid[]) AND tenant_id=$2`, [ids, me.tenantId])).rows[0].c;
        if (cnt !== user_ids.length) return res.status(403).json({ error: '仅可操作本租户用户' });
      }
      const decision = await D.recordDecisionEvent('config_change', {
        type: 'user_batch_update',
        action,
        count: user_ids.length,
      });
      const updated = await D.batchUpdateUsers(action, user_ids, expires_at ?? null);
      res.json({ ok: true, updated, decision: decision?.event_id || null });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
  router.put('/api/config/users/batch', handlers.batch);
  router.handlers = handlers; // 注入式测试
  return router;
}
