// src/http/funnelRouter.js — 漏斗质量看板端点（P1-B）
// 契约：
//   GET /api/funnel/quality?owner=&period=&annualTarget= → 真实性与健康性（MANT 缺失清单 + 销售潜力 + 加权 + 抖动 + 承诺）
//   GET /api/funnel/deals?zone=&owner=                  → 按漏斗区域/预测分类列商机
// 数据面：CRM_DEAL 粒子（queryParticles）；阈值经 config_store['sales-thresholds'].funnel（用户可配）。
// 设计：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5.3
// 原则（用户 2026-08-30）：加权值/抖动阈值/承诺评价带一律走后台配置，不硬编码。
import { Router } from 'express';
import { queryParticles } from '../particles/particleRepo.js';
import { resolveMe as realResolveMe } from './auth.js';
import { scopeTenant } from './tenantScope.js';
import { mergedThresholds } from '../sales/salesThresholds.js';
import {
  mantOk, funnelZone, forecastClass, weightedAmount, salesPotential, jitterRate, commitAccuracy, forecastBreach,
} from '../sales/funnelQuality.js';
import { readConfig } from '../config/configStore.js';

const CONFIG_KEY = 'sales-thresholds';

async function readThresholds(me) {
  try {
    const r = await readConfig(CONFIG_KEY, { tenantId: scopeTenant(me) });
    return mergedThresholds(r?.value || {});
  } catch { return mergedThresholds({}); }
}

async function me(req) {
  try { return await realResolveMe(req); } catch { return { ok: false }; }
}

export function createFunnelRouter() {
  const router = Router();

  // ── 漏斗健康度 ─────────────────────────────────────────
  router.get('/api/funnel/quality', async (req, res) => {
    try {
      const u = await me(req);
      if (!u?.ok) return res.status(401).json({ error: '未登录' });

      const owner = req.query.owner || null;
      const thresholds = await readThresholds(u);
      const deals = await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(u), limit: 500 });
      const scoped = owner ? deals.filter((d) => d.payload?.owner_id === owner) : deals;

      const zones = {};
      const classes = {};
      const authenticity = [];
      let weightedTotal = 0;
      let baseline = 0;
      let moved = 0;       // 取消/降出/后延（MVP：stage 落入 lost/deferred 集合；受六段白名单约束，缺省 0）
      let closedAmount = 0; // 已签单（paid/ordered）金额
      const commit = [];

      for (const d of scoped) {
        const f = d.payload?.funnel || {};
        const stage = d.payload?.stage;
        const zone = funnelZone(d);
        zones[zone] = (zones[zone] || 0) + 1;
        const cls = forecastClass(d);
        if (cls) classes[cls] = (classes[cls] || 0) + 1;
        const mo = mantOk(f);
        if (!mo.ok) authenticity.push({ id: d.id, title: d.title, missing: mo.missing });
        weightedTotal += weightedAmount(d, thresholds);
        baseline += Number(f.baseline_amount || 0);
        if (['lost', 'LOST', 'deferred', 'DEFERRED'].includes(stage)) moved += Number(d.payload?.expected_amount || 0);
        if (['paid', 'ordered', 'PAID', 'ORDERED'].includes(stage)) closedAmount += Number(d.payload?.expected_amount || 0);
        if (f.committed) {
          const promised = Number(f.committed.amount || 0);
          const actual = Number(f.committed.actual || 0);
          if (promised > 0) commit.push({ id: d.id, title: d.title, ...commitAccuracy(promised, actual, thresholds) });
        }
      }

      const annualTarget = Number(req.query.annualTarget) || Number(thresholds.funnel?.annual_target || 0) || 0;
      const health = salesPotential(scoped, annualTarget, closedAmount, thresholds);
      const breach = forecastBreach(health, thresholds);
      const jitter = jitterRate(baseline, moved);

      res.json({
        total: scoped.length,
        zones,
        classes,
        authenticity,
        weightedTotal,
        health: { salesPotential: health, annualTarget, closedAmount, breach },
        jitter: jitter == null ? null : { rate: jitter, baseline, moved },
        commit,
      });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  // ── 按区域列商机 ───────────────────────────────────────
  router.get('/api/funnel/deals', async (req, res) => {
    try {
      const u = await me(req);
      if (!u?.ok) return res.status(401).json({ error: '未登录' });

      const owner = req.query.owner || null;
      const zone = req.query.zone || null;
      const thresholds = await readThresholds(u);
      const deals = await queryParticles({ type: 'CRM_DEAL', tenantId: scopeTenant(u), limit: 500 });
      const scoped = owner ? deals.filter((d) => d.payload?.owner_id === owner) : deals;

      const rows = scoped.map((d) => {
        const f = d.payload?.funnel || {};
        const mo = mantOk(f);
        return {
          id: d.id,
          title: d.title,
          stage: d.payload?.stage,
          zone: funnelZone(d),
          forecastClass: forecastClass(d),
          weighted: weightedAmount(d, thresholds),
          mantOk: mo.ok,
          missing: mo.missing,
          expectedAmount: Number(d.payload?.expected_amount || 0),
        };
      });
      const filtered = zone ? rows.filter((r) => r.zone === zone || r.forecastClass === zone) : rows;
      res.json({ deals: filtered, total: filtered.length });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  return router;
}
