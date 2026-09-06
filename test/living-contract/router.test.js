// test/living-contract/router.test.js — contractRouter 工厂（注入式，不连真实库）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createContractRouter } from '../../src/http/contractRouter.js';

function mkApp(deps) {
  const app = express();
  app.use(express.json());
  app.use(createContractRouter({ deps }));
  return app;
}

describe('contractRouter（注入式）', () => {
  let server, base;
  const docs = [{ doc_path: 'docs/a.md', contracts: [
    { doc_path: 'docs/a.md', task: 'T1', agent: 'crm-copilot', skills: ['data-particle-read'], memory: ['crm-copilot'], success: 'ok',
      static: { skills_aligned: true, memory_aligned: true }, probe: { type: 'http_get', path: '/api/x', expect_status: 200 } },
  ] }];
  const calls = { upsert: 0 };
  const deps = {
    collectContracts: () => ({ docs }),
    getFeedback: async () => [],
    upsertFeedback: async (row) => { calls.upsert++; return { ...row, id: 1 }; },
    runProbe: async () => ({ status: 'pass', observed: 'pass' }),
    resolveMe: () => ({ ok: true, role: 'sysadmin' }),
    registry: {}, docsRoot: 'docs',
  };
  beforeAll(async () => { server = mkApp(deps).listen(0); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(() => server.close());

  it('GET /api/contracts 返回 docs 且任务含 static+feedback', async () => {
    const r = await fetch(`${base}/api/contracts`).then((x) => x.json());
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].tasks[0].task).toBe('T1');
    expect(r.docs[0].tasks[0].static.skills_aligned).toBe(true);
    expect(r.docs[0].tasks[0].feedback).toEqual([]);
  });
  it('POST /api/contracts/feedback 幂等 upsert（写闸 sysadmin 通过）', async () => {
    const r = await fetch(`${base}/api/contracts/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'docs/a.md', task: 'T1', gap_type: 'skill', observed: 'x' }) }).then((x) => x.json());
    expect(r.ok).toBe(true);
    expect(calls.upsert).toBe(1);
  });
  it('POST /api/contracts/probe 写 gap_type=success 反馈', async () => {
    const r = await fetch(`${base}/api/contracts/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'docs/a.md', task: 'T1' }) }).then((x) => x.json());
    expect(r.ok).toBe(true);
    expect(r.probe.status).toBe('pass');
  });
  it('非 sysadmin 写操作 → 403', async () => {
    const noAuth = { ...deps, resolveMe: () => ({ ok: false }) };
    const s2 = mkApp(noAuth).listen(0);
    const port = s2.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/contracts/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc_path: 'd', task: 't', gap_type: 'other' }) });
    expect(r.status).toBe(403);
    s2.close();
  });
});
