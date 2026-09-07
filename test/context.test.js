// test/context.test.js — 上下文分层 L1-L4 验收（阶段 2 首个子系统）
// TDD：每 Task 追加 describe 块；依赖共享真实 PG（需先 `node db/migrate.js --seed`）
//
// 本沙箱无 PG（127.0.0.1:5433 拒连），故：
//  - 纯逻辑（scopeModel/inScopeByModel/formatForPrompt/enforceScope 写创建分支/assembler 注入 retriever）在本地可真实跑绿；
//  - 触 DB 的集成用例（roleProfiles 加载 / actorRole 解析 / executor 第1闸 / buildContextBlock）需在 PG 就绪环境运行。
import { describe, test, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { loadProfile, getAllProfiles, seedProfiles } from '../src/context/roleProfiles.js';
import { scopeModel, inScopeByModel, enforceScope, isParticleScoped } from '../src/context/scope.js';
import { assembleContext } from '../src/context/assembler.js';
import { formatForPrompt } from '../src/context/injector.js';
import { actionExecutor } from '../src/action/executor.js';
import { buildContextBlock } from '../src/agent/agentLoop.js';
import { seedActions } from '../src/action/seed-actions.js';
import { reseedBase, seedContextProfiles } from './helpers/seedFixture.js';

beforeAll(async () => {
  seedActions();
  // 共享真实 PG + 文件按字母序执行：attio/http/interaction-index 的 beforeEach TRUNCATE 会清掉
  // crm.particles 种子（CRM_PERSON/CRM_DEAL/CRM_ACCOUNT），本文件全部用例依赖种子在场 →
  // 幂等重灌（seed.sql WHERE NOT EXISTS，重复执行零副作用）。
  await reseedBase();
  // 上下文分层自包含夹具：补 actorRole 依赖的 CRM_PERSON / CRM_ORGANIZATION / person-sales-a 商机
  // （生产 seed.sql 不含这些，actorRole 会恒返回 null → scopeModel 降级 all）
  await seedContextProfiles();
});

// ===== T1: DB 种子（role_context_profile 表 + 8 行 + 七要素七键）===== [需 PG]
describe('context DB 种子', () => {
  test('role_context_profile 表存在且 8 行（含 sysadmin/ten_admin，2026-09-04 扩容后）', async () => {
    const r = await query(`SELECT count(*)::int AS n FROM crm.role_context_profile`);
    expect(r.rows[0].n).toBe(8);
  });
  test('每角色七要素七键齐备', async () => {
    const r = await query(`SELECT role_tag, seven_elements FROM crm.role_context_profile`);
    expect(r.rows).toHaveLength(8);
    const keys = ['core_focus', 'default_query_pref', 'l2c_workflow', 'kpi_baseline', 'cross_role_collab', 'permission_boundary', 'role_subtype'];
    for (const row of r.rows) for (const k of keys) expect(row.seven_elements[k]).toBeDefined();
  });
});

// ===== T2: roleProfiles 加载/缓存/全量/幂等 seed [需 PG] =====
describe('roleProfiles', () => {
  test('loadProfile 命中缓存且字段完整', async () => {
    const p = await loadProfile('manager');
    expect(p.data_scope.model).toBe('org_subtree');
    expect(p.seven_elements.permission_boundary).toContain('团队');
  });
  test('loadProfile 未知角色返回 null', async () => {
    expect(await loadProfile('ghost')).toBeNull();
  });
  test('seedProfiles 幂等返回 8', async () => {
    const n = await seedProfiles();
    expect(n).toBe(8);
    expect(await seedProfiles()).toBe(8);
  });
});

// ===== T3: scope 纯判定（无需 DB，本地可跑绿）=====
describe('scope 纯判定', () => {
  const mk = (m, domain) => ({ data_scope: domain ? { model: m, domain } : { model: m } });
  test('5 角色 scopeModel 映射', () => {
    expect(scopeModel(mk('self'))).toBe('self');
    expect(scopeModel(mk('org_subtree'))).toBe('org_subtree');
    expect(scopeModel(mk('all'))).toBe('all');
    expect(scopeModel(mk('domain', ['payment']))).toBe('domain');
  });
  test('inScopeByModel 越界判定', () => {
    expect(inScopeByModel('all', {})).toBe(true);
    expect(inScopeByModel('self', { actor: 'A', ownerId: 'A' })).toBe(true);
    expect(inScopeByModel('self', { actor: 'A', ownerId: 'B' })).toBe(false);
    expect(inScopeByModel('org_subtree', { subtree: ['org-hq'], ownerOrg: 'org-hq' })).toBe(true);
    expect(inScopeByModel('org_subtree', { subtree: ['org-hq'], ownerOrg: 'org-other' })).toBe(false);
    expect(inScopeByModel('domain', { allowedDomains: ['payment'], type: 'payment' })).toBe(true);
    expect(inScopeByModel('domain', { allowedDomains: ['payment'], type: 'quote' })).toBe(false);
  });
  test('isParticleScoped 命中粒子相关 Action', () => {
    expect(isParticleScoped({ name: 'data-particle-read' })).toBe(true);
    expect(isParticleScoped({ name: 'crm-deal-advance' })).toBe(true);
    expect(isParticleScoped({ name: 'crm-skill-run' })).toBe(false);
  });
});

// ===== T4: enforceScope 闸判定（写创建分支纯逻辑本地可跑绿；self/domain 读路径触 DB）=====
describe('enforceScope 第1闸', () => {
  test('data-particle-create 自动补 owner=actor（纯逻辑, 免 DB）', async () => {
    const profile = { data_scope: { model: 'self' } };
    const params = { type: 'CRM_DEAL', payload: { name: '新商机' } };
    const v = await enforceScope({ name: 'data-particle-create', kind: 'write' }, { actor: 'person-sales-a' }, params, profile);
    expect(v.ok).toBe(true);
    expect(params.payload.owner_id).toBe('person-sales-a');
  });
  test('all 模型全量放行', async () => {
    const profile = { data_scope: { model: 'all' } };
    const v = await enforceScope({ name: 'data-particle-read' }, { actor: 'x' }, { ownerId: 'y' }, profile);
    expect(v.ok).toBe(true);
  });
  // 以下 self/domain 读路径经 resolveTargetOwner 触 DB，需在 PG 环境运行
  test('self 模型读他人 owner → scope_violation [需 PG]', async () => {
    const profile = { data_scope: { model: 'self' } };
    const r = await query(`SELECT id FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'owner_id'='person-sales-a' LIMIT 1`);
    const v = await enforceScope({ name: 'data-particle-read', kind: 'read' }, { actor: 'person-sales-b' }, { id: r.rows[0].id }, profile);
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('scope_violation');
  });
  test('domain 模型 type 不在 domain → scope_violation [需 PG]', async () => {
    const profile = { data_scope: { model: 'domain', domain: ['payment', 'contract', 'invoice'] } };
    const r = await query(`SELECT id FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'owner_id'='person-sales-a' LIMIT 1`);
    const v = await enforceScope({ name: 'data-particle-read', kind: 'read' }, { actor: 'person-finance' }, { id: r.rows[0].id }, profile);
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('scope_violation');
  });
});

// ===== T5: assembler 降级链（注入 retriever 免 DB，本地可跑绿）=====
describe('assembler 降级链', () => {
  test('L1 正常 → 四层填充, degraded=false', async () => {
    const b = await assembleContext(
      { actor: 'person-manager', intent: { scenario: 'OPP_QUALIFY' }, query: '商机推进' },
      {
        L1: async () => [{ title: 'k1' }],
        L2: async () => ({ decisions: [] }),
        L3: async () => ({ tasks: [] }),
        L4: async () => ({ profile: { core_focus: '团队达标' }, data_scope: { model: 'org_subtree' }, tiers: [] }),
      }
    );
    // 注：scopeModel 由 DB(safeActorRole→loadProfile) 派生，注入 retriever 不影响该值；
    // 本断言仅验证降级链与四层装配（scopeModel 在 PG 就绪环境由角色解析得出）。
    expect(b.degraded).toBe(false);
    expect(b.layers.L1).toBeDefined();
    expect(b.layers.L2).toBeDefined();
    expect(b.layers.L3).toBeDefined();
    expect(b.layers.L4).toBeDefined();
  });
  test('L1 抛错 → degraded=true 且 L2/L3/L4 仍填充, 不抛', async () => {
    const stub = async () => [];
    const b = await assembleContext(
      { actor: 'person-manager', intent: { scenario: 'OPP_QUALIFY' }, query: 'x' },
      { L1: async () => { throw new Error('vector down'); }, L2: stub, L3: stub, L4: stub }
    );
    expect(b.degraded).toBe(true);
    expect(b.missing.L1).toBe(true);
    expect(b.layers.L2).toBeDefined();
    expect(b.layers.L3).toBeDefined();
    expect(b.layers.L4).toBeDefined();
  });
});

// ===== T6: injector 格式化（纯逻辑, 本地可跑绿）=====
describe('injector 格式化', () => {
  test('manager 块含 org_subtree 标记, sales 块含 self 标记', () => {
    const mgr = formatForPrompt({ layers: { L4: { profile: { core_focus: '团队达标', permission_boundary: '团队子树内商机/客户读写' } } }, degraded: false, missing: {}, scopeModel: 'org_subtree' });
    expect(mgr).toContain('org_subtree');
    expect(mgr).toContain('团队');
    const sales = formatForPrompt({ layers: { L4: { profile: { core_focus: '个人商机推进', permission_boundary: '仅本人商机/客户读写' } } }, degraded: false, missing: {}, scopeModel: 'self' });
    expect(sales).toContain('self');
  });
  test('降级时明示上下文已降级', () => {
    const b = formatForPrompt({ layers: {}, degraded: true, missing: { L1: true }, scopeModel: 'all' });
    expect(b).toContain('已降级');
  });
});

// ===== T7: executor 第1闸（集成, 触 DB）===== [需 PG]
describe('executor 第1闸', () => {
  test('销售读他人商机 → scope_violation（区别于 decision_required）', async () => {
    const r = await query(`SELECT id FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'owner_id'='person-sales-a' LIMIT 1`);
    const res = await actionExecutor.dispatch('data-particle-read', { id: r.rows[0].id }, { tenantId: 'system', actor: 'person-sales-b' });
    expect(res.ok).toBe(false);
    expect(res.gate).toBe('scope_violation');
  });
  test('经理读子树商机 ok / exec 全量 ok', async () => {
    const r = await query(`SELECT id FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'owner_id'='person-sales-a' LIMIT 1`);
    const vMgr = await actionExecutor.dispatch('data-particle-read', { id: r.rows[0].id }, { tenantId: 'system', actor: 'person-manager' });
    expect(vMgr.ok).toBe(true);
    const vExec = await actionExecutor.dispatch('data-particle-read', { id: r.rows[0].id }, { tenantId: 'system', actor: 'person-exec' });
    expect(vExec.ok).toBe(true);
  });
  test('bootstrap 旁路跳过两闸', async () => {
    const r = await query(`SELECT id FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'owner_id'='person-sales-a' LIMIT 1`);
    const res = await actionExecutor.dispatch('data-particle-read', { id: r.rows[0].id }, { tenantId: 'system', actor: 'person-sales-b', bootstrap: true });
    expect(res.ok).toBe(true);
  });
});

// ===== T8: agentLoop 上下文注入（集成, 触 DB）===== [需 PG]
describe('agentLoop 上下文注入', () => {
  test('buildContextBlock: 经理带 org_subtree 标记, 销售带 self 标记', async () => {
    const mgr = await buildContextBlock({ payload: { intent: { scenario: 'OPP_QUALIFY' }, query: '团队业绩' } }, { actor: 'person-manager' });
    // 契约：buildContextBlock 返回 { block, bundle }（agentLoop 需 bundle 计算 knowledge_layers_read）
    expect(mgr.bundle).toBeDefined();
    expect(mgr.block).toContain('org_subtree');
    const sales = await buildContextBlock({ payload: { intent: { scenario: 'OPP_QUALIFY' }, query: '我的业绩' } }, { actor: 'person-sales-a' });
    expect(sales.block).toContain('self');
  });
});
