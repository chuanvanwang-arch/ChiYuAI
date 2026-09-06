// P0-② 思维要素拆解单测（设计 §11.2 L3 之前的契约层验收，纯函数可单测）
import { describe, it, expect } from 'vitest';
import { getThinkingTemplate, buildPreContext, TEMPLATES } from '../../src/decision/thinkingTemplates.js';

const EIGHT_KEYS = ['intent', 'assumptions', 'inference', 'viewpoints', 'implications', 'risk_register', 'stop_loss', 'concept_refs'];

describe('P0-② 思维要素拆解 · LEAD_FOLLOW_UP', () => {
  it('模板注册且含完整 8 要素', () => {
    const tpl = getThinkingTemplate('LEAD_FOLLOW_UP');
    expect(tpl.generic).toBe(false);
    expect(tpl.scenario_id).toBe('LEAD_FOLLOW_UP');
    expect(tpl.elements).toHaveLength(8);
    const keys = tpl.elements.map((e) => e.element);
    expect(keys).toEqual(EIGHT_KEYS); // 与 materializeEightElements 列序一致
  });

  it('每个要素具备完整拆解字段（不静默缺项）', () => {
    const tpl = getThinkingTemplate('LEAD_FOLLOW_UP');
    for (const el of tpl.elements) {
      expect(el.label).toBeTruthy();
      expect(el.guiding_question).toBeTruthy();
      expect(Array.isArray(el.prompts) && el.prompts.length > 0).toBe(true);
      expect(Array.isArray(el.expected_fields) && el.expected_fields.length > 0).toBe(true);
      expect(Array.isArray(el.ruler_keys) && el.ruler_keys.length > 0).toBe(true);
      expect(typeof el.example).toBe('string');
    }
  });

  it('S1 聚焦要素与 §7.2 初值一致（assumptions/intent/conditions_evaluated）', () => {
    const tpl = getThinkingTemplate('LEAD_FOLLOW_UP');
    const byKey = Object.fromEntries(tpl.elements.map((e) => [e.element, e]));
    // 设计 §7.2：S1 focus_elements = 假设·问题·信息 → assumptions / intent / (conditions_evaluated 不属八要素物化列，故模板聚焦 assumptions+intent)
    expect(byKey.assumptions.methodology).toEqual(expect.arrayContaining(['BANT', 'MEDDICC']));
    expect(byKey.intent.ruler_keys).toContain('clarity');
    // 概念要素绑 BANT/MEDDICC/OPP_MATRIX（与 §7.2 已绑方法论一致）
    expect(byKey.concept_refs.methodology).toEqual(expect.arrayContaining(['BANT', 'OPP_MATRIX']));
  });

  it('buildPreContext 合并场景 focus 标注（×1.5 焦点标记）', () => {
    const scenario = {
      stage: '一、线索',
      focus_elements: [{ key: 'assumptions', weight: 1.5 }, { key: 'intent', weight: 1.5 }, { key: 'conditions_evaluated', weight: 1.5 }],
      focus_rulers: [{ key: 'relevance', weight: 1.5 }],
      required_dims: [{ dim: 'identity', on_missing: 'warn' }],
      rubric_pass_line: 0.5,
      retro_required: true,
    };
    const out = buildPreContext('LEAD_FOLLOW_UP', { scenario });
    expect(out.thinking_skeleton).toHaveLength(8);
    const byKey = Object.fromEntries(out.thinking_skeleton.map((e) => [e.element, e]));
    expect(byKey.assumptions.focus).toBe(true); // 焦点要素标记
    expect(byKey.intent.focus).toBe(true);
    expect(byKey.inference.focus).toBe(false); // 非焦点不误标
    expect(out.focus_elements).toEqual(scenario.focus_elements);
    expect(out.required_dims).toEqual(scenario.required_dims);
    expect(out.rubric_pass_line).toBe(0.5);
    expect(out.retro_required).toBe(true);
    expect(out.stage_label).toBe('一、线索');
  });

  it('未注册场景返回通用 8 要素兜底（不静默不抛错）', () => {
    const out = buildPreContext('SOME_NEW_SCEN', { scenario: {} });
    expect(out.generic).toBe(true);
    expect(out.thinking_skeleton).toHaveLength(8);
    const keys = out.thinking_skeleton.map((e) => e.element);
    expect(keys).toEqual(EIGHT_KEYS);
    expect(out.focus_elements).toBeNull(); // 无场景配置则诚实为空
  });

  it('pre_context 七维供给提示透传（真实流量时由 assembleContextV2 填充）', () => {
    const out = buildPreContext('LEAD_FOLLOW_UP', {
      scenario: {},
      preContext: { prompt_block: '▸ 事实（S1）…', supplied_dims: 3, dim_coverage: {} },
    });
    expect(out.pre_context).toEqual({ prompt_block: '▸ 事实（S1）…', supplied_dims: 3, dim_coverage: {} });
  });
});

