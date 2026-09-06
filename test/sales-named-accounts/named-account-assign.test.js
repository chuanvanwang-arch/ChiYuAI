// test/sales-named-accounts/named-account-assign.test.js — 指名客户分配派生 + 告警状态纯函数
// 契约：namedOwnerOf/namedStateOf/visitDueAt/namedVisitStatus（src/sales/namedAccountAssign.js）
import { describe, it, expect } from 'vitest';
import { mergedTargets } from '../../src/sales/namedAccountTargets.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';
import {
  namedOwnerOf, namedStateOf, namedTierOf, visitDueAt, namedVisitStatus,
} from '../../src/sales/namedAccountAssign.js';

const cfg = mergedTargets({});
const thr = mergedThresholds({});

describe('namedAccountAssign 分配派生', () => {
  it('named_owner 优先，回退 owner_id/owner（向后兼容）', () => {
    expect(namedOwnerOf({ named_owner: 'alice', owner_id: 'bob', owner: 'carol' })).toBe('alice');
    expect(namedOwnerOf({ owner_id: 'bob' })).toBe('bob');
    expect(namedOwnerOf({ owner: 'carol' })).toBe('carol');
    expect(namedOwnerOf({})).toBeNull();
  });

  it('named_state 缺省 active（旧数据视为指名）', () => {
    expect(namedStateOf({})).toBe('active');
    expect(namedStateOf({ named_state: 'inactive' })).toBe('inactive');
  });

  it('named_tier 缺省回退 payload.tier / 潜力', () => {
    expect(namedTierOf({ named_tier: '重点' })).toBe('重点');
    expect(namedTierOf({ tier: '目标' })).toBe('目标');
    expect(namedTierOf({})).toBe('潜力');
  });
});

describe('visitDueAt 应访日', () => {
  it('有拜访 → 最近拜访日 + 窗口天数', () => {
    const p = { visit_notes: [{ at: '2026-08-01T09:00:00+08:00' }] };
    const due = visitDueAt(p, '重点', cfg).getTime();
    expect(due).toBe(new Date('2026-08-08T09:00:00+08:00').getTime()); // week=7
  });

  it('无拜访 → 分配生效日(assignedAt) + 窗口天数', () => {
    const due = visitDueAt({}, '目标', cfg, new Date('2026-08-10T09:00:00+08:00')).getTime();
    expect(due).toBe(new Date('2026-09-09T09:00:00+08:00').getTime()); // month=30
  });

  it('多个拜访取最近一次', () => {
    const p = { visit_notes: [
      { at: '2026-08-01T09:00:00+08:00' },
      { at: '2026-08-15T09:00:00+08:00' },
    ] };
    const due = visitDueAt(p, '重点', cfg).getTime();
    expect(due).toBe(new Date('2026-08-22T09:00:00+08:00').getTime());
  });
});

describe('namedVisitStatus 告警状态（红/黄/绿）', () => {
  it('窗口内实际≥应访 → 绿(pass, alert=null)', () => {
    // 2 天前拜访在 week(7) 窗口内 → actual=1 ≥ target=1 → pass
    const p = { visit_notes: [{ at: new Date(Date.now() - 2 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '重点', cfg, thr);
    expect(s.pass).toBe(true);
    expect(s.alert).toBeNull();
  });

  it('超过 alert_days → 红', () => {
    // 应访日 = 最近拜访(30 天前) + week(7) = 23 天前 → 超 warn(1)/alert(2)
    const p = { visit_notes: [{ at: new Date(Date.now() - 30 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '重点', cfg, thr);
    expect(s.pass).toBe(false);
    expect(s.alert).toBe('red');
  });

  it('距离应访日已超 warn 未到 alert → 黄', () => {
    // 最近拜访 8.5 天前 + week(7) → 应访日已过 1.5 天 → 超 warn(1) 未到 alert(2)
    const p = { visit_notes: [{ at: new Date(Date.now() - 8.5 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '重点', cfg, thr);
    expect(s.overdueDays).toBe(1);
    expect(s.alert).toBe('yellow');
  });

  it('阈值走配置：alert_days=5 / warn_days=1 时超 1 天未到 5 → 黄（非红非 null）', () => {
    const loose = mergedThresholds({ coverage: { named_visit_alert_days: 5, named_visit_warn_days: 1 } });
    // 最近拜访 8.5 天前 + week → 应访日已过 1.5 天 → 超 warn(1) 未到 alert(5) → 黄
    const p = { visit_notes: [{ at: new Date(Date.now() - 8.5 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '重点', cfg, loose);
    expect(s.alert).toBe('yellow');
    expect(s.overdueDays).toBe(1);
  });

  it('返回带 target/actual/window 供页面渲染', () => {
    const p = { visit_notes: [{ at: new Date(Date.now() - 20 * 86400000).toISOString() }] };
    const s = namedVisitStatus(p, '目标', cfg, thr);
    expect(s.target).toBe(1);
    expect(s.window).toBe('month');
    expect(typeof s.actual).toBe('number');
  });
});