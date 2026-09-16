// src/http/connectorRouter.js — 外部采集手动同步端点（方案 A：读链路补齐 + 手动触发）
// 契约：POST /api/connector/zhizao-verify → 调 conn-zhizao-verify-account
//       POST /api/integration/webhook/:provider → 外部源推送信号 → 调 conn-signal-lead-gen
//         （2026-09-16 A-B5/T06 扩展：body.event.object 存在时改走**同步内核 upsert**，不经富化瀑布）
//       POST /api/connector/qixin-enrich|xinbang-sync|tenant-source-sync → 按需 enrich
// 闸：admin/sysadmin 才能触发外部写通道；sales 不可直触。
// 计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md §Task 5
import { Router } from 'express';
import { actionExecutor } from '../action/executor.js';

// —— 纯函数：外部源信号 webhook（admin/sysadmin 闸 + 参数校验 + 派发 conn-signal-lead-gen）——
// 抽为纯函数便于单测（无需 supertest）；route 仅做 req/res 适配。
// A-B5：两条路由共用同一角色闸；runSyncEvent 缺省时返回 501（不静默降级为线索派发——那会写错对象）
export async function handleSignalWebhook({ me, body, provider, exec, runSyncEvent }) {
  if (!me.ok) return { status: 401, json: { error: me.error } };
  if (!['admin', 'sysadmin'].includes(me.role)) return { status: 403, json: { error: 'forbidden', gate: 'role' } };

  // A-B5 对象变化事件：{ event: { object, record } } → 按 event.object 路由到同步内核 upsert
  if (body?.event?.object) {
    if (typeof runSyncEvent !== 'function') return { status: 501, json: { error: 'sync_route_not_mounted' } };
    const ev = body.event;
    const r = await runSyncEvent({
      tenantId: me.tenantId, provider, object: ev.object, row: ev.record || body.record || {},
    });
    if (!r?.ok) return { status: 400, json: { error: r?.error || 'sync upsert failed', result: r } };
    return { status: 200, json: { ok: true, provider, route: 'sync-upsert', ...r } };
  }

  const { signal_type, account_id, match } = body || {};
  if (!signal_type || !account_id) return { status: 400, json: { error: 'signal_type 与 account_id 必填' } };
  const result = await exec('conn-signal-lead-gen', { signal_type, account_id, match }, {
    actor: me.username, tenantId: me.tenantId, decision_id: null, approvalPassed: true,
  });
  if (!result?.ok) return { status: 400, json: { error: result?.error || 'webhook action failed', result } };
  return { status: 200, json: { ok: true, provider, decision_id: result?.data?.deal_id, result } };
}

// —— 纯函数：手动按需 enrich（qixin/xinbang/租户系统）——
export async function handleManualEnrich({ me, body, allowId, runDiscovery }) {
  if (!me.ok) return { status: 401, json: { error: me.error } };
  if (!['admin', 'sysadmin'].includes(me.role)) return { status: 403, json: { error: 'forbidden', gate: 'role' } };
  const { account_id } = body || {};
  if (!account_id) return { status: 400, json: { error: 'account_id 必填' } };
  const out = await runDiscovery({ tenantId: me.tenantId, actor: me.username, decision_id: null },
    { seed: { name: body.name || account_id }, allowIds: allowId ? [allowId] : undefined }, {});
  return { status: 200, json: { ok: true, enriched: out.enriched } };
}

export function createConnectorRouter({ resolveMe, dispatch, runDiscovery, runSyncEvent } = {}) {
  const exec = dispatch || actionExecutor.dispatch;
  const doDiscovery = runDiscovery || ((...a) => import('../agent/discoveryOrchestrator.js').then((m) => m.runDiscovery(...a)));
  // A-B5：缺省装配 = 同步挂载层（config_store 映射 + 真库 pool + 第 0 闸铸决策 + 留痕）；测试可注入替身
  const doSyncEvent = runSyncEvent || (async (args) => {
    const [mount, cfg, db, bus, autonomy] = await Promise.all([
      import('../sync/mount.js'), import('../config/configStore.js'), import('../db.js'),
      import('../events/bus.js').catch(() => null), import('../decision/autonomyEngine.js').catch(() => null),
    ]);
    return mount.handleObjectChanged({
      ...args,
      deps: {
        readConfig: cfg.readConfig,
        pool: db.pool,
        mappings: await mount.loadSyncMappings({ tenantId: args.tenantId, readConfig: cfg.readConfig }),
        emit: bus?.emit,
        // 第 0 闸：L2/L3 写路径须铸决策；铸不出 → 内核拒写（fail-closed，与 timers.js 集成轮询同源装配）
        mintDecision: async (scene, ctx) => {
          const r = autonomy?.requireDecision ? await autonomy.requireDecision(scene, ctx).catch(() => null) : null;
          return { decisionId: r?.decision_id || null };
        },
      },
    });
  });
  const r = Router();

  // 外部工商采集写通道：仅 admin/sysadmin 可触发
  r.post('/zhizao-verify', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me.ok) return res.status(401).json({ error: me.error });
      if (!['admin', 'sysadmin'].includes(me.role)) {
        return res.status(403).json({ error: 'forbidden', gate: 'role' });
      }
      const { account_id, verification } = req.body || {};
      if (!account_id || !verification) {
        return res.status(400).json({ error: 'account_id 与 verification 必填' });
      }
      const result = await exec(
        'conn-zhizao-verify-account',
        { account_id, verification },
        {
          actor: me.username,
          tenantId: me.tenantId,
          decision_id: null,
          approvalPassed: true,
        }
      );
      if (!result?.ok) {
        return res.status(400).json({ error: result?.error || 'connector action failed', result });
      }
      res.json({ ok: true, decision_id: result?.data?.decision_id, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 外部源事件推送（webhook）：启信慧眼/新榜订阅命中 → 复用 conn-signal-lead-gen 事件驱动
  //   A-B5：body.event.object 存在 → 改走同步内核 upsert（同一角色闸，sales 403）
  r.post('/integration/webhook/:provider', async (req, res) => {
    try {
      const me = resolveMe(req);
      const result = await handleSignalWebhook({ me, body: req.body, provider: req.params.provider, exec, runSyncEvent: doSyncEvent });
      res.status(result.status).json(result.json);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 手动触发：启信慧眼/新榜/租户系统按需 enrich（复用 discovery-run）
  for (const [path, allowId] of [['/qixin-enrich', 'qixin'], ['/xinbang-sync', 'xinbang'], ['/tenant-source-sync', null]]) {
    r.post(path, async (req, res) => {
      try {
        const me = resolveMe(req);
        const result = await handleManualEnrich({ me, body: req.body, allowId, runDiscovery: doDiscovery });
        res.status(result.status).json(result.json);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  return r;
}
