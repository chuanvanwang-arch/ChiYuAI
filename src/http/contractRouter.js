// src/http/contractRouter.js — 契约消费端点
// GET /api/contracts（公开，对齐 /api/agents）｜ GET /api/contracts/export ｜
// POST /api/contracts/feedback（sysadmin）｜ POST /api/contracts/probe（sysadmin）｜ 绝对禁删
import { Router } from 'express';
import { resolveMe as realResolveMe } from './auth.js';
import { collectContracts as defaultCollect } from '../contract/contractService.js';
import { getFeedback, upsertFeedback } from '../contract/contractStore.js';
import { runProbe as defaultProbe } from '../contract/probe.js';
import { agentSpecs } from '../agent/agentSpec.js';

function roleOk(role) { return role === 'admin' || role === 'sysadmin'; }

export function createContractRouter({ deps = {} } = {}) {
  const D = {
    collectContracts: defaultCollect,
    getFeedback,
    upsertFeedback,
    runProbe: defaultProbe,
    resolveMe: realResolveMe,
    registry: agentSpecs,
    docsRoot: 'docs',
    ...deps,
  };
  const router = Router();

  const requireWrite = (req, res, next) => {
    let me; try { me = D.resolveMe(req); } catch { me = { ok: false }; }
    if (!me?.ok || !roleOk(me.role)) return res.status(403).json({ error: '需要 sysadmin 权限' });
    next();
  };

  router.get('/api/contracts', async (req, res) => {
    try {
      const { docs } = D.collectContracts({ docsRoot: D.docsRoot, registry: D.registry });
      const out = [];
      for (const doc of docs) {
        const tasks = [];
        for (const c of doc.contracts) {
          const fb = await D.getFeedback({ docPath: c.doc_path, task: c.task });
          tasks.push({ ...c, feedback: fb });
        }
        out.push({ doc_path: doc.doc_path, tasks });
      }
      res.json({ docs: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/contracts/export', async (req, res) => {
    try { res.json({ feedback: await D.getFeedback({}) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/contracts/feedback', requireWrite, async (req, res) => {
    try { res.json({ ok: true, row: await D.upsertFeedback(req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.post('/api/contracts/probe', requireWrite, async (req, res) => {
    try {
      const { doc_path, task } = req.body || {};
      const { docs } = D.collectContracts({ docsRoot: D.docsRoot, registry: D.registry });
      const c = docs.flatMap((d) => d.contracts).find((x) => x.doc_path === doc_path && x.task === task);
      if (!c) return res.status(404).json({ error: '契约未找到' });
      if (!c.probe) return res.status(400).json({ error: '该 task 无 probe 定义' });
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const result = await D.runProbe({ fetchImpl: fetch, baseUrl, contract: c });
      const saved = await D.upsertFeedback({
        doc_path, task, gap_type: 'success',
        observed: result.observed,
        severity: result.status === 'pass' ? 'info' : 'error',
        status: result.status === 'pass' ? 'resolved' : 'open',
      });
      res.json({ ok: true, probe: result, row: saved });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}
