// test/page/renderer.test.js — Task 2: renderer 四态注入 + navigation.to 校验 + attr-field 四查徽标
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 2 + 蓝图 §2.5.1 渲染期四查
// 兼容铁律：validatePageSchema 既有契约返回 {ok:false, errors[]}（不 throw）；attr-field 既有 attrSlug 形态不变，
//           四查徽标仅在 comp.attr 数据对象提供时启用（业务详情面 S06/S07/... 使用）。
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';
import { validatePageSchema } from '../../src/page/validator.js';

describe('Task2 · navigation.to 校验（对齐既有契约返回 ok:false）', () => {
  it('navigation.to 不在 CANONICAL_NAV → 拒绝', () => {
    const bad = { type: 'detail', title: 'x', navigation: { to: '/nope' }, layout: { columns: 1, theme: 'light' }, components: [] };
    const v = validatePageSchema(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('navigation.to 非法'))).toBe(true);
  });

  it('业务详情路径 /accounts/:id 属于权威导航', () => {
    const ok = { type: 'detail', title: '客户360', navigation: { to: '/accounts/:id' }, layout: { columns: 2, theme: 'light' },
      components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }] };
    const v = validatePageSchema(ok);
    expect(v.ok).toBe(true);
  });
});

describe('Task2 · 四态注入（partial/empty/loading/error）', () => {
  const base = { type: 'dashboard', title: '看板', navigation: { to: '/dashboard' }, layout: { columns: 1, theme: 'light' },
    components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }] };

  it('loading → 状态块', () => {
    const { html } = renderPage(base, { state: 'loading' });
    expect(html).toContain('data-state="loading"');
  });

  it('error → 状态块 + reason', () => {
    const { html } = renderPage(base, { state: 'error', reason: 'PG 不可达' });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('PG 不可达');
  });

  it('empty → 状态块（无组件渲染）', () => {
    const { html } = renderPage(base, { state: 'empty' });
    expect(html).toContain('data-state="empty"');
  });

  it('partial → 组件渲染（数据部分可用）', () => {
    const { html } = renderPage(base, { state: 'partial', components: { 'metric-card': { value: 123 } } });
    expect(html).toContain('pg-metric-card');
    expect(html).toContain('123');
  });
});

describe('Task2 · attr-field 四查徽标（渲染期四查，蓝图 §2.5.1）', () => {
  const base = (attrComp) => ({ type: 'detail', title: '详情', navigation: { to: '/accounts/:id' }, layout: { columns: 1, theme: 'light' }, components: [attrComp] });

  it('数据来源已知（data_origin=external + 置信度）→ data-origin-external 徽标', () => {
    const s = base({ kind: 'attr-field', attrSlug: 'industry', attrType: 'text', label: '行业', attr: { slug: 'industry', data_origin: 'external', sourcedFrom: { relation_confidence: 0.8 } } });
    const { html } = renderPage(s, { state: 'partial' });
    expect(html).toContain('data-origin-external');
    expect(html).toContain('0.8');
  });

  it('④ 外部采集（data_origin=external）→ input disabled 且显待接入提示（T3 修复：不可手填）', () => {
    const s = base({ kind: 'attr-field', attrSlug: 'industry', attrType: 'text', label: '行业', attr: { slug: 'industry', data_origin: 'external', sourcedFrom: { relation_confidence: 0.92 } } });
    const { html } = renderPage(s, { state: 'partial' });
    expect(html).toContain('data-origin-external');
    expect(html).toContain('disabled');
    expect(html).toContain('待外部源接入');
  });

  it('AI 来源（data_origin=ai + 置信度<0.6）→ needsReview 标记', () => {
    const s = base({ kind: 'attr-field', attrSlug: 'score', attrType: 'number', label: '健康度', attr: { slug: 'score', data_origin: 'ai', ai: { confidence: 0.4 } } });
    const { html } = renderPage(s, { state: 'partial' });
    expect(html).toContain('data-origin-ai');
    expect(html).toContain('needsReview');
  });

  it('孤儿字段（data_origin 未声明）→ unverified + 控件 disabled', () => {
    const s = base({ kind: 'attr-field', attrSlug: 'note', attrType: 'text', label: '备注', attr: { slug: 'note', data_origin: null } });
    const { html } = renderPage(s, { state: 'partial' });
    expect(html).toContain('unverified');
    expect(html).toContain('disabled');
  });

  it('③ 规则派生（data_origin=rule）→ data-origin-rule 只读徽标', () => {
    const s = base({ kind: 'attr-field', attrSlug: 'stage_changed_at', attrType: 'timestamp', label: '阶段变更', attr: { slug: 'stage_changed_at', data_origin: 'rule' } });
    const { html } = renderPage(s, { state: 'partial' });
    expect(html).toContain('data-origin-rule');
  });

  it('旧 attrSlug 形态（无 attr 数据对象）→ 无四查徽标，保持兼容', () => {
    const s = base({ kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '名称' });
    const { html } = renderPage(s, { state: 'partial' });
    expect(html).toContain('data-attr="name"');
    expect(html).not.toContain('data-origin-');
    expect(html).not.toContain('unverified');
  });
});

