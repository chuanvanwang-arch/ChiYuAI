// src/http/propagationRoutes.js
// 参数传播中枢 API：汇聚候选 + accept/reject + broadcast。
// 所有写操作经 requireDecision（第0闸，config-change 场景）+ writeConfig（upsert 禁删）。
// 铁律：绝不 DELETE；readConfig 回退继承；per-tenant 隔离（accept config_store 按 patch.tenant_id 落库）。
// TDD：测试经 __setDeps 注入 requireDecision/writeConfig，避免依赖真实 PG / 决策链。
// F-5 收敛（2026-09-16）：凭证读取**只经引擎单一入口** `decisionIdOf`——删掉本文件自带的那份
//   同名「多形态兜底」实现（含 `dec?.id` 兜底，异常输入下可能把**非决策 id** 写进审计链）。
//   ⚠ 原 `import { requireDecision }`（引擎版）在本文件是**死导入**：全文件零调用点，
//   本文件实际走的是下方 `requireConfigChangeDecision`。
import { decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { writeConfig, readConfig } from '../config/configStore.js';
import { broadcastConfig } from '../config/broadcast.js';
import { promoteMemoryToTenant } from '../memory/promote.js';
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { resolveMe } from './auth.js';
import { hasRole, hasAnyRole, normalizeRole, TENANT_LEVEL_ROLES } from './middleware/rbac.js';

// 第0闸（config 变体）：配置变更不进业务决策引擎（decision_scenario 无 config-change 场景，
// 对齐 decisionScenario.js produceDecision 先例：决策引擎仅承载 8 个业务决策场景）——
// 沉淀 config_change 治理事件，以 event_id 作为本次写入的可审计 decision_id 凭证。
//
// ⚠ 口径声明（F-5，2026-09-16 登记；「补齐真决策 / 保持降级 / 仅收敛」的裁决权在用户）：
//   本函数是**平台内第二套第 0 闸语义**——它**不调用决策引擎**，而是以治理事件 `event_id` 充作凭证。
//   故返回的 `mode='config_change_event'` **既不等于** `autonomous` **也不等于** `escalated`：
//   它**不能阻断写**，且不在 `crm.decision` 留下决策行。
//   凡消费本返回值者，**不得**将其读作「第 0 闸已过引擎判定」。
//   （configRouter / llmConfigRouter / namedAccountAssignRouter + 6 个 portal 的
//    `catch → recordDecisionEvent → {decisionId:null, ok:true}` 降级分支属**同一族**；
//    若将来裁决为「配置写铸真决策」，本函数与那一族必须**一次性**收敛，不得单侧改动留半迁移态。）
async function requireConfigChangeDecision(scenario_id, trigger_context = {}, involved_entities = [], opts = {}) {
  const row = await recordDecisionEvent('config_change', {
    scenario_id: scenario_id || 'config-change',
    trigger_context,
    tenantId: opts.tenantId || 'system',
  });
  const id = row?.event_id || row?.decision_id || null;
  // 形状统一为**引擎形状**（凭证在 `decision.decision_id`）：不再同时写顶层 `decision_id` 同义键。
  //   依据：F-3 已在 `autonomyEngine.requireDecision` 确立「刻意不留顶层别名、避免同义双键」的口径，
  //   此处必须同口径——否则同一个 `decisionIdOf` 读两种形状，「同名字段解释权」再次分裂。
  return { ok: true, mode: 'config_change_event', decision: { decision_id: id } };
}

// 依赖注入点（测试桩；生产用真实实现）
let deps = { requireDecision: requireConfigChangeDecision, writeConfig, readConfig, broadcastConfig, promoteMemoryToTenant };
export function __setDeps(overrides = {}) {
  deps = { ...deps, ...overrides };
}

// 凭证读取见顶部 import：`decisionIdOf`（autonomyEngine 单一入口，严格取 `result.decision.decision_id`）。
//   F-5：此处原有一份本地同名实现（`dec?.decision?.decision_id || dec?.decision_id || dec?.id`），已删除。

// 取最新 report 的 config_store 类候选（未被 action 表标记 acted 者）
async function openRetroSuggestions(pool) {
  const rep = await query(
    `SELECT report_id, draft_patches FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1`,
    []
  );
  const row = rep.rows[0];
  if (!row) return [];
  const patches = Array.isArray(row.draft_patches) ? row.draft_patches : [];
  const cfgPatches = patches.filter((p) => p.knob === 'config_store');
  const acted = await query(`SELECT suggestion_ref FROM crm.propagation_action WHERE status <> 'open'`, []);
  const actedSet = new Set(acted.rows.map((r) => r.suggestion_ref));
  return cfgPatches
    .map((p, i) => ({
      kind: 'config_store',
      ref: `retro:${row.report_id}:${i}`,
      patch: p,
      tenant_id: p.tenant_id,
    }))
    .filter((x) => !actedSet.has(x.ref));
}

// 记忆推广候选：本租户内最近 N 条记忆（task→tenant 推广源）
async function openMemorySuggestions(pool, tenantId) {
  const r = await query(
    `SELECT id, tenant_id, topic, payload FROM crm.memory_log WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [tenantId]
  );
  return r.rows.map((m) => ({
    kind: 'memory_promote',
    ref: `memory:${m.id}`,
    memoryId: m.id,
    tenant_id: m.tenant_id,
    title: m.topic,
  }));
}

// 继承矩阵（只读）：仅看「租户覆盖层」——用广播同一租户轴（crm.crm_users DISTINCT，排除 system），
// 判定每个 (tenant, key) 的覆盖状态。语义=「下发优先于回退」：矩阵呈现下发/继承覆盖真相，不显示 system 默认行。
// 铁律：本端点零写操作（读 config_store 直接 SQL，不走 readConfig——那会触发 autoSeed 写）。
async function recordAction(pool, { ref, kind, status, by, decisionId, detail = {} }) {
  await queryWrite(
    `INSERT INTO crm.propagation_action (suggestion_ref, kind, status, decision_id, by, detail)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [ref, kind, status, decisionId, by, JSON.stringify(detail)]
  );
}

// 继承矩阵（只读）｜语义：下发优先于回退——矩阵只呈现「租户覆盖层」真相。
//   - 租户轴 = 广播同一口径（crm.crm_users DISTINCT，排除 system）→ 与 ③ 下发/推广完全一致
//   - 排除 '*'（scopeTenant 通配视界，非真实租户，configStore.js WILDCARD）
//   - 不枚举 crm.tenants、不读取 system 默认行（system 不是「继承覆盖」的对象）
//   - 状态三态：custom=真定制（无 _seeded）｜seeded=继承自模板（读时被 autoSeed 落行）｜absent=未定制（连模板拷贝都没有）
// 铁律：零写操作——直接 SQL 读 crm.config_store，绝不走 readConfig（会触发 autoSeed 写）。
export async function buildInheritMatrix(pool, { tenantId = null } = {}) {
  const rows = (
    await pool.query(
      `SELECT tenant_id, key, value FROM crm.config_store
       WHERE tenant_id <> 'system' AND tenant_id <> '*' AND ($1::text IS NULL OR tenant_id = $1)
       ORDER BY tenant_id, key`,
      [tenantId]
    )
  ).rows;
  const byTenant = {};
  for (const r of rows) {
    (byTenant[r.tenant_id] ||= []).push({
      key: r.key,
      status: r.value && typeof r.value === 'object' && r.value._seeded ? 'seeded' : 'custom',
      value: r.value ?? null,
    });
  }
  return { tenants: Object.keys(byTenant).sort(), entries: byTenant };
}

// 已落地留痕（只读）：crm.propagation_action 全量（accept/reject/broadcast；可选按租户过滤）。
// fail-open：审计表未建（旧库缺迁移）时降级为空列表 + trace 留痕（禁裸 catch，fail-safe 须 emit）。
export async function listActions(pool, { tenantId = null } = {}) {
  const where = tenantId
    ? `WHERE detail->>'tenant_id' = $1`
    : '';
  try {
    const r = await pool.query(
      `SELECT id, suggestion_ref, kind, status, decision_id, by, detail, created_at
       FROM crm.propagation_action
       ${where}
       ORDER BY created_at DESC`,
      tenantId ? [tenantId] : []
    );
    return r.rows.map((x) => ({
      id: x.id,
      ref: x.suggestion_ref,
      kind: x.kind,
      status: x.status,
      decisionId: x.decision_id,
      by: x.by,
      detail: x.detail ?? {},
      createdAt: x.created_at,
    }));
  } catch (e) {
    emit('trace', 'propagation-actions-fail-open', { error: String(e.message || e) });
    return [];
  }
}

// 接受一条候选并落库（第0闸）
export async function acceptSuggestion(pool, { kind, ref, patch, memoryId, tenantId, by }) {
  if (kind === 'config_store') {
    const [k, sub] = String(patch.target).split('.');
    const cur = (await deps.readConfig(k, { tenantId: patch.tenant_id || 'system' }).catch(() => null))?.value || {};
    const merged = sub ? { ...cur, [sub]: patch.to_value } : patch.to_value;
    const dec = await deps.requireDecision(
      'config-change',
      { action: 'propagation-accept', key: k, target: patch.target },
      [],
      { tenantId: patch.tenant_id || 'system', actor: by }
    );
    const decisionId = decisionIdOf(dec);
    await deps.writeConfig(k, merged, { tenantId: patch.tenant_id || 'system', decisionId, updatedBy: by });
    await recordAction(pool, { ref, kind, status: 'accepted', by, decisionId, detail: { target: patch.target, to_value: patch.to_value } });
    emit('trace', 'propagation-accepted', { ref, kind, by });
    return { ok: true, decisionId, key: k, value: merged };
  }
  if (kind === 'memory_promote') {
    const dec = await deps.requireDecision(
      'config-change',
      { action: 'memory-promote', memoryId },
      [],
      { tenantId, actor: by }
    );
    const decisionId = decisionIdOf(dec);
    const r = await deps.promoteMemoryToTenant(pool, { memoryId, tenantId, by, decisionId });
    await recordAction(pool, { ref, kind, status: 'accepted', by, decisionId, detail: { memoryId } });
    return { ok: true, decisionId, ...r };
  }
  throw new Error(`未知 kind: ${kind}`);
}

// 角色闸（§15.5）：上下贯通（broadcast / tenant→system 推广）强制 ADMIN
function isAdmin(role) {
  return hasRole({ role }, 'ADMIN');
}

// accept 候选的目标层级叠闸（§15.3 双闸串行：先角色闸、后决策第0闸）
//   目标=系统级（config_store 无 tenant_id → system）→ 仅 ADMIN
//   目标=租户级 → tan_admin(限本租户)/sysadmin/ADMIN
export function gateAccept(me, { kind, patch, tenantId }) {
  if (!me?.ok) return { ok: false, status: 401, error: '未登录（HITL 要求）' };
  if (kind === 'config_store') {
    const targetTenant = patch?.tenant_id || 'system';
    if (targetTenant === 'system') {
      if (!hasRole(me, 'ADMIN')) return { ok: false, status: 403, error: '系统级候选仅 ADMIN 可采纳（§15.5）' };
      return { ok: true, targetTenant };
    }
    if (!hasAnyRole(me, TENANT_LEVEL_ROLES, { targetTenantId: targetTenant })) {
      return { ok: false, status: 403, error: '租户级候选仅 tan_admin(本租户)/sysadmin/ADMIN 可采纳（§15.5）' };
    }
    return { ok: true, targetTenant };
  }
  if (kind === 'memory_promote') {
    const targetTenant = tenantId || 'system';
    // §15.5：ten_admin 严格租户作用域，禁止跨租户 / 上行至 system 推广（仅 ADMIN/sysadmin 可）
    if (targetTenant !== me.tenantId && normalizeRole(me.role) === 'TAN_ADMIN') {
      return { ok: false, status: 403, error: 'ten_admin 不可跨租户/系统级推广记忆（§15.5，仅 ADMIN/sysadmin）' };
    }
    if (!hasAnyRole(me, TENANT_LEVEL_ROLES, { targetTenantId: targetTenant })) {
      return { ok: false, status: 403, error: '记忆推广仅 tan_admin(本租户)/sysadmin/ADMIN 可采纳（§15.5）' };
    }
    return { ok: true, targetTenant };
  }
  return { ok: false, status: 400, error: `未知 kind: ${kind}` };
}

/** 路由注册（在 decisionReadRoutes 或主 app 调用） */
export function registerPropagationRoutes(app, pool) {
  app.get('/api/propagation/suggestions', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const tenantId = me.tenantId || 'system';
      let [cfg, mem] = await Promise.all([openRetroSuggestions(pool), openMemorySuggestions(pool, tenantId)]);
      // §15.1 tan_admin 限本租户：仅见本租户候选（sysadmin/ADMIN 全量可见）
      if (normalizeRole(me.role) === 'TAN_ADMIN') {
        cfg = cfg.filter((c) => c.tenant_id === tenantId);
      }
      res.json({ ok: true, config_store: cfg, memory: mem });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 继承矩阵（只读）：租户×键 覆盖状态（custom/seeded/absent），直接 SQL 读，零写
  app.get('/api/config/inherit-matrix', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      // §15.1 tan_admin 限本租户：只返回本租户行；sysadmin/ADMIN 全量
      const tenantId = normalizeRole(me.role) === 'TAN_ADMIN' ? (me.tenantId || 'system') : null;
      const m = await buildInheritMatrix(pool, { tenantId });
      res.json({ ok: true, ...m });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 已落地留痕（只读）：propagation_action 全量（accept/reject/broadcast）
  app.get('/api/propagation/actions', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const tenantId = normalizeRole(me.role) === 'TAN_ADMIN' ? (me.tenantId || 'system') : null;
      const items = await listActions(pool, { tenantId });
      res.json({ ok: true, items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/propagation/accept', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const b = req.body || {};
      const tenantId = b.tenantId || b.tenant_id;
      // §15.3 双闸串行：先目标层级角色闸，后第0决策闸（acceptSuggestion 内）
      const g = gateAccept(me, { kind: b.kind, patch: b.patch, tenantId });
      if (!g.ok) return res.status(g.status).json({ error: g.error });
      const r = await acceptSuggestion(pool, { ...b, tenantId, by: me.username || me.id });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/propagation/reject', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { ref, kind } = req.body || {};
      const dec = await deps.requireDecision(
        'config-change',
        { action: 'propagation-reject', ref },
        [],
        { tenantId: me.tenantId || 'system', actor: me.username || me.id }
      );
      const decisionId = decisionIdOf(dec);
      await recordAction(pool, { ref, kind, status: 'rejected', by: me.username || me.id, decisionId });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 强制下发（上下贯通，强制 ADMIN；先 mint decision 再 broadcast）
  app.post('/api/config/broadcast', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      if (!isAdmin(me.role)) return res.status(403).json({ error: '上下贯通（下发）必须 ADMIN 权限' });
      const { key, value, mode = 'fill-only', targets = null } = req.body || {};
      const dec = await deps.requireDecision(
        'config-change',
        { action: 'broadcast', key, mode, targets },
        [],
        { tenantId: 'system', actor: me.username || me.id }
      );
      const decisionId = decisionIdOf(dec);
      const r = await deps.broadcastConfig(pool, { key, value, mode, targets, by: me.username || me.id, decisionId });
      // 完整性补全：强制下发同样留痕（与 accept/reject 统一，④已落地才能全量呈现）
      await recordAction(pool, {
        ref: `broadcast:${key}:${Date.now()}`,
        kind: 'broadcast',
        status: 'accepted',
        by: me.username || me.id,
        decisionId,
        detail: { key, mode, written: r.written ?? [], skipped: r.skipped ?? [] },
      });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 逐键继承视图（只读）：给定 key → 各租户现值 + 覆盖状态（custom/seeded），供 ① 继承视图聚焦
  app.get('/api/config/inherit', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const key = String(req.query.key || '').trim();
      if (!key) return res.status(400).json({ error: 'key 必填' });
      const tenantId = normalizeRole(me.role) === 'TAN_ADMIN' ? (me.tenantId || 'system') : null;
      const rows = (
        await pool.query(
          `SELECT tenant_id, key, value FROM crm.config_store
           WHERE key=$1 AND tenant_id<>'system' AND tenant_id<>'*' AND ($2::text IS NULL OR tenant_id=$2)
           ORDER BY tenant_id`,
          [key, tenantId]
        )
      ).rows;
      res.json({
        ok: true,
        key,
        entries: rows.map((r) => ({
          tenantId: r.tenant_id,
          status: r.value && typeof r.value === 'object' && r.value._seeded ? 'seeded' : 'custom',
          value: r.value ?? null,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 生效值视图（只读）：当前用户租户视角下某键的「实际生效值」+ 来源（custom=租户定制 / seeded=系统模板继承 / default=无配置）
  app.get('/api/config/effective', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const key = String(req.query.key || '').trim();
      if (!key) return res.status(400).json({ error: 'key 必填' });
      const tenantId = me.tenantId || 'system';
      const row = (
        await pool.query(
          `SELECT value FROM crm.config_store
           WHERE key=$1 AND tenant_id=$2`,
          [key, tenantId]
        )
      ).rows[0];
      if (row) {
        const seeded = row.value && typeof row.value === 'object' && row.value._seeded;
        return res.json({ ok: true, key, source: seeded ? 'seeded' : 'custom', value: row.value ?? null });
      }
      const sys = (
        await pool.query(`SELECT value FROM crm.config_store WHERE key=$1 AND tenant_id='system'`, [key])
      ).rows[0];
      if (sys) return res.json({ ok: true, key, source: 'system-template', value: sys.value ?? null });
      return res.json({ ok: true, key, source: 'none', value: null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
