// src/http/syncMetricsRouter.js — GET /api/monitor/sync（T07 上墙）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T07
import { Router } from 'express';
import { getSyncMetrics } from '../monitor/syncMetrics.js';

export function createSyncMetricsRouter({ pool, resolveMe } = {}) {
  const r = Router();
  r.get('/sync', async (req, res) => {
    try {
      const me = resolveMe ? resolveMe(req) : { ok: true, tenantId: req.headers['x-tenant-id'] || 'system' };
      if (!me?.ok) return res.status(401).json({ error: me?.error || 'unauthorized' });
      const m = await getSyncMetrics({ pool, tenantId: me.tenantId });
      res.json(m);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return r;
}
