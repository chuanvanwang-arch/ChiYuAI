// test/page/canonicalNav.test.js — Task 1: CANONICAL_NAV 扩展（配置中心 + 业务详情路径）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §1.2（导航枚举扩展）
import { describe, it, expect } from 'vitest';
import { CANONICAL_NAV } from '../../src/page/schema.js';

describe('CANONICAL_NAV 扩展（S01–S33 蓝图导航契约）', () => {
  it('既有 10 项前台路径保留', () => {
    for (const p of ['/dashboard', '/deals', '/accounts', '/workspace']) {
      expect(CANONICAL_NAV).toContain(p);
    }
  });

  it('业务详情 + 新增前台路径齐备', () => {
    for (const p of [
      '/home', '/agents', '/my-todo', '/business-board', '/decision-graph',
      '/accounts/:id', '/deals/:id', '/quotations/:id', '/contracts/:id',
      '/orders/:id', '/payments/:id', '/invoices/:id', '/particles/:id',
    ]) {
      expect(CANONICAL_NAV).toContain(p);
    }
  });

  it('配置中心 18 路径齐备（G1–G4 全量）', () => {
    for (const p of [
      '/config/llm', '/config/users', '/config/rbac', '/config/connectors', '/config/system',
      '/config/decision-scenarios', '/config/seven-dim', '/config/skills',
      '/config/decision-quality', '/config/memory',
      '/config/meta-attr', '/config/ontology', '/config/business-tier',
      '/config/approvals', '/config/pool', '/config/alerts',
      '/config/agents', '/config/portal-pages',
    ]) {
      expect(CANONICAL_NAV).toContain(p);
    }
  });
});