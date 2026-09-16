// src/http/signalMetricsRouter.js — GET /api/monitor/signal-link（T20 上墙，per-tenant）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T20
// 返回：{ metrics, negative_predicates, downgrades }；租户取自身（resolveMe），禁止 x-tenant-id 头
import { Router } from 'express';
import { resolveMe } from './auth.js';
import { getSignalMetrics, detectNegativePredicates, getDowngradeEvents } from '../monitor/signalMetrics.js';

export function createSignalMetricsRouter() {
  const r = Router();
  r.get('/signal-link', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: me?.error || 'unauthorized' });
      const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 3600 * 1000);
      const [metrics, negative_predicates, downgrades] = await Promise.all([
        getSignalMetrics({ tenantId: me.tenantId, since }),
        detectNegativePredicates({ tenantId: me.tenantId, since }),
        getDowngradeEvents({ tenantId: me.tenantId, since }),
      ]);
      res.json({ metrics, negative_predicates, downgrades });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  return r;
}
