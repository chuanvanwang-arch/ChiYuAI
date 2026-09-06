// test/knowledge.test.js — 租户级 Knowledge（P0-②）纯逻辑单测（无 PG 依赖，本地可全绿）
// 依据：docs/superpowers/plans/2026-09-03-tenant-knowledge.md（T1/T2/T3/T4 纯逻辑部分）
import { describe, it, expect, beforeAll } from 'vitest';
import { PARTICLE_TYPES } from '../src/particles/particleModel.js';
import { seedActions } from '../src/action/seed-actions.js';
import { getAction } from '../src/action/registry.js';

// ───────────────────────── T1 · CRM_KNOWLEDGE coreAttributes ─────────────────────────
describe('CRM_KNOWLEDGE 粒子定义', () => {
  it('coreAttributes 包含 kind/content/source/confidence/tags', () => {
    const def = PARTICLE_TYPES.CRM_KNOWLEDGE;
    expect(def).toBeDefined();
    const attrs = Object.keys(def.coreAttributes || {});
    expect(attrs).toEqual(expect.arrayContaining(['kind', 'content', 'source', 'confidence', 'tags']));
  });
  it('identity 仍为 term', () => {
    expect(PARTICLE_TYPES.CRM_KNOWLEDGE.identity).toEqual(['term']);
  });
});

// ───────────────────────── T2 · crm-knowledge-upsert Action 注册 ─────────────────────────
describe('crm-knowledge-upsert Action 注册', () => {
  beforeAll(() => seedActions());
  it('已注册为 write + confirm:critical + rbac_roles', () => {
    const a = getAction('crm-knowledge-upsert');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.confirm).toBe('critical');
    expect(a.rbac_roles).toEqual(expect.arrayContaining(['manager', 'presales', 'exec', 'sysadmin']));
  });
  it('参数 schema 定义 term/kind/content', () => {
    const a = getAction('crm-knowledge-upsert');
    expect(a.parameters.required).toEqual(expect.arrayContaining(['term', 'kind', 'content']));
  });
});

// ───────────────────────── T3 · Knowledge 注入映射（纯逻辑） ─────────────────────────
import { SCENARIO_KNOWLEDGE_MAP, resolveKnowledgeKinds, buildKnowledgeRows } from '../src/context/assembler.js';

describe('Knowledge 注入映射（纯逻辑）', () => {
  it('QUOTE_PRICING → competitors+objections', () => {
    expect(SCENARIO_KNOWLEDGE_MAP.QUOTE_PRICING).toEqual(['competitors', 'objections']);
  });
  it('未知 scenario 回退全量（缺省）', () => {
    expect(resolveKnowledgeKinds('UNKNOWN_SCENE')).toEqual(['icp', 'competitors', 'objections', 'buyer_language']);
  });
  it('resolveKnowledgeKinds 应用配置覆盖', () => {
    expect(resolveKnowledgeKinds('QUOTE_PRICING', { QUOTE_PRICING: ['icp'] })).toEqual(['icp']);
  });
  it('buildKnowledgeRows 行格式 {kind, term, content}', () => {
    const rows = buildKnowledgeRows([
      { payload: { kind: 'icp', term: 'T', content: 'C' } },
    ]);
    expect(rows[0]).toEqual({ kind: 'icp', term: 'T', content: 'C' });
  });
  it('buildKnowledgeRows 空输入 → 空数组', () => {
    expect(buildKnowledgeRows(null)).toEqual([]);
  });
});

// ───────────────────────── T4 · C4 通道分流（纯逻辑） ─────────────────────────
import { routeRetroChannels } from '../src/decision/closureLoop.js';

describe('C4 通道分流（纯逻辑）', () => {
  it('knowledge_particles 非数组 → 空数组（fail-safe）', () => {
    const r = routeRetroChannels({});
    expect(Array.isArray((r).knowledge_particles)).toBe(true);
    expect((r).knowledge_particles).toHaveLength(0);
  });
  it('结构化 knowledge_particles 透传', () => {
    const kp = [{ term: 't', kind: 'buyer_language', content: 'c' }];
    const r = routeRetroChannels({ knowledge_particles: kp });
    expect(r.knowledge_particles).toEqual(kp);
  });
});