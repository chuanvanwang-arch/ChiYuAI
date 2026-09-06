// test/pages/S16-S33.test.js — Phase 3 配置中心面契约（18 面）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S16-S33 + 计划 §4 Task26-42
// 契约：每面 schema 通过 validatePageSchema + navigation ∈ CANONICAL_NAV + 组件/粒子/动作 ∈ 受控集
//       + 配置面关键断言（S20 七维×7 / S24 四查 data_origin 字段 / S16 外部徽标 / S30/S31 端点映射）
import { describe, it, expect } from 'vitest';
import { validatePageSchema } from '../../src/page/validator.js';
import { CANONICAL_NAV, PARTICLE_TYPES_ENUM, ACTION_WHITELIST, ATTR_FIELD_TYPES } from '../../src/page/schema.js';
import { schema as S16 } from '../../src/pages/S16.schema.js';
import { schema as S17 } from '../../src/pages/S17.schema.js';
import { schema as S18 } from '../../src/pages/S18.schema.js';
import { schema as S19 } from '../../src/pages/S19.schema.js';
import { schema as S20 } from '../../src/pages/S20.schema.js';
import { schema as S21 } from '../../src/pages/S21.schema.js';
import { schema as S22 } from '../../src/pages/S22.schema.js';
import { schema as S23 } from '../../src/pages/S23.schema.js';
import { schema as S24 } from '../../src/pages/S24.schema.js';
import { schema as S26 } from '../../src/pages/S26.schema.js';
import { schema as S27 } from '../../src/pages/S27.schema.js';
import { schema as S28 } from '../../src/pages/S28.schema.js';
import { schema as S29 } from '../../src/pages/S29.schema.js';
import { schema as S30 } from '../../src/pages/S30.schema.js';
import { schema as S31 } from '../../src/pages/S31.schema.js';
import { schema as S32 } from '../../src/pages/S32.schema.js';

const ALLOWED_ACTIONS = [...ACTION_WHITELIST.read, ...ACTION_WHITELIST.write];
// S25 在 Phase1 注册（S01-S25.test.js），此处测其余配置面；S33 已在 S01-S25 之外单独测
const FACES = [
  ['S16', S16, '/config/llm'],
  ['S17', S17, '/config/users'],
  ['S18', S18, '/config/rbac'],
  ['S19', S19, '/config/decision-scenarios'],
  ['S20', S20, '/config/seven-dim'],
  ['S21', S21, '/config/skills'],
  ['S22', S22, '/config/approvals'],
  ['S23', S23, '/config/business-tier'],
  ['S24', S24, '/config/meta-attr'],
  ['S26', S26, '/config/alerts'],
  ['S27', S27, '/config/ontology'],
  ['S28', S28, '/config/agents'],
  ['S29', S29, '/config/portal-pages'],
  ['S30', S30, '/config/decision-quality'],
  ['S31', S31, '/config/memory'],
  ['S32', S32, '/config/connectors'],
];

describe('Phase 3 配置中心面契约', () => {
  it.each(FACES)('%s schema 合法 + navigation 对齐受控导航', (_id, s, nav) => {
    const v = validatePageSchema(s);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.errors[0]);
    expect(s.navigation.to).toBe(nav);
    expect(CANONICAL_NAV).toContain(nav);
  });

  it.each(FACES)('%s 组件均带粒子 dataBinding 且粒子/动作 ∈ 受控集', (_id, s) => {
    for (const [i, c] of s.components.entries()) {
      if (c.kind === 'attr-field') {
        expect(c.attrSlug).toBeTruthy();
        expect(ATTR_FIELD_TYPES).toContain(c.attrType);
        continue;
      }
      expect(c.dataBinding?.source).toBe('particle');
      expect(PARTICLE_TYPES_ENUM).toContain(c.dataBinding?.particleType);
      for (const a of c.actions || []) expect(ALLOWED_ACTIONS).toContain(a.action);
    }
  });

  it('S20 七维设计含 7 个七维 attr-field（identity/structure/semantics/time/decision/operational/governance）', () => {
    const dims = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];
    for (const d of dims) {
      expect(S20.components.some((c) => c.kind === 'attr-field' && c.attrSlug === d)).toBe(true);
    }
  });

  it('S24 元模型含四查 data_origin 字段 + semantic_tag + ai_axis + confidence_threshold', () => {
    const slugs = ['data_origin', 'semantic_tag', 'ai_axis', 'confidence_threshold'];
    for (const s of slugs) {
      expect(S24.components.some((c) => c.kind === 'attr-field' && c.attrSlug === s)).toBe(true);
    }
  });

  it('S16 LLM 含 api_key 外部来源徽标（④ 外部 + 加密存储语义）', () => {
    const k = S16.components.find((c) => c.kind === 'attr-field' && c.attrSlug === 'api_key');
    expect(k?.attr?.data_origin).toBe('external');
    expect(k?.attr?.sourcedFrom?.source).toBe('secret-vault');
  });

  it('S17 用户管理含 role select + 密码 attr（secret 语义）', () => {
    expect(S17.components.some((c) => c.kind === 'select' && c.name === 'roleBind')).toBe(true);
    expect(S17.components.some((c) => c.kind === 'attr-field' && c.attrSlug === 'password')).toBe(true);
  });

  it('S21 方法论注册表含 enabled select + 表（SKILL 启停）', () => {
    expect(S21.components.some((c) => c.kind === 'select' && c.name === 'enabled')).toBe(true);
    expect(S21.components.some((c) => c.kind === 'table')).toBe(true);
  });

  it('S30/S31 决策质量/记忆面含 metric-card + 端点映射（monitor/coverage + memory/distill）', () => {
    expect(S30.components.some((c) => c.kind === 'metric-card')).toBe(true);
    expect(S31.components.some((c) => c.kind === 'goal-form' && c.action.includes('/api/memory/distill'))).toBe(true);
  });
});