describe('Task1 · collapse 折叠容器 dispatch（决策2）', () => {
  it('kind=collapse → 渲染 details.pg-collapse（内部 table 递归）', () => {
    const s = { type: 'detail', title: 'x', navigation: { to: '/accounts/:id' }, layout: { columns: 1, theme: 'light' },
      components: [{ kind: 'collapse', title: '明细段', open: false, components: [{ kind: 'table', title: 't', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }] }] };
    const { html } = renderPage(s, { state: 'partial', components: { table: { rows: [{ a: '1' }] } } });
    expect(html).toContain('pg-collapse');
    expect(html).toContain('pg-table');
  });
});

describe('rowActions 行内操作按钮（待我审批 批准/拒绝）', () => {
  const baseSchema = (dataBinding) => ({ type: 'workspace', title: 'x', navigation: { to: '/my-todo' }, layout: { columns: 1, theme: 'light' },
    components: [{ kind: 'table', title: '待我审批', dataBinding }] });

  it('声明 rowActions → 每行渲染 data-action 按钮 + 确认文案 + data-row-id', () => {
    const s = baseSchema({ source: 'particle', particleType: 'CRM_APPROVAL_TASK', filters: [], metrics: [],
      rowActions: [
        { action: 'crm-approval-approve', label: '批准', confirm: '确认批准该审批任务？' },
        { action: 'crm-approval-reject', label: '拒绝' },
      ] });
    const { html, warnings } = renderPage(s, { state: 'partial', components: { table: { rows: [{ id: 'at-1', title: '报价审批' }] } } });
    expect(warnings || []).toEqual([]);
    expect(html).toContain('data-action="crm-approval-approve"');
    expect(html).toContain('data-action="crm-approval-reject"');
    expect(html).toContain('data-row-id="at-1"');
    expect(html).toContain('data-confirm="确认批准该审批任务？"');
    expect(html).toContain('<th>操作</th>');
  });

  it('无 rowActions → 不渲染操作列（既有表格形态不变）', () => {
    const s = baseSchema({ source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] });
    const { html } = renderPage(s, { state: 'partial', components: { table: { rows: [{ id: 'd-1', title: '商机' }] } } });
    expect(html).not.toContain('<th>操作</th>');
    expect(html).not.toContain('data-row-id');
  });

  it('空行 + rowActions → 保持空态占位，不渲染按钮', () => {
    const s = baseSchema({ source: 'particle', particleType: 'CRM_APPROVAL_TASK', filters: [], metrics: [],
      rowActions: [{ action: 'crm-approval-approve', label: '批准' }] });
    const { html } = renderPage(s, { state: 'partial', components: { table: { rows: [] } } });
    expect(html).toContain('data-state="empty"');
    expect(html).not.toContain('data-row-id');
  });
});