// test/portal/signalLabels.test.js — 信号显示层单源守卫 + 全量产生点覆盖
//
// 背景（2026-09-17 前台可见性审计）：Plan A/B 新增的规则（contact_change / relation_cooling /
//   tender_deadline / report_due）后端已产出，但页面标签缺这几个 kind → 类型列直出英文码。
//   根因：原守门（test/web/signalCenterPage.test.js）的扫描范围**只有 alertRegistry 的 13 项**，
//   新 kind 不在守门范围内 ⇒ 测试全绿但页面仍缺标签（判据⑨同族：守卫扫描范围必须覆盖全部产生点）。
//
// 本测试的判据：把「全部产生 crm.signal 的模块」扫一遍，产出的**每一个** kind 都必须在
//   src/portal/signalLabels.js 里有中文标签。新增产生点必须同步登记进 PRODUCER_SPECS（否则守卫失效）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  SIGNAL_KIND_LABELS, kindLabel, severityLabel, statusLabel,
  summarizeSignal, scopeLabel, kindTitle,
} from '../../src/portal/signalLabels.js';

// 产生点 → 提取 kind 的正则（形态各异：JS `kind: 'x'` / emitSignal 参位 / SQL JSON `"kind":"x"`）
const PRODUCER_SPECS = [
  ['src/alerts/alertRegistry.js', /kind:\s*'([a-z0-9_]+)'/g],
  ['src/scheduler/salesDailyScan.js', /kind:\s*'([a-z0-9_]+)'/g],
  ['src/monitor/signalMetrics.js', /kind:\s*'([a-z0-9_]+)'/g],
  ['src/signal/researchScheduler.js', /kind:\s*'([a-z0-9_]+)'/g],
  ['src/signal/followupEngine.js', /kind:\s*'([a-z0-9_]+)'/g],
  // prospectScanner 走 emitSignal(store, tenant, id, kind, severity, ...) → kind 后紧跟 severity
  ['src/signal/prospectScanner.js', /'([a-z0-9_]+)',\s*'(?:high|medium|low)'/g],
  // 配置驱动的规则：kind 在播种 SQL（scheduleScanner / activityDerivation 读 rule.kind）
  ['db/migration-signal-schedule-config.sql', /"kind"\s*:\s*"([a-z0-9_]+)"/g],
  ['db/migration-signal-schedule-rules.sql', /"kind"\s*:\s*"([a-z0-9_]+)"/g],
  ['db/migration-internal-signal-derivation-config.sql', /"kind"\s*:\s*"([a-z0-9_]+)"/g],
];

function collectKinds() {
  const out = new Map(); // kind → 首见文件
  for (const [file, re] of PRODUCER_SPECS) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) if (!out.has(m[1])) out.set(m[1], file);
  }
  return out;
}

describe('signalLabels 单源守卫：全部产生点的 kind 都有中文标签', () => {
  // 扫描方法自证（判据⑬）：三种字面量形态各验一次，正则失效 → 空集 → 断言空转的假绿被挡住
  it('扫描方法自证：正则能从各形态样本中提取 kind', () => {
    expect("kind: 'deal_stuck',".match(/kind:\s*'([a-z0-9_]+)'/)?.[1]).toBe('deal_stuck');
    expect("'s0_stale', 'high'".match(/'([a-z0-9_]+)',\s*'(?:high|medium|low)'/)?.[1]).toBe('s0_stale');
    expect('{"kind":"contact_change","entity_type":"CRM_CONTACT"}'.match(/"kind"\s*:\s*"([a-z0-9_]+)"/)?.[1]).toBe('contact_change');
  });

  it('全部产生点解析出 ≥ 24 个 kind（防 PRODUCER_SPECS 路径失效致空集）', () => {
    expect(collectKinds().size).toBeGreaterThanOrEqual(24);
  });

  it('每个产生点的 kind 都有中文标签（新增 kind 未登记 → 红）', () => {
    const missing = [...collectKinds()]
      .filter(([k]) => !SIGNAL_KIND_LABELS[k])
      .map(([k, f]) => `${k}(${f})`);
    expect(missing, `缺中文标签：${missing.join(', ')}`).toEqual([]);
  });

  it('Plan A/B 四个新 kind 全部登记（回归锚点）', () => {
    for (const k of ['contact_change', 'relation_cooling', 'tender_deadline', 'report_due']) {
      expect(SIGNAL_KIND_LABELS[k], `缺 ${k}`).toBeTruthy();
    }
  });

  it('未知 kind 原样回显（不隐藏真值、不编造美化）', () => {
    expect(kindLabel('no_such_kind')).toBe('no_such_kind');
    expect(kindLabel('')).toBe('—');
  });
});

// ⚠ 断言依据「真实产出的 payload/evidence 形状」，不是臆造键名：
//   派生器 payload={subject,rule_id,confidence_basis,entity_type}、evidence={rule_id,window_days,threshold_days,updated_at}
//   扫描器 payload={subject,rule_id}、evidence={rule_id,threshold_days|schedule_kind,...}
//   ⇒ 可读量（窗口/阈值天数）只能来自 evidence，故专用摘取 evidence 而非假造 payload 字段。
describe('signalLabels 摘要可读性：新 kind 有可读句子（不回落「暂无明细」）', () => {
  it('contact_change：可读 + 窗口天数取自 evidence.window_days + 保留「内部推断」置信提示', () => {
    const s = summarizeSignal({ kind: 'contact_change', payload: {}, evidence: { window_days: 14 } });
    expect(s).not.toBe('暂无明细');
    expect(s).toContain('14');
    expect(s).toContain('内部推断'); // 低置信不得伪装为实测情报
  });

  it('relation_cooling：停滞天数取自 evidence.threshold_days', () => {
    const s = summarizeSignal({ kind: 'relation_cooling', payload: {}, evidence: { threshold_days: 30 } });
    expect(s).not.toBe('暂无明细');
    expect(s).toContain('30');
    expect(s).toContain('内部推断');
  });

  it('tender_deadline / report_due：有可读中文句子（无业务量时不造假数字）', () => {
    expect(summarizeSignal({ kind: 'tender_deadline', payload: {} })).not.toBe('暂无明细');
    expect(summarizeSignal({ kind: 'report_due', payload: {} })).not.toBe('暂无明细');
  });
});

describe('signalLabels 辅助函数契约', () => {
  it('kindTitle 保留原始码（可溯源）', () => {
    expect(kindTitle('contact_change')).toContain('contact_change');
  });
  it('severity/status 有中文且未知原样回显', () => {
    expect(severityLabel('high')).toBe('高');
    expect(statusLabel('open')).toBe('待处理');
    expect(severityLabel('weird')).toBe('weird');
  });
  it('scopeLabel 无锚点回落「全量」', () => {
    expect(scopeLabel({})).toBe('全量');
  });
});
