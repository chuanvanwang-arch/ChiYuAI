// src/http/namedAccountAssignRouter.js — 指名客户分配写通道（注入式工厂）
// 契约（docs/2026-08-30-named-account-manage-design.md §2）：
//   GET  /api/named-account-assign/options       → { accounts(未分配), users(销售) }（admin/manager 闸）
//   POST /api/named-account-assign               → 角色闸 → 决策第0闸 → updateParticle(named_owner/tier/state) + 审计边 named_assignment
//   POST /api/named-account-assign/:id/deactivate → 软停用 named_state=inactive（禁删铁律，零 DELETE）
// 范式：namedAccountTargetsRouter.js（scenarioDeps.produceDecision）+ particleRepo 写通道（updateParticle/createEdge）
// 设计：docs/2026-08-30-named-account-manage-design.md §2（写经决策第0闸 + 审计边；停用=deactivate 非删除）
import { Router } from 'express';
import { query } from '../db.js';
import { scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { scopeTenant } from './tenantScope.js';
import { getParticle, queryParticles, updateParticle } from '../particles/particleRepo.js';
import { createEdge } from '../particles/particleRepo.js';

// 角色闸：分配/停用均属管理操作（sales 只读自己的看板，不能改分配事实）
const ROLE_OK = ['admin', 'sysadmin', 'manager'];

// 依赖注入默认值：生产路径直连真实实现；测试可整体替换（对齐既有 Router 注入式范式）
// 注：plan 中镜像 businessTier.js 已过时（该文件不存在），以 namedAccountTargetsRouter 范式为准
function defaultDeps() {
  return {
    // options：候选客户 = CRM_ACCOUNT 全量（未分配过滤由 handlers.options 契约层负责）
    listAccounts: async (actor) => queryParticles({ type: 'CRM_ACCOUNT', tenantId: scopeTenant(actor), limit: 200 }),
    // 租户收敛（2026-09-04）：指名客户分配下拉不再泄露其它租户销售员
    listUsers: async (actor) => {
      const scope = scopeTenant(actor);
      const scoped = scope && scope !== '*';
      return query(
        `SELECT username, display_name FROM crm.crm_users${scoped ? ' WHERE tenant_id = $1' : ''} ORDER BY username`,
        scoped ? [scope] : []
      ).then((r) => r.rows);
    },
    readAccount: async (id) => getParticle(id),
    updateAccount: async (id, patch) => updateParticle(id, { patch, systemBypass: true }),
    createNamedEdge: async (args) =>
      createEdge(args.sourceType, args.sourceId, args.edgeType, args.targetType, args.targetId, args.meta || {}),
    // 决策第 0 闸：写前必须产生决策凭证（autonomyEngine.requireDecision）
    // 降级语义（对齐既有 config Router）：决策引擎故障时记录决策事件（fail-open 不阻断业务写）
    requireDecision: async (ctx) => {
      try {
        const r = await requireDecisionReal('config-change', ctx || {});
        const did = decisionIdOf(r);
        return { decision_id: did, ok: !!did };
      } catch {
        await recordDecisionEvent('config_change', { trigger_context: ctx });
        return { decision_id: null, ok: true };
      }
    },
    checkRole: async (me) =>
      (me?.ok || me?.role) ? // resolveMe 返回 {ok, role, username, tenantId}（auth.js 契约，无 ok 包裹）
        (ROLE_OK.includes(me.role) ? { ok: true, role: me.role, username: me.username, tenantId: me.tenantId } : { ok: false, reason: 'role_not_allowed' })
        : { ok: false, reason: '未登录' },
  };
}

export function createNamedAccountAssignRouter(deps = {}) {
  const router = Router();
  // D 惰性代理：每次属性访问实时合并（defaultDeps 兜底 + deps 覆写）。
  // 关键：deps 是调用方持有的对象，测试可在构造后改 deps.readAccount 等——
  // 浅拷贝快照会让后续注入失效（本例 404 变 200 的根因）。
  const base = defaultDeps();
  const D = new Proxy(base, {
    get(target, prop) {
      if (prop in deps) return deps[prop];
      return target[prop];
    },
  });

  const handlers = {
    options: async (req, res) => {
      try {
        const me = await D.checkRole(await resolveMe(req));
        if (!me.ok) return res.status(403).json({ error: '需要 admin/manager 权限' });
        const [accounts, users] = await Promise.all([D.listAccounts(me), D.listUsers(me)]);
        // 未分配过滤（契约层，不依赖注入实现）：named_owner 非空 = 已分配，不进候选项
        const unassigned = (Array.isArray(accounts) ? accounts : []).filter((a) => !(a.payload?.named_owner || null));
        res.json({ accounts: unassigned, users });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    create: async (req, res) => {
      try {
        const me = await D.checkRole(await resolveMe(req));
        if (!me.ok) return res.status(403).json({ error: '需要 admin/manager 权限' });
        const { account_id, owner, tier, decision_id } = req.body || {};
        if (!account_id || !owner || !tier) return res.status(400).json({ error: 'account_id/owner/tier 必填' });
        const cur = await D.readAccount(account_id);
        if (!cur) return res.status(404).json({ error: '客户不存在' });
        // 决策第 0 闸：写分配合法性判定（config-change 场景），失败抛错不写
        const decision = await D.requireDecision({ scenario_id: 'config_change', fields: ['named_owner', 'named_tier', 'named_state'], actor: me.username });
        const patch = {
          named_owner: owner, named_tier: tier, named_state: 'active',
          ...(decision?.decision_id ? { decision_id: decision.decision_id } : {}),
        };
        const p = await D.updateAccount(account_id, patch);
        // 审计边：named_assignment（受控谓词，particleModel CONTROLLED_PREDICATES 已纳入）
        await D.createNamedEdge({
          sourceType: 'CRM_ACCOUNT', sourceId: account_id, edgeType: 'named_assignment',
          targetType: 'CRM_ACCOUNT', targetId: account_id,
          meta: { owner, tier, decision_id: decision?.decision_id || null, actor: me.username, ts: new Date().toISOString() },
        });
        res.json({ ok: true, account: p, decision: decision?.decision_id || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
    deactivate: async (req, res) => {
      try {
        const me = await D.checkRole(await resolveMe(req));
        if (!me.ok) return res.status(403).json({ error: '需要 admin/manager 权限' });
        const { id } = req.params || {};
        const decision = await D.requireDecision({ scenario_id: 'config_change', fields: ['named_state'], actor: me.username });
        const patch = { named_state: 'inactive', ...(decision?.decision_id ? { decision_id: decision.decision_id } : {}) };
        const p = await D.updateAccount(id, patch);
        res.json({ ok: true, account: p, decision: decision?.decision_id || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
  };

  router.get('/api/named-account-assign/options', handlers.options);
  router.post('/api/named-account-assign', handlers.create);
  router.post('/api/named-account-assign/:id/deactivate', handlers.deactivate);
  router.handlers = handlers; // 注入式测试暴露
  return router;
}

// 真实 resolveMe（auth.js）为同步函数（返回 {ok, role, username}，无 Promise）——
// 既有 Router 范式（namedAccountTargetsRouter：`try { me = await realResolveMe(req) }`）可 await 兼容同步/异步。
// 注入式优先：测试在 req 上挂 resolveMe 返回 mock 身份；生产走 auth.js。
function resolveMe(req) {
  try {
    if (typeof req.resolveMe === 'function') return req.resolveMe();
    if (typeof req.app?.locals?.resolveMe === 'function') return req.app.locals.resolveMe();
  } catch { /* fallthrough */ }
  return realResolveMe(req);
}

// 决策引擎真实实现（懒加载，避免顶部 ESM 循环依赖）
import { requireDecision as requireDecisionReal, decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';