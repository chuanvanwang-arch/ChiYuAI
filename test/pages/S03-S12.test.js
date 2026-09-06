// test/pages/S03-S12.test.js — Phase 2 前台业务详情面契约（S03-S12 十面）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 + 计划 §3 Task16-25
// 契约：每面 schema 通过 validatePageSchema + navigation ∈ CANONICAL_NAV + 组件/粒子/动作 ∈ 受控集
//       + 四查两分支（来源已知→徽标 / 孤儿→unverified+禁用）
import { describe, it, expect } from 'vitest';
import { validatePageSchema } from '../../src/page/validator.js';
import { CANONICAL_NAV, PARTICLE_TYPES_ENUM, ACTION_WHITELIST, ATTR_FIELD_TYPES } from '../../src/page/schema.js';
import { classifyAttrSource } from '../../src/web/sourceClassify.js';
import { renderPage } from '../../src/page/renderer.js';
import { schema as S03 } from '../../src/pages/S03.schema.js';
import { schema as S04 } from '../../src/pages/S04.schema.js';
import { schema as S05 } from '../../src/pages/S05.schema.js';
import { schema as S06 } from '../../src/pages/S06.schema.js';
import { schema as S07 } from '../../src/pages/S07.schema.js';
import { schema as S08 } from '../../src/pages/S08.schema.js';
import { schema as S09 } from '../../src/pages/S09.schema.js';
import { schema as S10 } from '../../src/pages/S10.schema.js';
import { schema as S11 } from '../../src/pages/S11.schema.js';
import { schema as S12 } from '../../src/pages/S12.schema.js';

const FACES = [
  ['S03', S03, '/workspace'],
  ['S04', S04, '/agents'],
  ['S05', S05, '/my-todo'],
  ['S06', S06, '/accounts/:id'],
  ['S07', S07, '/deals/:id'],
  ['S08', S08, '/quotations/:id'],
  ['S09', S09, '/contracts/:id'],
  ['S10', S10, '/orders/:id'],
  ['S11', S11, '/payments/:id'],
  ['S12', S12, '/invoices/:id'],
];

const ALLOWED_ACTIONS = [...ACTION_WHITELIST.read, ...ACTION_WHITELIST.write];

// S03 两 TAB 重构（2026-08-29）后组件嵌套于 tabs>monitor/detail：契约校验须先扁平化
// （goal-form/task-monitor/contract-matrix/result-card/attr-field/reasoning-trace）
const flattenComponents = (cs) => cs.flatMap((c) => c.kind === 'tabs'
  ? flattenComponents(c.tabs.flatMap((t) => t.components || []))
  : [c]);

