// test/portal/follow-reminder.test.js — 客户跟踪告警复用渲染纯函数（浏览器 + vitest 共用，零 DB）
// 复用范式：alertRuleConfigRender.test.js（纯函数单测，import 自 src/portal/*）
import { describe, it, expect } from 'vitest';
import { renderFollowKpis, renderFollowTable } from '../../src/portal/followReminder.js';

const row = (over) => ({
  id: 'a1', name: '客户甲', owner: 'alice', tier: '重点',
  alert: over ? 'red' : null, overdueDays: over ? 12 : 0,
  visitDue: '2026-08-01', visitTarget: 2, visits30: 0,
  lostContact: !over, lastContactDays: !over ? 95 : null,
});

describe('renderFollowKpis', () => {
  it('应访未访>0 时红卡 + 跳指名客户管理', () => {
    const html = renderFollowKpis({ rows: [row(true)], lostContactCount: 0 });
    expect(html).toContain('应访未访');
    expect(html).toContain('class="fkpi warn"');
    expect(html).toContain('href="/named-account-manage.html"');
  });
  it('失联>0 时橙卡计数', () => {
    const html = renderFollowKpis({ rows: [row(false)], lostContactCount: 1 });
    expect(html).toContain('长期失联');
    expect(html).toContain('>1<');
  });
  it('最近逾期 = 多红取 max(overdueDays)', () => {
    const html = renderFollowKpis({ rows: [row(true), { ...row(true), overdueDays: 30 }], lostContactCount: 0 });
    expect(html).toContain('30 天');
  });
  it('查看完整卡恒存在并跳 named-accounts', () => {
    const html = renderFollowKpis({ rows: [], lostContactCount: 0 });
    expect(html).toContain('查看完整');
    expect(html).toContain('href="/named-accounts.html"');
  });
  it('零数据退化为达标灰（无 warn 类）', () => {
    const html = renderFollowKpis({ rows: [], lostContactCount: 0 });
    expect(html).not.toContain('class="fkpi warn"');
  });
});

describe('renderFollowTable', () => {
  it('两类子表 + 去重（既红又失联只进红）', () => {
    const both = { id: 'x', name: '双告警', owner: 'alice', tier: '重点', alert: 'red', overdueDays: 5, visitDue: '2026-08-01', visitTarget: 2, visits30: 0, lostContact: true, lastContactDays: 99 };
    const html = renderFollowTable([both, row(false)]);
    expect(html).toContain('🔴 应访未访');
    expect(html).toContain('🟠 长期失联');
    // 双告警客户（红+失联）只出现一次（在红表，不在失联表）
    expect((html.match(/双告警/g) || []).length).toBe(1);
    // 纯失联客户出现一次
    expect((html.match(/客户甲/g) || []).length).toBe(1);
  });
  it('零告警返回空态', () => {
    expect(renderFollowTable([])).toContain('暂无逾期');
  });
  it('HTML 转义客户名', () => {
    const html = renderFollowTable([{ id: 'x', name: '<b>evil</b>', owner: 'a', alert: 'red', overdueDays: 1 }]);
    expect(html).not.toContain('<b>evil</b>');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });
});
