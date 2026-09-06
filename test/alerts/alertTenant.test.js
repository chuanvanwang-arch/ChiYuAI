// test/alerts/alertTenant.test.js — alert_rule 租户化（G3）
// 设计：docs/2026-09-05-tenant-config-full-isolation-design.md §A-4
// 语义：内存规则表按租户（tenantId → rules[]）；租户缺省继承 system 模板（_inherited 只读回退）；
//   租户显式改 → 落租户副本（不污染 system，不污染其他租户）。
// 铁律：禁 DELETE；测试隔离用 resetAlertRegistry()（内存态，非 DB）。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetAlertRegistry,
  updateAlertRule,
  listAlertRules,
  evaluateForEvent,
} from '../../src/alerts/alertRegistry.js';

describe('alertRegistry 租户化', () => {
  beforeEach(() => resetAlertRegistry());

  it('reset 后默认规则属于 system 租户（继承语义：租户缺省读到 system 模板）', () => {
    const sys = listAlertRules({ tenantId: 'system' });
    expect(sys.length).toBeGreaterThan(0);
    expect(sys.every((r) => r.tenant_id === 'system')).toBe(true);
    // 租户未显式拥有副本 → 读到 system 模板（_inherited）
    const t = listAlertRules({ tenantId: 'acme-chem' });
    expect(t.length).toBe(sys.length);
    expect(t.every((r) => r._inherited === true)).toBe(true);
  });

  it('租户更新不污染 system 与其他租户', () => {
    const r = updateAlertRule('deal_stuck', { enabled: false }, { tenantId: 'acme-chem' });
    expect(r.ok).toBe(true);
    // 租户副本已落（非继承）
    expect(listAlertRules({ tenantId: 'acme-chem' }).find((x) => x.kind === 'deal_stuck').enabled).toBe(false);
    expect(listAlertRules({ tenantId: 'acme-chem' }).find((x) => x.kind === 'deal_stuck')._inherited).toBeUndefined();
    // system 不变
    expect(listAlertRules({ tenantId: 'system' }).find((x) => x.kind === 'deal_stuck').enabled).toBe(true);
    // 其他租户仍继承 system 模板
    expect(listAlertRules({ tenantId: 'acme-training' }).find((x) => x.kind === 'deal_stuck').enabled).toBe(true);
    expect(listAlertRules({ tenantId: 'acme-training' }).find((x) => x.kind === 'deal_stuck')._inherited).toBe(true);
  });

  it('evaluateForEvent 按租户规则判定（租户关闭的规则不再命中）', () => {
    updateAlertRule('deal_stuck', { enabled: false }, { tenantId: 'acme-chem' });
    // deal_stuck 需 metric.stuckDays ≥ 30（check_params.stuck_days）才命中
    const event = { particleType: 'CRM_DEAL', action: 'advance', metric: { stuckDays: 45 } };
    const sysHits = evaluateForEvent(event, { tenantId: 'system' });
    const tHits = evaluateForEvent(event, { tenantId: 'acme-chem' });
    expect(sysHits.some((h) => h.rule.kind === 'deal_stuck')).toBe(true);
    expect(tHits.some((h) => h.rule.kind === 'deal_stuck')).toBe(false);
  });

  it('租户显式改 check_params → 其他租户阈值不变（深拷贝隔离）', () => {
    updateAlertRule('deal_stuck', { check_params: { stuck_days: 999 } }, { tenantId: 'acme-chem' });
    const t = listAlertRules({ tenantId: 'acme-chem' }).find((x) => x.kind === 'deal_stuck');
    expect(t.check_params.stuck_days).toBe(999);
    const sys = listAlertRules({ tenantId: 'system' }).find((x) => x.kind === 'deal_stuck');
    expect(sys.check_params.stuck_days).toBe(30);
    const other = listAlertRules({ tenantId: 'acme-training' }).find((x) => x.kind === 'deal_stuck');
    expect(other.check_params.stuck_days).toBe(30); // 继承 system 模板，不受租户改动影响
  });
});
