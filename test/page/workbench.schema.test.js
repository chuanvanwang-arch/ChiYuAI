// test/page/workbench.schema.test.js — G3-T1 待办工作台四视角 Schema 契约
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G3-T1
// 断言契约：
//   ① schema 合法（type/workspace + navigation/to + layout）
//   ② 四视角组件齐备（approval-filter / my-tasks / my-initiated / cc-me）
//   ③ 粒子值域：审批实例/任务 ∈ PARTICLE_TYPES_ENUM（受控值域补全）
//   ④ 状态字段仅 eq（CRM_APPROVAL_INSTANCE.status / CRM_APPROVAL_TASK.status）
//   ⑤ 旧值/未知粒子直接拒绝（非静默映射）
import { describe, it, expect } from 'vitest';
import { validatePageSchema } from '../../src/page/validator.js';
import { PARTICLE_TYPES_ENUM, STATE_FIELDS_PER_TYPE, CANONICAL_NAV } from '../../src/page/schema.js';
import { schema } from '../../src/pages/S33-workbench.schema.js';

describe('G3-T1 S33 Workbench 四视角 Schema', () => {
  it('① schema 合法（workspace 型 + /my-todo 导航 + 通过 validator）', () => {
    expect(schema.type).toBe('workspace');
    expect(schema.navigation.to).toBe('/my-todo');
    expect(CANONICAL_NAV).toContain('/my-todo');
    const v = validatePageSchema(schema);
    expect(v.ok).toBe(true);
  });

  it('② 六视角组件齐备（approval/processing/initiated/cc/follow/tuning）', () => {
    const kinds = schema.components.map((c) => `${c.kind}:${c.view}`);
    expect(kinds).toContain('table:approval');
    expect(kinds).toContain('table:processing');
    expect(kinds).toContain('table:initiated');
    expect(kinds).toContain('table:cc');
    expect(kinds).toContain('table:follow');
    // P1 2026-09-05：参数调优视角（calibration_patch PENDING 处方行内批准/驳回）
    expect(kinds).toContain('table:tuning');
  });

  it('②b tuning 组件 rowActions 含参数调优签批动作（白名单内 crm-tune-approve/reject）', () => {
    const tuning = schema.components.find((c) => c.view === 'tuning');
    expect(tuning).toBeTruthy();
    const actions = tuning.dataBinding.rowActions.map((a) => a.action);
    expect(actions).toContain('crm-tune-approve');
    expect(actions).toContain('crm-tune-reject');
  });

  it('③ 审批粒子 ∈ 受控值域（CRM_APPROVAL_INSTANCE / CRM_APPROVAL_TASK）', () => {
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_APPROVAL_INSTANCE');
    expect(PARTICLE_TYPES_ENUM).toContain('CRM_APPROVAL_TASK');
    // schema 中四组件 dataBinding.particleType 均 ∈ 值域
    for (const c of schema.components) {
      expect(PARTICLE_TYPES_ENUM).toContain(c.dataBinding.particleType);
    }
  });

  it('④ 状态字段仅 eq（instance.status / task.status 在 STATE_FIELDS_PER_TYPE 且 validator 拒绝非 eq）', () => {
    expect(STATE_FIELDS_PER_TYPE.CRM_APPROVAL_INSTANCE).toContain('status');
    expect(STATE_FIELDS_PER_TYPE.CRM_APPROVAL_TASK).toContain('status');
    // 非 eq 过滤应被 validator 拒绝（状态字段仅 eq 护栏）
    const bad = {
      ...schema,
      components: [{ ...schema.components[0], dataBinding: { ...schema.components[0].dataBinding, filters: [{ field: 'status', op: 'gt', value: 'approved' }] } }],
    };
    const v = validatePageSchema(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/仅支持 eq/);
  });

  it('⑤ 旧值/未知粒子直接拒绝（非静默映射）', () => {
    const bad = {
      ...schema,
      components: [{ ...schema.components[0], dataBinding: { ...schema.components[0].dataBinding, particleType: 'DEAL' } }],
    };
    const v = validatePageSchema(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/旧值|未知|非法/);
  });
});