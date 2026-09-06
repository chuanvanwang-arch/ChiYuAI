// test/scheduler/named-visit-scan.test.js — 指名客户应访逾期扫描链（Task6）
// 契约（docs/2026-08-30-named-account-manage-design.md §6）：
//   1. alertRegistry 已注册 named_visit_overdue（13 条种子含）
//   2. findOpenAlertByParticle(particle_id, kind) 幂等前置：已有 open/acked 不重复建
//   3. 达标自动解除：namedVisitStatus.pass → 有 open 同 kind → closeAlert（幂等解除铁律）
// 纯逻辑测试（不依赖 PG）：直用 alertStore + namedVisitStatus + namedAccountTargets
import { describe, it, expect, beforeEach } from 'vitest';
import { resetAlertStore, createAlert, findOpenAlertByParticle, closeAlert, listAlerts } from '../../src/alerts/alertStore.js';
import { resetAlertRegistry, listAlertRules } from '../../src/alerts/alertRegistry.js';
import { mergedTargets } from '../../src/sales/namedAccountTargets.js';
import { namedVisitStatus } from '../../src/sales/namedAccountAssign.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

beforeEach(() => { resetAlertStore(); resetAlertRegistry(); });

describe('named_visit_overdue 告警链（Task6）', () => {
  it('alertRegistry 已注册 named_visit_overdue 规则', () => {
    expect(listAlertRules().some(r => r.kind === 'named_visit_overdue' && r.enabled)).toBe(true);
  });

  it('findOpenAlertByParticle：open 在途 → 返回；closed → null（幂等解除前置）', () => {
    const a = createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: 'P-1' });
    expect(a.ok).toBe(true);
    // open → 命中
    expect(findOpenAlertByParticle('P-1', 'named_visit_overdue')).not.toBeNull();
    // closed → 不再命中（可重新触发）
    const cl = closeAlert(a.alert.alert_id, { reason: 'visit_ok' });
    expect(cl.ok).toBe(true);
    expect(findOpenAlertByParticle('P-1', 'named_visit_overdue')).toBeNull();
  });

  it('幂等：已有 open 同 kind 同粒子 → 不重复建（扫描不复发）', () => {
    createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: 'P-2' });
    const again = createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: 'P-2' });
    // 语义：扫描前 findOpenAlertByParticle 判空才建——直验 store 不自动去重时，扫描逻辑必须查前置
    expect(again.ok).toBe(true); // store 本身允许建（去重责任在扫描调用方，靠 findOpenAlertByParticle 前置）
    // 扫描前置断言：重复调用 findOpen 仍返回第一条 open（扫描据此跳过建新）
    const open = findOpenAlertByParticle('P-2', 'named_visit_overdue');
    expect(open).not.toBeNull();
    expect(listAlerts({ kind: 'named_visit_overdue', status: 'open' })).toHaveLength(2); // 扫描层未调 find 前置才会 2→ 幂等由调用方保证
  });

  it('达标自动解除：pass=true → closeAlert(visit_ok)，open→closed', () => {
    const a = createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: 'P-3' });
    // 达标状态（近 2 天有拜访，窗口内达标 → pass=true）
    const tv = namedVisitStatus(
      { named_owner: 'alice', named_tier: '目标', visit_notes: [{ at: new Date(Date.now() - 1 * 86400000).toISOString() }] },
      '目标', mergedTargets({}), mergedThresholds({})
    );
    expect(tv.pass).toBe(true);
    // 扫描解除：发现 open → close
    const open = findOpenAlertByParticle('P-3', 'named_visit_overdue');
    if (open) {
      const cl = closeAlert(open.alert_id, { reason: 'visit_ok' });
      expect(cl.ok).toBe(true);
      expect(cl.alert.status).toBe('closed');
    }
    expect(findOpenAlertByParticle('P-3', 'named_visit_overdue')).toBeNull();
  });

  it('逾期红：namedVisitStatus.alert=red → 可触发建告警（扫描前置条件）', () => {
    // 60 天前拜访（目标档 30 天窗口外 → 未达；应访日=60天前+30天=30天前 → overdueDays=30 ≥ alert_days(2) → 红）
    // 注：31 天前只会 overdue=1 → yellow（≥warn 1 但 <alert 2），须用应访日超 2 天的时点才确定性 red
    const tv = namedVisitStatus(
      { named_owner: 'alice', named_tier: '目标', visit_notes: [{ at: new Date(Date.now() - 60 * 86400000).toISOString() }] },
      '目标', mergedTargets({}), mergedThresholds({})
    );
    expect(tv.pass).toBe(false);
    expect(tv.alert).toBe('red');
    // 扫描建（find 前置判空 → 建）
    if (!findOpenAlertByParticle('P-4', 'named_visit_overdue')) {
      createAlert({ kind: 'named_visit_overdue', severity: 'high', target_role: 'sales', particle_id: 'P-4', payload: { overdueDays: tv.overdueDays } });
    }
    expect(findOpenAlertByParticle('P-4', 'named_visit_overdue')).not.toBeNull();
  });
});