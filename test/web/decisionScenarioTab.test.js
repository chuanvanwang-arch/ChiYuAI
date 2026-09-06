import { test, expect } from 'vitest';
import {
  renderScenarioTabs,
  renderStageCards,
  cardHtmlSimple,
  SALES_STAGE_ORDER,
  ALL_RULERS,
} from '../../src/portal/decisionScenarioRender.js';

// 8 销售场景（stage 一→八）+ 2 个非销售（meta / TRACE，不进销售视角）
const SCENARIOS = [
  { scenario_id: 'LEAD_FOLLOW_UP', stage: '一、线索', description: '新线索跟不跟', default_tier: 'LEAD', autonomous_allowed: true,
    methodology_ids: ['BANT'], eval_dimensions: [], dispositions: ['APPROVE', 'REJECT'], focus_rulers: ['clarity', 'relevance'], enabled_rulers: [], rubric_pass_line: 0.5 },
  { scenario_id: 'OPP_QUALIFY', stage: '二、机会评估', description: '真机会/伪需求', default_tier: 'NORMAL', autonomous_allowed: false,
    methodology_ids: ['MEDDICC'], eval_dimensions: [], dispositions: ['APPROVE', 'ESCALATE'], focus_rulers: ['relevance'], enabled_rulers: ['accuracy', 'relevance', 'depth'], rubric_pass_line: 0.6 },
  { scenario_id: 'ATTR_SCHEMA_CHANGE', stage: 'meta', description: '元模型变更', default_tier: 'HIGH', autonomous_allowed: false,
    methodology_ids: [], eval_dimensions: [], dispositions: ['APPROVE'], focus_rulers: [], enabled_rulers: [], rubric_pass_line: null },
  { scenario_id: 'TRACE_DBG_SCEN', stage: 'TRACE', description: '调试', default_tier: 'NORMAL', autonomous_allowed: false,
    methodology_ids: [], eval_dimensions: [], dispositions: ['APPROVE'], focus_rulers: [], enabled_rulers: [], rubric_pass_line: null },
];

test('SALES_STAGE_ORDER 含 8 销售 stage（一→八 自然序）', () => {
  expect(SALES_STAGE_ORDER).toEqual([
    '一、线索', '二、机会评估', '三、客户策略', '四、方案价值',
    '五、商务报价', '六、签单前风险', '七、终局决策', '八、丢单复盘',
  ]);
});

test('ALL_RULERS 含 9 尺子', () => {
  expect(ALL_RULERS).toEqual(['clarity', 'relevance', 'logic', 'depth', 'breadth', 'precision', 'importance', 'originality', 'fairness']);
});

test('renderScenarioTabs 只列 8 销售 stage + 标记 active（不含 meta/TRACE）', () => {
  const html = renderScenarioTabs(SCENARIOS, '一、线索');
  expect(html).toContain('data-stage="一、线索"');
  expect(html).toContain('data-stage="二、机会评估"');
  expect(html).toContain('class="ds-tab active"'); // active 标记
  expect(html).not.toContain('data-stage="meta"');
  expect(html).not.toContain('data-stage="TRACE"');
  // 恰好 2 个销售 stage（本样本只有一、二）；用 <button 前缀避免误匹配容器 div.ds-tabs
  expect((html.match(/<button class="ds-tab/g) || []).length).toBe(2);
});

test('renderScenarioTabs 无销售场景 → 返回空串', () => {
  expect(renderScenarioTabs([SCENARIOS[2], SCENARIOS[3]], 'meta')).toBe('');
});

test('renderStageCards 只渲染当前 stage 的卡（不混入其他 stage）', () => {
  const html = renderStageCards(SCENARIOS, '一、线索');
  expect(html).toContain('data-id="LEAD_FOLLOW_UP"');
  expect(html).not.toContain('data-id="OPP_QUALIFY"');
  expect(html).not.toContain('data-id="ATTR_SCHEMA_CHANGE"');
});

test('cardHtmlSimple 精简四要素：聚焦/启用/及格/描述', () => {
  const html = cardHtmlSimple(SCENARIOS[1]); // OPP_QUALIFY：enabled 子集
  expect(html).toContain('聚焦');
  expect(html).toContain('启用');
  expect(html).toContain('及格');
  expect(html).toContain('0.60'); // pass_line
  expect(html).toContain('diff-dot'); // 子集→橘点
  expect(html).toContain('3 尺子（子集）');
});

test('cardHtmlSimple enabled 全空 → 显示「全 9 尺子」灰字（无 diff-dot）', () => {
  const html = cardHtmlSimple(SCENARIOS[0]); // LEAD_FOLLOW_UP：enabled=[]
  expect(html).toContain('全 9 尺子');
  expect(html).not.toContain('diff-dot');
});

test('renderStageCards diffOnly=true 仅显示差异化场景（enabled 子集）', () => {
  // 一、线索 只有 LEAD_FOLLOW_UP（enabled 空）→ 差异化 0 个
  expect(renderStageCards(SCENARIOS, '一、线索', { diffOnly: true })).toContain('暂无差异化场景');
  // 二、机会评估 有 OPP_QUALIFY（enabled 子集）→ 显示
  const html = renderStageCards(SCENARIOS, '二、机会评估', { diffOnly: true });
  expect(html).toContain('data-id="OPP_QUALIFY"');
  expect(html).not.toContain('暂无差异化');
});

test('cardHtmlSimple 描述超长 → 截断 40 字', () => {
  const long = { ...SCENARIOS[0], description: 'x'.repeat(80) };
  expect(cardHtmlSimple(long)).toContain('x'.repeat(40));
  expect(cardHtmlSimple(long)).not.toContain('x'.repeat(41));
});
