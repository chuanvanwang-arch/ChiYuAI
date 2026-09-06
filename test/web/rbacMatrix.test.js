import { test, expect } from 'vitest';
import {
  renderRbacMatrix,
  scopeModelLabel,
  cellState,
  normalizeDomainEntry,
  BUSINESS_PARTICLES,
} from '../../src/portal/rbacMatrix.js';

const PROFILES = [
  { role_tag: 'sales', data_scope: { model: 'self' } },
  { role_tag: 'manager', data_scope: { model: 'org_subtree' } },
  { role_tag: 'exec', data_scope: { model: 'all' } },
  { role_tag: 'finance', data_scope: { model: 'domain', domain: ['payment', 'contract', 'invoice'] } },
  { role_tag: 'presales', data_scope: { model: 'domain', domain: ['CRM_DEAL', 'CRM_TECHNICAL_PROPOSAL'] } },
  { role_tag: 'contract_admin', data_scope: { model: 'domain', domain: ['contract', 'invoice'] } },
];

test('BUSINESS_PARTICLES 为 12 个 canonical CRM_* 类型', () => {
  expect(BUSINESS_PARTICLES.length).toBe(12);
  expect(BUSINESS_PARTICLES).toContain('CRM_DEAL');
  expect(BUSINESS_PARTICLES.every((p) => p.startsWith('CRM_'))).toBe(true);
});

test('renderRbacMatrix 含 6 角色行 + 12 粒子列', () => {
  const html = renderRbacMatrix(PROFILES, BUSINESS_PARTICLES);
  for (const r of ['sales', 'manager', 'exec', 'finance', 'presales', 'contract_admin']) {
    expect(html).toContain(`data-role="${r}"`);
  }
  for (const p of BUSINESS_PARTICLES) {
    expect(html).toContain(p);
  }
});

test('model=all (exec) 整行 ✓ 且单元格禁用勾选', () => {
  const html = renderRbacMatrix(PROFILES, BUSINESS_PARTICLES);
  const m = html.match(/data-role="exec"[\s\S]*?<\/tr>/);
  expect(m).toBeTruthy();
  expect(m[0]).toContain('全量'); // scopeModelLabel('all')
  expect(m[0]).toContain('disabled'); // 单元格禁用
});

test('model=domain (finance) 经归一后 CRM_INVOICE 等亮✓', () => {
  const html = renderRbacMatrix(PROFILES, BUSINESS_PARTICLES);
  const m = html.match(/data-role="finance"[\s\S]*?<\/tr>/);
  expect(m).toBeTruthy();
  // 短名 payment/contract/invoice 归一后应点亮 CRM_INVOICE / CRM_CONTRACT
  expect(m[0]).toContain('CRM_INVOICE');
  expect(m[0]).toContain('checked'); // 至少一格被勾
});

test('model=self / org_subtree 整行 ⚪受限 不展示勾选', () => {
  const html = renderRbacMatrix(PROFILES, BUSINESS_PARTICLES);
  const sales = html.match(/data-role="sales"[\s\S]*?<\/tr>/);
  expect(sales[0]).toContain('仅自身');
  expect(sales[0]).not.toContain('type="checkbox"');
  const mgr = html.match(/data-role="manager"[\s\S]*?<\/tr>/);
  expect(mgr[0]).toContain('组织内');
});

test('scopeModelLabel 四 model 文案', () => {
  expect(scopeModelLabel('self')).toContain('自身');
  expect(scopeModelLabel('org_subtree')).toContain('组织');
  expect(scopeModelLabel('all')).toContain('全量');
  expect(scopeModelLabel('domain')).toContain('域');
});

test('normalizeDomainEntry 短别名→CRM_*', () => {
  expect(normalizeDomainEntry('payment')).toBe('CRM_PAYMENT_RECORD');
  expect(normalizeDomainEntry('contract')).toBe('CRM_CONTRACT');
  expect(normalizeDomainEntry('invoice')).toBe('CRM_INVOICE');
  expect(normalizeDomainEntry('CRM_DEAL')).toBe('CRM_DEAL'); // 全名直过
});

test('cellState 三态判定', () => {
  const exec = { data_scope: { model: 'all' } };
  expect(cellState(exec, 'CRM_DEAL')).toBe('all');
  const finance = { data_scope: { model: 'domain', domain: ['CRM_INVOICE'] } };
  expect(cellState(finance, 'CRM_INVOICE')).toBe('on');
  expect(cellState(finance, 'CRM_DEAL')).toBe('off');
  const sales = { data_scope: { model: 'self' } };
  expect(cellState(sales, 'CRM_DEAL')).toBe('na');
});

// ---- handler 单测（注入假 deps）----
import { createRbacRouter } from '../../src/portal/rbacMatrix.js';

function makeDeps(over = {}) {
  const rows = {
    sales: { role_tag: 'sales', data_scope: { model: 'self' } },
    finance: { role_tag: 'finance', data_scope: { model: 'domain', domain: ['CRM_INVOICE'] } },
  };
  const deps = {
    listProfiles: async () => Object.values(rows).map((r) => ({ ...r })),
    upsertProfile: async (role_tag, data_scope) => {
      rows[role_tag] = { role_tag, data_scope };
      return { role_tag, data_scope };
    },
    produceDecision: over.produceDecision || (async () => ({ decision_id: 'd1' })),
    BUSINESS_PARTICLES,
  };
  return deps;
}

test('GET /api/rbac 返回 profiles + particles', async () => {
  const router = createRbacRouter(makeDeps());
  let captured = null;
  const res = { json: (x) => { captured = x; return x; } };
  await router.handlers.get({}, res);
  expect(captured.profiles.length).toBe(2);
  expect(captured.particles).toEqual(BUSINESS_PARTICLES);
});

test('PUT /api/rbac upsert 并触发 produceDecision', async () => {
  let decided = null;
  const deps = makeDeps({ produceDecision: async (d) => { decided = d; return { decision_id: 'd2' }; } });
  const router = createRbacRouter(deps);
  const res = { json: (x) => x };
  await router.handlers.put({ body: { role_tag: 'finance', model: 'domain', domain: ['CRM_INVOICE', 'CRM_CONTRACT'] } }, res);
  expect(decided).not.toBeNull();
  expect(decided.role_tag).toBe('finance');
});

test('PUT 缺 role_tag → 400', async () => {
  const router = createRbacRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { model: 'domain' } }, res);
  expect(status).toBe(400);
});
