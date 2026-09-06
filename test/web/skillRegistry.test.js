// test/web/skillRegistry.test.js — 方法论 SKILL 注册表（第 16 项）TDD
import { test, expect } from 'vitest';
import {
  SKILL_STATUS_BADGE, renderSkillRegistryHeader, renderSkillRegistryTable, validateSkillToggle,
} from '../../src/portal/skillRegistryRender.js';

// —— 前端 Render（skillRegistryRender.js）——
test('常量：SKILL_STATUS_BADGE 含 ready/disabled', () => {
  expect(SKILL_STATUS_BADGE).toHaveProperty('ready');
  expect(SKILL_STATUS_BADGE).toHaveProperty('disabled');
});

test('validateSkillToggle 合法/非法', () => {
  expect(validateSkillToggle({ skill_id: 'method-bant', enabled: true }).ok).toBe(true);
  expect(validateSkillToggle({ skill_id: 'method-bant', enabled: 'yes' }).ok).toBe(false); // enabled 非布尔
  expect(validateSkillToggle({ enabled: true }).ok).toBe(false); // 缺 skill_id
});

test('renderSkillRegistryTable 表格含 skill_id + enabled 开关', () => {
  const rows = [
    { skill_id: 'method-bant', category: 'methodology', enabled: true, rbac_roles: ['sales'], methodology_id: 'BANT', source: 'db' },
    { skill_id: 'crm-query', category: 'agent', enabled: false, rbac_roles: ['sales', 'manager'], methodology_id: null, source: 'skill' },
  ];
  const html = renderSkillRegistryTable(rows);
  expect(html).toContain('method-bant');
  expect(html).toContain('crm-query');
  expect(html).toContain('enabled');          // 开关列
  expect(html).toContain('badge off');        // crm-query 关态徽标（off 范式，对齐禁删徽标）
});

test('renderSkillRegistryHeader 含计数', () => {
  const html = renderSkillRegistryHeader({ total: 11, enabledCount: 9 });
  expect(html).toContain('11');
  expect(html).toContain('9');
});

// —— 后端 Router（skillRegistry.js 注入式 handlers）——
import { createSkillRegistryRouter } from '../../src/portal/skillRegistry.js';

function makeDeps(overrides = {}) {
  const state = { enabled: {}, listCalled: 0, putCalled: 0, decisionCalled: false };
  const skillsBase = [
    { skill_id: 'method-bant', category: 'methodology', enabled: true, rbac_roles: ['sales'], methodology_id: 'BANT', source: 'db' },
    { skill_id: 'crm-query', category: 'agent', enabled: false, rbac_roles: ['sales', 'manager'], methodology_id: null, source: 'skill' },
  ];
  return {
    state,
    deps: {
      list: async () => { state.listCalled++; return skillsBase.map((s) => ({ ...s, enabled: state.enabled[s.skill_id] ?? s.enabled })); },
      setEnabled: async (skillId, enabled) => { state.putCalled++; state.enabled[skillId] = enabled; return { skill_id: skillId, enabled }; },
      produceDecision: async () => { state.decisionCalled = true; return { decisionId: 'dec-x', ok: true }; },
      resolveMe: async () => ({ ok: true, role: 'admin' }),
      ...overrides,
    },
  };
}

test('GET /api/config/skill-registry 返回注册表快照', async () => {
  const { deps } = makeDeps();
  const router = createSkillRegistryRouter(deps);
  let body = null;
  const res = { json: (p) => { body = p; return res; }, status: () => res };
  await router.handlers.get({}, res);
  expect(body.total).toBe(2);
  expect(body.skills[0].skill_id).toBe('method-bant');
});

test('PUT 合法启停翻转（写经第0闸）', async () => {
  const { deps, state } = makeDeps();
  const router = createSkillRegistryRouter(deps);
  let body = null;
  const res = { json: (p) => { body = p; return res; }, status: () => res };
  await router.handlers.put({ body: { skill_id: 'method-bant', enabled: false } }, res);
  expect(state.enabled['method-bant']).toBe(false);
  expect(state.decisionCalled).toBe(true);       // 第0闸被调用
  expect(body.enabled).toBe(false);
});

test('PUT 非 sysadmin → 403', async () => {
  const { deps } = makeDeps({ resolveMe: async () => ({ ok: true, role: 'sales' }) });
  const router = createSkillRegistryRouter(deps);
  let body = null, code = null;
  const res = { json: (p) => { body = p; return res; }, status: (c) => { code = c; return res; } };
  await router.handlers.put({ body: { skill_id: 'method-bant', enabled: true } }, res);
  expect(code).toBe(403);
});

test('PUT 缺 enabled → 400', async () => {
  const { deps } = makeDeps();
  const router = createSkillRegistryRouter(deps);
  let body = null, code = null;
  const res = { json: (p) => { body = p; return res; }, status: (c) => { code = c; return res; } };
  await router.handlers.put({ body: { skill_id: 'method-bant' } }, res);
  expect(code).toBe(400);
});