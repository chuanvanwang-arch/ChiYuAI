// src/portal/memoryConfig.js — 记忆/先例管理（第 26 项）服务端 Router（只读 + 蒸馏触发）
// 架构纪律（2026-08-27 QA 教训）：渲染纯函数已拆至 memoryConfigRender.js（浏览器 ESM 可加载），
// 本文件保留服务端 Router + 从子模块 re-export 纯函数（测试与旧页面 import 兼容）。
// 红线：绝对禁删（蒸馏=标 distilled/archived，无 DELETE）；写经决策第 0 闸（config_change）
import { Router } from 'express';
import { query } from '../db.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
import { distillMemory } from '../memory/memoryLog.js';
// 渲染/校验纯函数（单一事实源 = memoryConfigRender.js）
import {
  LOG_LAYERS, LOG_KINDS, memorySummary, renderMemoryLogs, renderMemoryNotes,
  renderMemorySnapshots, renderPrecedentPanel, renderDistillPanel,
} from './memoryConfigRender.js';

// re-export：测试与旧 import 从本文件取纯函数，保持兼容
export {
  LOG_LAYERS, LOG_KINDS, memorySummary, renderMemoryLogs, renderMemoryNotes,
  renderMemorySnapshots, renderPrecedentPanel, renderDistillPanel,
};

const defaultDeps = {
  // U4（2026-09-10）：tenantId 非空时按租户隔离；admin/sysadmin 传 null = 跨租户全局可见（by-design）
  listLogs: async (tenantId = null, limit = 50) => {
    const where = tenantId ? 'archived=false AND tenant_id=$2' : 'archived=false';
    const params = tenantId ? [limit, tenantId] : [limit];
    return (await query(
      `SELECT id, layer, topic, kind, actor, event_type, distilled, archived, ttl_days, created_at, payload
       FROM crm.memory_log WHERE ${where} ORDER BY created_at DESC LIMIT $1`, params
    )).rows;
  },
  listNotes: async (tenantId = null) => {
    const where = tenantId ? 'archived=false AND tenant_id=$1' : 'archived=false';
    return (await query(`SELECT layer, topic, content, updated_at, archived FROM crm.memory_note WHERE ${where} ORDER BY updated_at DESC LIMIT 50`, tenantId ? [tenantId] : [])).rows;
  },
  listSnapshots: async (tenantId = null) => {
    const where = tenantId ? 'tenant_id=$1' : 'true';
    return (await query(`SELECT id, topic, ref_id, snapshot, created_at FROM crm.memory_snapshot WHERE ${where} ORDER BY created_at DESC LIMIT 20`, tenantId ? [tenantId] : [])).rows;
  },
  // 先例网络 TopN：decision_precedent_rel 无 tenant_id 列（跨租户模式复用），
  // 租户管理员与 sysadmin 看到同一张引用图（仅决策 ID + 引用计数，无敏感业务内容）。
  listPrecedents: async (/* tenantId = null */) =>
    (await query(
      `SELECT r.precedent_id, max(r.similarity)::real AS similarity, count(*)::int AS referenced_times
       FROM crm.decision_precedent_rel r GROUP BY r.precedent_id
       ORDER BY referenced_times DESC, similarity DESC LIMIT 20`
    )).rows,
  distill: async (ttlDays) => distillMemory({ ttlDays }),
  distillDryRun: async () => {
    const r = await query(`SELECT count(*)::int AS n FROM crm.memory_log WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`);
    return { wouldDistill: r.rows[0].n };
  },
  produceDecision: async (ctx) => {
    const row = await recordDecisionEvent('config_change', {
      type: 'memory_distill',
      trigger_context: ctx || {},
    });
    return { event_id: row?.event_id || null };
  },
  resolveMe,
};

// 记忆页可见角色：admin/sysadmin 跨租户全局（可经 ?tenant= 收窄）；
// ten_admin/tan_admin 按本租户隔离；业务用户(sales/manager/presales/exec) 仅可见本租户记忆（U4 收口，2026-09-10）
const MEMORY_VIEWER_ROLES = ['admin', 'sysadmin', 'ten_admin', 'tan_admin', 'sales', 'manager', 'presales', 'exec'];
const isMemoryViewer = (role) => MEMORY_VIEWER_ROLES.includes(role);

export function createMemoryConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const forbid = (res) => res.status(403).json({ error: '需要有效登录身份（业务用户仅可见本租户记忆）' });

  const handlers = {
    // GET /api/memory — 记忆四段聚合（只读）
    get: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || !isMemoryViewer(me.role)) return forbid(res);
        // U4 收口（2026-09-10）：业务用户/租户管理员按自身租户隔离；
        //   admin/sysadmin 可经 ?tenant= 收窄，传 null=全局；绝不回退全量 system 污染。
        const scopedTenant = (me.role === 'admin' || me.role === 'sysadmin')
          ? (req.query?.tenant || null)
          : (me.tenantId || 'system');
        const [logs, notes, snapshots, precedents] = await Promise.all([
          D.listLogs(scopedTenant), D.listNotes(scopedTenant), D.listSnapshots(scopedTenant), D.listPrecedents(scopedTenant),
        ]);
        res.status(200).json({ logs, notes, snapshots, precedents });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    // POST /api/memory/distill — dryRun 预检（不写）| 执行（标 distilled，写决策事件）
    // 蒸馏=全局维护操作（distillMemory 无租户参数），仅 admin 可触发
    post: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || me.role !== 'admin') return forbid(res);
        const dryRun = req.query?.dryRun === '1' || req.body?.dryRun;
        if (dryRun) {
          return res.status(200).json({ dryRun: true, ...(await D.distillDryRun()) });
        }
        const decision = await D.produceDecision({ ttl_days: 30 });
        const d = await D.distill(30);
        res.status(200).json({ ok: !!d?.ok, decision: decision?.event_id || null });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
  };

  router.get('/api/memory', handlers.get);
  router.post('/api/memory/distill', handlers.post);
  router.handlers = handlers; // 无 delete
  return router;
}