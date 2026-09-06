// test/context/injector.test.js — T1(BG-01a) 注入层消费 rationale/memories
//   + T8(BG-01b) 叙事时间线（J7 WHEN 轴）进注入层
// 验证：formatForPrompt 不再只吐标签列表，而消费 assembler 已装配的叙事字段；截断预算生效。
import { describe, it, expect } from 'vitest';
import { formatForPrompt } from '../../src/context/injector.js';
import { buildTimelineRows } from '../../src/context/timelineSource.js';

const baseBundle = (over = {}) => ({
  layers: {
    L1: [{ title: 'ACC-A 客户' }],
    L2: { decisions: [], memories: [] },
    L3: { tasks: [] },
    L4: { profile: { role_subtype: '销售', core_focus: '推进' } },
  },
  degraded: false,
  missing: {},
  scopeModel: 'all',
  ...over,
});

describe('T1 formatForPrompt 消费叙事字段', () => {
  it('历史决策带 rationale 时注入「— <rationale>」', () => {
    const b = baseBundle({ layers: { ...baseBundle().layers, L2: { decisions: [{ scenario_id: 'OPP_QUALIFY', disposition: 'PROCEED', rationale: '客户预算已批，竞争弱' }], memories: [] } } });
    const out = formatForPrompt(b);
    expect(out).toContain('OPP_QUALIFY:PROCEED — 客户预算已批，竞争弱');
  });

  it('无 rationale 时仅 base（scenario_id:disposition），不报错', () => {
    const b = baseBundle({ layers: { ...baseBundle().layers, L2: { decisions: [{ scenario_id: 'OPP_QUALIFY', disposition: 'PROCEED' }], memories: [] } } });
    const out = formatForPrompt(b);
    expect(out).toContain('OPP_QUALIFY:PROCEED');
    expect(out).not.toContain('—');
  });

  it('超长 rationale 被截断到预算内（≤120 字 + 省略号）', () => {
    const long = 'x'.repeat(300);
    const b = baseBundle({ layers: { ...baseBundle().layers, L2: { decisions: [{ scenario_id: 'S', disposition: 'D', rationale: long }], memories: [] } } });
    const out = formatForPrompt(b);
    const seg = out.split('— ')[1];
    expect(seg.endsWith('…')).toBe(true);
    expect(seg.length).toBeLessThanOrEqual(121);
  });

  it('消费 memories（payload.text/summary 均可），最多 3 条且截断', () => {
    const mems = [
      { payload: { text: '上次拜访客户提及扩容计划' } },
      { payload: { summary: '竞品报价偏高' } },
      { payload: { note: '决策人偏向稳健方案' } },
      { payload: { text: '第四条应被截断不注入' } },
    ];
    const b = baseBundle({ layers: { ...baseBundle().layers, L2: { decisions: [], memories: mems } } });
    const out = formatForPrompt(b);
    expect(out).toContain('关联记忆(3)');
    expect(out).toContain('上次拜访客户提及扩容计划');
    expect(out).toContain('竞品报价偏高');
    expect(out).toContain('决策人偏向稳健方案');
    expect(out).not.toContain('第四条应被截断不注入');
  });

  it('无 L2 时不输出历史决策/关联记忆块', () => {
    const b = baseBundle({ layers: { ...baseBundle().layers, L2: { decisions: [], memories: [] } } });
    const out = formatForPrompt(b);
    expect(out).not.toContain('历史决策');
    expect(out).not.toContain('关联记忆');
  });

  it('记忆 payload 为字符串时也可提取', () => {
    const b = baseBundle({ layers: { ...baseBundle().layers, L2: { decisions: [], memories: [{ payload: '纯文本记忆一条' }] } } });
    expect(formatForPrompt(b)).toContain('纯文本记忆一条');
  });
});

// ─── T8(BG-01b)：J7 决策七轴之 WHEN 轴 —— 叙事时间线进注入层 ───
const mkSrc = (ts, type, id, title) => ({ ts, type, title, source: type, actor: 'alice', entityType: 'X', entityId: id, summary: '' });
const narrativeOf = (srcs) => {
  const rows = buildTimelineRows(srcs);
  return { rows, available: rows.length > 0, unavailable_reason: rows.length ? null : 'empty', source: 'events/tasks/decision/memory_log' };
};

describe('T8 formatForPrompt 注入叙事时间线（WHEN 轴）', () => {
  it('有叙事时间线时输出 WHEN 块，且按正序（最早→最近）呈现', () => {
    const n = narrativeOf([
      mkSrc('2026-01-01T09:00:00Z', 'event', 'e1', '初次接触'),
      mkSrc('2026-02-01T09:00:00Z', 'task', 't1', '方案跟进'),
      mkSrc('2026-03-01T09:00:00Z', 'decision', 'd1', '阶段推进'),
    ]);
    const out = formatForPrompt(baseBundle({ narrative: n }));
    expect(out).toContain('叙事时间线(WHEN');
    const idxEarly = out.indexOf('初次接触');
    const idxMid = out.indexOf('方案跟进');
    const idxLate = out.indexOf('阶段推进');
    expect(idxEarly).toBeLessThan(idxMid);
    expect(idxMid).toBeLessThan(idxLate);
  });

  it('超过 8 条时仅注入最近 8 条并标注总数', () => {
    const srcs = Array.from({ length: 12 }, (_, i) =>
      mkSrc(`2026-01-${String(i + 1).padStart(2, '0')}T09:00:00Z`, 'event', `e${i}`, `事件${i}`));
    const out = formatForPrompt(baseBundle({ narrative: narrativeOf(srcs) }));
    expect(out).toContain('共12条');
    expect(out).toContain('仅列最近8条');
    expect(out).not.toContain('事件0'); // 最早的被裁掉
    expect(out).toContain('事件11');   // 最近的保留
  });

  it('narrative 不可用（available=false）时不输出 WHEN 块', () => {
    const out = formatForPrompt(baseBundle({ narrative: { rows: [], available: false, unavailable_reason: 'no-scope' } }));
    expect(out).not.toContain('叙事时间线');
  });

  it('bundle 无 narrative 字段（旧调用方）时不报错、不输出 WHEN 块', () => {
    const b = baseBundle();
    delete b.narrative;
    expect(() => formatForPrompt(b)).not.toThrow();
    expect(formatForPrompt(b)).not.toContain('叙事时间线');
  });

  it('单行渲染为「时间 来源｜执行者｜事件」，可追溯到实体', () => {
    const n = narrativeOf([mkSrc('2026-03-01T09:00:00Z', 'decision', 'd1', '阶段推进')]);
    const out = formatForPrompt(baseBundle({ narrative: n }));
    expect(out).toMatch(/2026-03-01 09:00/);
    expect(out).toContain('decision｜alice｜阶段推进');
  });
});
