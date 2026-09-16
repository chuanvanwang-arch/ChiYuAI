// test/advice-tier-axis.test.js
// E2（2026-09-16）跨轴一致性守卫：仓库里同时存在**两套 A/B/C**，且**方向相反**——
//   ①【建议档】decision/adviceCard.js 的 tier（轴 ADVICE_MATURITY）：A=证据齐备可放手，**C=证据不足禁止处置**
//   ②【项目分级"取值"】crm.business_tier_config dimension='project' 的 dimension_value（业务分类）：
//       A→HIGH（最高风险）、B→NORMAL、**C→LEAD（最低风险，可自治）**
//   另有 ③【自主分级】= tier 列 LEAD/NORMAL/HIGH（自主边界，businessTierRender.VALID_TIERS）。
//
// 为什么必须守卫：两轴的字母**同名而语义相反**，任何"按字面同值搬运"的代码都会静默反转安全方向——
//   典型错误是历史实现 `business_tier: advice.tier === 'B' ? 'HIGH' : 'NORMAL'`：
//   它把**建议档 C（证据不足、只补信息）投影成 NORMAL（可自主放行）**，恰好把最不该自主的一档标成可自主。
//   这类错误不会报错、不会破任何正向用例，只会在真正接线时把"禁止处置"变成"允许自治"。
//   （范式同 test/tier-predicate-parity.test.js：源码级 + 语义级断言，零运行成本，改漏立刻红。）
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ADVICE_TIER_AXIS, ADVICE_TIERS, buildAdviceCard } from '../src/decision/adviceCard.js';
import { buildAdviceRecord } from '../src/decision/adviceRecord.js';
import { VALID_TIERS } from '../src/portal/businessTierRender.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// ---------- ① 两轴枚举互不相交（机械证明"按字面映射"必错） ----------

test('E2: 建议档与自主分级是两套不相交的枚举（故不可互相按字面搬运）', () => {
  expect(ADVICE_TIER_AXIS).toBe('ADVICE_MATURITY');
  expect([...ADVICE_TIERS]).toEqual(['A', 'B', 'C']);
  expect([...VALID_TIERS]).toEqual(['LEAD', 'NORMAL', 'HIGH']);
  // 交集为空 → 任何 advice.tier === X ? 'HIGH' : 'NORMAL' 式的字面对照都缺少依据
  const overlap = ADVICE_TIERS.filter((t) => VALID_TIERS.includes(t));
  expect(overlap, '两轴枚举出现交集，说明有一侧取错了轴').toEqual([]);
});

// ---------- ② 建议档 C 的语义：禁止处置（不是"可放手"） ----------

test('E2: 建议档 C = 证据不足 → disposition 为空且不给处置（禁止自治）', () => {
  // 证据充分度低于及格线 → C 档
  const card = buildAdviceCard({
    scenario: { scenario_id: 'OPP_QUALIFY', rubric_pass_line: 0.6, default_tier: 'NORMAL', eval_dimensions: [{ cond: 'budget', weight: 1, required: false }] },
    coordinate: { scenario_id: 'OPP_QUALIFY', stage: 'S2', confidence: 'high' },
    facts: {}, // budget 缺失 → coverage 0 < 0.6
  });
  expect(card.tier).toBe('C');
  expect(card.disposition, 'C 档不得给出处置（只补信息）').toBe(null);
  expect(card.gaps.length).toBeGreaterThan(0);
});

test('E2: 建议档 A = 证据齐备且场景非 HIGH 级 → APPROVE（唯一可放手的一档）', () => {
  const card = buildAdviceCard({
    scenario: { scenario_id: 'OPP_QUALIFY', rubric_pass_line: 0.6, default_tier: 'NORMAL', eval_dimensions: [{ cond: 'budget', weight: 1, required: false }] },
    coordinate: { scenario_id: 'OPP_QUALIFY', stage: 'S2', confidence: 'high' },
    facts: { budget: 100 },
  });
  expect(card.tier).toBe('A');
  expect(card.disposition).toBe('APPROVE');
});

// ---------- ③ E3 结构消除：建议记录不含业务分级字段（投影面已消失） ----------

const recOf = (tier) => buildAdviceRecord(
  { tier, scenario_id: 'OPP_QUALIFY', stage: 'S2', coverage: 0.8 },
  { tenantId: 'system' }
);

test('E3: 建议记录不含业务分级字段（不是"投影转换"，而是投影无处可写）', () => {
  const rec = recOf('C');
  const keys = Object.keys(rec);
  expect(keys, '出现裸 tier 列名：轴必须显式带前缀 advice_').not.toContain('tier');
  expect(keys, '建议记录混入业务分级字段 —— 跨轴语义反转的土壤').not.toContain('business_tier');
  expect(keys).not.toContain('autonomy_level');
  // 源码级：adviceRecord.js 与建表 DDL 均不得出现业务分级列（**只看代码行**，解释性注释不算）
  const codeOnly = (txt) => txt.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
  expect(codeOnly(read('../src/decision/adviceRecord.js'))).not.toMatch(/business_tier/);
  const ddl = read('../db/schema.sql');
  const at = ddl.indexOf('CREATE TABLE IF NOT EXISTS crm.advice_record');
  const block = codeOnly(ddl.slice(at, ddl.indexOf(');', at)));
  expect(block, 'advice_record 表混入业务分级列').not.toMatch(/business_tier/);
});

test('E3: 建议档按轴原名落库 —— C 档落库必须仍是 C（关键负向哨兵，防跨轴改写）', () => {
  for (const t of ['A', 'B', 'C']) {
    expect(recOf(t).advice_tier, `建议档 ${t} 被跨轴改写`).toBe(t);
  }
  // 反向：记录里不得出现 LEAD/NORMAL/HIGH 任一自主分级值
  const blob = JSON.stringify(['A', 'B', 'C'].map(recOf));
  for (const v of ['LEAD', 'NORMAL', 'HIGH']) {
    expect(blob, `建议记录出现自主分级值 ${v}：两轴混用`).not.toContain(v);
  }
});

// ---------- ④ 源码级守卫：禁止"按字面同值映射"回潮 ----------

test('E3: 旧路线（business_tier 字面映射 / crm.decision + ADVISED）不得回潮', () => {
  const txt = read('../src/decision/adviceStore.js');
  // 只断言**代码行**（行首空白 + business_tier:），注释中的历史记录不误伤
  const badCode = /^\s*business_tier:\s*advice\.tier\s*===\s*'(B|C)'\s*\?/m;
  expect(txt, '出现按字面映射的 business_tier 赋值：这正是把 C 档（禁止处置）错标为可自主的成因').not.toMatch(badCode);
  expect(txt, '退役记录缺失：应显式说明旧路线被否决').toMatch(/退役/);
  expect(txt, '退役记录缺失：应指明新载体为 advice_record').toContain('advice_record');
  expect(read('../src/decision/adviceRecord.js'), 'adviceRecord 缺 E3 设计裁决说明').toContain('不落 crm.decision');
});

test('E2: 两轴方向相反须在源码中显式声明（防止下一位读者误判）', () => {
  expect(read('../src/decision/adviceCard.js'), 'adviceCard 缺少轴声明').toContain('ADVICE_MATURITY');
  expect(read('../src/decision/adviceCard.js'), 'adviceCard 未点明两轴方向相反').toContain('方向相反');
  expect(read('../src/portal/businessTierRender.js'), 'businessTierRender 缺少术语边界声明').toContain('术语边界');
  expect(read('../src/pages/S23.schema.js'), 'S23 schema 缺少术语边界声明').toContain('术语边界');
});
