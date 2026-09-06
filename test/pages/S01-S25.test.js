// test/pages/phase1-faces.test.js — Phase 1 骨架面契约（S01/S02/S13/S14/S15/S25）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3
// 契约：每面 schema 通过 validatePageSchema + navigation ∈ CANONICAL_NAV + 组件 kind ∈ 受控集
import { describe, it, expect } from 'vitest';
import { validatePageSchema } from '../../src/page/validator.js';
import { schema as S01 } from '../../src/pages/S01.schema.js';
import { schema as S02 } from '../../src/pages/S02.schema.js';
import { schema as S13 } from '../../src/pages/S13.schema.js';
import { schema as S14 } from '../../src/pages/S14.schema.js';
import { schema as S15 } from '../../src/pages/S15.schema.js';
import { schema as S25 } from '../../src/pages/S25.schema.js';

const FACES = [
  ['S01', S01, '/home'],
  ['S02', S02, '/dashboard'],
  ['S13', S13, '/particles/:id'],
  ['S14', S14, '/decision-graph'],
  ['S15', S15, '/business-board'],
  ['S25', S25, '/config/pool'],
];

describe('Phase 1 骨架面契约', () => {
  it.each(FACES)('%s schema 合法 + 导航对齐', (_id, s, nav) => {
    const v = validatePageSchema(s);
    expect(v.ok).toBe(true);
    expect(s.navigation.to).toBe(nav);
    expect(s.components.length).toBeGreaterThan(0);
  });

  it('S01 含登录 form（goal-form）', () => {
    expect(S01.components.some((c) => c.kind === 'goal-form' && c.action.includes('/api/auth/login'))).toBe(true);
  });

  it('S01 含 4 个状态 metric-card + 最新粒子 table', () => {
    const cards = S01.components.filter((c) => c.kind === 'metric-card');
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(S01.components.some((c) => c.kind === 'table')).toBe(true);
  });

  it('S02 作战室含 copilot goal-form + L2C table + SSE subtable', () => {
    expect(S02.components.some((c) => c.kind === 'goal-form' && c.action.includes('/api/page/from-nl'))).toBe(true);
    expect(S02.components.some((c) => c.kind === 'table')).toBe(true);
    expect(S02.components.some((c) => c.kind === 'subtable')).toBe(true);
  });

  it('S25 池配置为 form 型 + attr-field 四查（rule 来源）', () => {
    expect(S25.type).toBe('form');
    const attrs = S25.components.filter((c) => c.kind === 'attr-field');
    expect(attrs.length).toBeGreaterThanOrEqual(2);
    expect(attrs.every((a) => a.attr?.data_origin === 'rule')).toBe(true);
  });
});