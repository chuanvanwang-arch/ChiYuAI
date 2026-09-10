// test/web/memoryConfig.test.js — 记忆/先例管理（第 26 项）TDD
import { test, expect } from 'vitest';
import {
  LOG_LAYERS, LOG_KINDS, memorySummary, renderMemoryLogs, renderMemoryNotes,
  renderMemorySnapshots, renderPrecedentPanel, renderDistillPanel,
} from '../../src/portal/memoryConfigRender.js';

const LOGS = [
  {
    id: 'a1', layer: 'L-Workspace', topic: 'decision:abc', kind: 'decision', actor: 'alice',
    event_type: 'decision-made', distilled: true, archived: false, ttl_days: 30,
    created_at: '2026-08-01T00:00:00Z', payload: { scenario_id: 'quote', tier: 'NORMAL' },
  },
  {
    id: 'a2', layer: 'L-Workspace', topic: 'follow:deal', kind: 'event', actor: 'alice',
    event_type: 'followup', distilled: false, archived: true, ttl_days: 30,
    created_at: '2026-07-01T00:00:00Z', payload: {},
  },
];
const NOTES = [
  { layer: 'L-User', topic: 'ui:import-export-pref', content: { fields: ['qty', 'price'] }, updated_at: '2026-08-20T00:00:00Z', archived: false },
  { layer: 'L-Workspace', topic: 'deal:recovery', content: { note: '预算卡在财务部' }, updated_at: '2026-08-21T00:00:00Z', archived: true },
];
const SNAPS = [
  { id: 's1', topic: 'approval:inst1', ref_id: 'inst-1', snapshot: { from: 'PENDING', to: 'APPROVED' }, created_at: '2026-08-02T00:00:00Z' },
];
const PRECS = [
  { precedent_id: 'dec-9', similarity: 0.92, referenced_times: 5 },
  { precedent_id: 'dec-2', similarity: 0.71, referenced_times: 2 },
];

test('常量：layers/kinds', () => {
  expect(LOG_LAYERS).toContain('L-Workspace');
  expect(LOG_KINDS).toContain('decision');
});

test('memorySummary 统计', () => {
  expect(memorySummary(LOGS, NOTES, SNAPS)).toEqual({
    logs: 2, distilled: 1, archivedLogs: 1, notes: 2, snapshots: 1,
  });
});

test('renderMemoryLogs 表格含关键列与徽标', () => {
  const html = renderMemoryLogs(LOGS);
  expect(html).toContain('decision:abc');
  expect(html).toContain('已蒸馏');
  expect(html).toContain('已归档');
  expect(html).toContain('L-Workspace');
});

test('renderMemoryLogs 空态', () => {
  expect(renderMemoryLogs([])).toContain('无记忆日志');
});

test('renderMemoryNotes 表格', () => {
  const html = renderMemoryNotes(NOTES);
  expect(html).toContain('ui:import-export-pref');
  expect(html).toContain('L-User');
  expect(html).toContain('已归档');
  expect(html).toContain('deal:recovery');
});

test('renderMemorySnapshots 表格', () => {
  const html = renderMemorySnapshots(SNAPS);
  expect(html).toContain('approval:inst1');
  expect(html).toContain('inst-1');
});

test('renderPrecedentPanel TopN 排序 + 相似度', () => {
  const html = renderPrecedentPanel(PRECS);
  expect(html.indexOf('dec-9')).toBeLessThan(html.indexOf('dec-2'));
  expect(html).toContain('92%');
});

test('renderDistillPanel dryRun 后展示计数', () => {
  const html = renderDistillPanel({ wouldDistill: 3, dryRun: true });
  expect(html).toContain('3');
});

// —— handler 测试（注入式依赖）——
import { createMemoryConfigRouter } from '../../src/portal/memoryConfig.js';

function makeDeps(over = {}) {
  return {
    listLogs: async () => [],
    listNotes: async () => [],
    listSnapshots: async () => [],
    listPrecedents: async () => [],
    distill: async (ttlDays) => ({ ok: true }),
    distillDryRun: async () => ({ wouldDistill: 3 }),
    produceDecision: async (ctx) => ({ event_id: 'e-1' }),
    resolveMe: async () => ({ ok: true, role: 'admin' }),
    ...over,
  };
}

test('GET /api/memory 返回四段', async () => {
  const router = createMemoryConfigRouter(makeDeps());
  let body = null;
  const res = { json: (p) => { body = p; return res; }, status: () => res };
  await router.handlers.get({}, res);
  expect(body.logs).toBeDefined();
  expect(body.notes).toBeDefined();
  expect(body.snapshots).toBeDefined();
  expect(body.precedents).toBeDefined();
});

test('GET 非 viewer 角色（guest）→ 403', async () => {
  const router = createMemoryConfigRouter(makeDeps({ resolveMe: async () => ({ ok: true, role: 'guest' }) }));
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.get({}, res);
  expect(code).toBe(403);
});

test('POST /api/memory/distill dryRun=true → 不落决策', async () => {
  let decisionCalled = false;
  const deps = makeDeps({ produceDecision: async (ctx) => { decisionCalled = true; return { event_id: 'e-1' }; } });
  const router = createMemoryConfigRouter(deps);
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.post({ query: {}, body: { dryRun: true } }, res);
  expect(code).toBe(200);
  expect(body.wouldDistill).toBe(3);
  expect(decisionCalled).toBe(false);
});

test('POST /api/memory/distill 执行 → 写决策事件', async () => {
  let distillArg = null;
  const deps = makeDeps({ distill: async (ttlDays) => { distillArg = ttlDays; return { ok: true }; } });
  const router = createMemoryConfigRouter(deps);
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.post({ query: {}, body: {} }, res);
  expect(code).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.decision).toBe('e-1');
  expect(distillArg).toBe(30);
});

test('无 DELETE 路由', () => {
  const router = createMemoryConfigRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
});

// —— U4（2026-09-10 收口）：记忆页放开业务租户视图 ——
test('U4: sales 角色仅看本租户记忆（跨租户不可见）', async () => {
  const router = createMemoryConfigRouter(makeDeps({
    resolveMe: async () => ({ ok: true, role: 'sales', tenantId: 'acme-demo' }),
    listLogs: async (tenantId) => (tenantId === 'acme-demo' ? [{ id: 1 }] : []),
  }));
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.get({}, res);
  expect(code).toBe(200);
  expect(body.logs).toHaveLength(1);            // 仅本租户
});

test('U4: 非 viewer 角色（guest）被拒 403', async () => {
  const router = createMemoryConfigRouter(makeDeps({
    resolveMe: async () => ({ ok: true, role: 'guest' }),
  }));
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.get({}, res);
  expect(code).toBe(403);
});

test('U4: admin 传 ?tenant=acme-demo 收窄到该租户', async () => {
  const router = createMemoryConfigRouter(makeDeps({
    resolveMe: async () => ({ ok: true, role: 'admin', tenantId: 'system' }),
    listLogs: async (tenantId) => (tenantId === 'acme-demo' ? [{ id: 9 }] : []),
  }));
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.get({ query: { tenant: 'acme-demo' } }, res);
  expect(code).toBe(200);
  expect(body.logs).toHaveLength(1);
});