// ── Task A：补全 7 销售场景（OPP_QUALIFY/CLIENT_STRATEGY/SOLUTION_VALUE/QUOTE_PRICING/SIGN_RISK/POST_CONTRACT/LOSS_REVIEW）──
const ALL_SCENARIOS = ['LEAD_FOLLOW_UP','OPP_QUALIFY','CLIENT_STRATEGY','SOLUTION_VALUE','QUOTE_PRICING','SIGN_RISK','POST_CONTRACT','LOSS_REVIEW'];

describe('P0-② 思维要素拆解 · 全部 8 销售场景', () => {
  it('buildPreContext 对全部 8 场景均返回 8 要素且列序铁律一致', () => {
    for (const sid of ALL_SCENARIOS) {
      const r = buildPreContext(sid);
      expect(r.thinking_skeleton, `场景 ${sid} 要素数`).toHaveLength(8);
      const seq = r.thinking_skeleton.map((e) => e.element);
      expect(seq, `场景 ${sid} 列序`).toEqual(EIGHT_KEYS);
    }
  });

  it('新增 7 场景均为作者化（generic=false）且绑定≥1方法论', () => {
    const authored = ALL_SCENARIOS.filter((s) => s !== 'LEAD_FOLLOW_UP');
    for (const sid of authored) {
      const t = getThinkingTemplate(sid);
      expect(t.generic, `${sid} 应非 generic`).toBe(false);
      expect(t.stage_label, `${sid} 应有 stage_label`).toBeTruthy();
      const methods = new Set(t.elements.flatMap((e) => e.methodology));
      expect(methods.size, `${sid} 应绑定≥1方法论`).toBeGreaterThan(0);
      // 每个要素字段完整
      for (const el of t.elements) {
        expect(el.guiding_question).toBeTruthy();
        expect(Array.isArray(el.prompts) && el.prompts.length > 0).toBe(true);
        expect(Array.isArray(el.ruler_keys) && el.ruler_keys.length > 0).toBe(true);
      }
    }
  });

  it('OPP_QUALIFY 绑定 MEDDICC/OPP_MATRIX/ROLE_MAP（对齐 seed methodology_ids）', () => {
    const t = getThinkingTemplate('OPP_QUALIFY');
    const methods = new Set(t.elements.flatMap((e) => e.methodology));
    expect(methods.has('MEDDICC')).toBe(true);
    expect(methods.has('OPP_MATRIX')).toBe(true);
    expect(methods.has('ROLE_MAP')).toBe(true);
  });

  it('QUOTE_PRICING/SIGN_RISK 绑定 RISK_TRADEOFF/STOP_LOSS', () => {
    for (const sid of ['QUOTE_PRICING','SIGN_RISK']) {
      const methods = new Set(getThinkingTemplate(sid).elements.flatMap((e) => e.methodology));
      expect(methods.has('RISK_TRADEOFF')).toBe(true);
      expect(methods.has('STOP_LOSS')).toBe(true);
    }
  });

  it('LOSS_REVIEW 绑定 FACT_VS_TALK/OPP_MATRIX', () => {
    const methods = new Set(getThinkingTemplate('LOSS_REVIEW').elements.flatMap((e) => e.methodology));
    expect(methods.has('FACT_VS_TALK')).toBe(true);
    expect(methods.has('OPP_MATRIX')).toBe(true);
  });
});