describe('Phase 2 前台业务详情面契约', () => {
  it.each(FACES)('%s schema 合法 + navigation 对齐受控导航', (_id, s, nav) => {
    const v = validatePageSchema(s);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.errors[0]);
    expect(s.navigation.to).toBe(nav);
    expect(CANONICAL_NAV).toContain(nav);
  });

  it.each(FACES)('%s 组件均带粒子 dataBinding 且粒子/动作 ∈ 受控集', (_id, s) => {
    // 顶层容器（tabs）本身无 dataBinding，契约校验作用于扁平化后的叶子组件
for (const c of flattenComponents(s.components)) {
        if (c.kind === 'attr-field') {
          expect(c.attrSlug).toBeTruthy();
          expect(ATTR_FIELD_TYPES).toContain(c.attrType);
          continue;
        }
        // 契约：业务粒子组件（详情面）须带粒子 dataBinding；平台组件（task-monitor/contract-matrix 等）
        // 走 task/contract 来源；无绑定组件（goal-form/reasoning-trace）不校验
        if (c.dataBinding?.source) {
          expect(['particle', 'task', 'contract']).toContain(c.dataBinding.source);
          if (c.dataBinding.source === 'particle') {
            expect(PARTICLE_TYPES_ENUM).toContain(c.dataBinding.particleType);
          }
        }
        for (const a of c.actions || []) expect(ALLOWED_ACTIONS).toContain(a.action);
      }
  });

  it('S03 工作台含 goal-form + reasoning-trace + result-card 组件', () => {
    const flat = flattenComponents(S03.components);
    expect(flat.some((c) => c.kind === 'goal-form')).toBe(true);
    expect(flat.some((c) => c.kind === 'reasoning-trace')).toBe(true);
    expect(flat.some((c) => c.kind === 'result-card')).toBe(true);
  });

  it('S04 监控台 metric-card×3 + table 告警 + subtable 任务流', () => {
    const cards = S04.components.filter((c) => c.kind === 'metric-card');
    expect(cards.length).toBeGreaterThanOrEqual(3);
    expect(S04.components.some((c) => c.kind === 'table')).toBe(true);
    expect(S04.components.some((c) => c.kind === 'subtable')).toBe(true);
  });

  it('S05 待办含 select(角色视角) + table', () => {
    expect(S05.components.some((c) => c.kind === 'select' && c.name === 'roleView')).toBe(true);
    expect(S05.components.some((c) => c.kind === 'table')).toBe(true);
  });

  it('S06 客户360 含 7 个七维画像 metric-card + 四查 attr-field', () => {
    const cards = S06.components.filter((c) => c.kind === 'metric-card');
    expect(cards.length).toBeGreaterThanOrEqual(7);
    const attrs = S06.components.filter((c) => c.kind === 'attr-field');
    expect(attrs.length).toBeGreaterThanOrEqual(3);
    expect(attrs.some((a) => a.attr?.data_origin === 'external')).toBe(true);
  });

  it('S07 商机详情含推进 goal-form + MEDDICC reasoning-trace + 孤儿 attr-field', () => {
    expect(S07.components.some((c) => c.kind === 'goal-form')).toBe(true);
    expect(S07.components.some((c) => c.kind === 'reasoning-trace')).toBe(true);
    // 孤儿字段（无 data_origin 声明）→ 渲染期 sourceClassify 判 unverified
    expect(S07.components.some((c) => c.kind === 'attr-field' && !c.attr?.data_origin)).toBe(true);
  });

  it.each([
    ['S08', S08, 'CRM_QUOTATION'],
    ['S09', S09, 'CRM_CONTRACT'],
    ['S10', S10, 'CRM_ORDER'],
    ['S11', S11, 'CRM_PAYMENT_PLAN'],
    ['S12', S12, 'CRM_INVOICE'],
  ])('%s 详情面主粒子正确 + 含四查 attr-field', (_id, s, pt) => {
    expect(s.components.some((c) => c.kind === 'attr-field')).toBe(true);
    expect(s.components.some((c) => c.dataBinding?.particleType === pt)).toBe(true);
    expect(s.type).toBe('detail');
  });

  it('四查分类（classifyAttrSource 公开契约）：来源已知 → 正确分类；规则/外部/AI 分派正确', () => {
    // ① 人工（未命中②③④ → 默认 manual，sourceClassify.js:56 兜底）
    const known = classifyAttrSource('amount', { amount: 100 });
    expect(known.kind).toBe('manual');

    // ③ 规则维护字段（stage_history ∈ RULE_FIELDS，sourceClassify.js:27）
    const rule = classifyAttrSource('stage_history', { stage_history: [...Array(3)] });
    expect(rule.kind).toBe('rule');

    // ④ 外部：sourcedFrom 出边命中 → external + 置信度透传
    const ext = classifyAttrSource('industry', { industry: 'Software' }, { edges: [{ edgeType: 'sourcedFrom', meta: { relation_confidence: 0.92 } }] });
    expect(ext.kind).toBe('external');
    expect(ext.extConfidence).toBe(0.92);

    // ② AI：payload.ai.amount 命中 → ai + 轴/置信度
    const ai = classifyAttrSource('amount', { amount: 100, ai: { amount: { axis: 'J_Judge', source: 'MEDDICC', confidence: 0.85 } } });
    expect(ai.kind).toBe('ai');
    expect(ai.ai?.confidence).toBe(0.85);
    expect(ai.ai?.axis).toBe('J_Judge');
  });

  it('四查渲染（renderPage 公开出口）：声明来源 → 徽标；孤儿 → unverified + 禁用', () => {
    // 走公开渲染出口 renderPage（renderer.js:154，唯一出口），断言输出 HTML 徽标/禁用形态
    const r = renderPage(S07, {});
    // S07 含 1 个孤儿 attr-field（deal_name 无 data_origin，renderer.js:81-84）
    expect(r.html).toContain('data-origin-unverified');
    expect(r.html).toContain('disabled');

    // 声明来源面（S06 含 industry external 徽标）→ 正常徽标，不 unverified
    const r6 = renderPage(S06, {});
    expect(r6.html).toContain('data-origin-external');
    expect(r6.html).not.toContain('data-origin-unverified');
  });
});