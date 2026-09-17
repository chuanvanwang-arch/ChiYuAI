// test/scheduler/salesDailyScan-personal.test.js — 行为巡检信号的「按人隔离」语义（2026-09-17）
//
// 触发：用户实测「这里好像没有完全按照销售员进行隔离，很多信息是相同的」。
// 真库取证：visit_shortfall 1013 open / info_collect_lag 506 open，owner_id 非空 = 0，
//   全部 target_role='sales' → 命中读谓词的广播分支 → 同租户每人看到同一张表。
//
// 本文件锁死两件事（缺一即问题复现）：
//   ① **口径**：聚合指标按 owner 分组逐人算——不是租户合计。核心鉴别用例见
//      「租户合计达标但个人未达标」：旧实现只判合计 → 漏报；新实现必须报出该人。
//   ② **可见面**：个人级 hit 带 owner_id/target_role='sales'（只有本人可见），
//      团队合计带 owner_id=null/target_role='manager'（只广播给经理，不再广播给全体销售）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { salesDailyScan, accountOwner } from '../../src/scheduler/salesDailyScan.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const todayNote = () => ({ at: new Date().toISOString() });

// 账户构造器：显式给 owner（null = 无主公海户）
const acct = (id, owner, { today = 0, week = 0, createdDaysAgo = 30, tier = '潜力', lastVisitDaysAgo = null } = {}) => ({
  id,
  type: 'CRM_ACCOUNT',
  created_at: daysAgo(createdDaysAgo),
  payload: {
    name: id, tier, owner_id: owner,
    visit_notes: [
      ...(lastVisitDaysAgo != null ? [{ at: daysAgo(lastVisitDaysAgo) }] : []),
      ...Array.from({ length: today }, todayNote),
      // 其余周内拜访落在 3 天前（明确在 7 天窗口内，避开窗口边界毫秒抖动）
      ...Array.from({ length: Math.max(0, week - today) }, () => ({ at: daysAgo(3) })),
    ],
  },
});

const scan = (accounts) => salesDailyScan({ accounts, deals: [], thresholds: mergedThresholds({}) });
const of = (hits, kind, owner) => hits.filter(h => h.kind === kind && h.owner_id === owner);

describe('salesDailyScan 按 owner 分组（个人隔离 ①：口径）', () => {
  // 场景：alice 全达标（今日 3、本周 15、周新增 5），bob 全零。
  // 租户合计：今日 3（达标）、本周 15（达标）、周新增 5（达标）→ 团队级不该告警。
  // 但 bob 个人三项全未达标 → 必须为 bob 各报一条。
  // 这正是旧实现的病灶：只判合计 → bob 什么也收不到，而所有人看到的是同一句"合计达标"。
  const alice = [
    acct('a1', 'alice', { today: 3, week: 15, createdDaysAgo: 1 }),
    acct('a2', 'alice', { createdDaysAgo: 2 }),
    acct('a3', 'alice', { createdDaysAgo: 3 }),
    acct('a4', 'alice', { createdDaysAgo: 4 }),
    acct('a5', 'alice', { createdDaysAgo: 5 }),
  ];
  const bob = acct('b1', 'bob', { createdDaysAgo: 30 });
  const hits = scan([...alice, bob]);

  it('租户合计达标 → 不产生团队级告警（团队口径判断正确）', () => {
    expect(of(hits, 'visit_shortfall', null)).toHaveLength(0);
    expect(of(hits, 'info_collect_lag', null)).toHaveLength(0);
  });

  it('个人未达标 → 必须报出（旧实现只判合计会漏报此人）', () => {
    const bobVisit = of(hits, 'visit_shortfall', 'bob');
    // 日/周各一条
    expect(bobVisit).toHaveLength(2);
    expect(bobVisit.map(h => h.metric.dailyVisits ?? h.metric.weeklyVisits)).toEqual(
      expect.arrayContaining([0]),
    );
    const bobInfo = of(hits, 'info_collect_lag', 'bob');
    expect(bobInfo).toHaveLength(1);
    expect(bobInfo[0].metric.weekNew).toBe(0);
  });

  it('个人达标 → 不为该人产告警（alice 无任何聚合 hit）', () => {
    expect(hits.filter(h => h.owner_id === 'alice')).toHaveLength(0);
  });

  it('个人指标取本人范围，不是租户合计', () => {
    // bob 组内本周拜访 = 0（自己的），而不是租户合计的 15
    const weekly = of(hits, 'visit_shortfall', 'bob').find(h => h.metric.weeklyTarget != null);
    expect(weekly.metric.weeklyVisits).toBe(0);
    expect(weekly.metric.weeklyTarget).toBe(15);
  });
});

describe('salesDailyScan 作用域与可见面（个人隔离 ②：target_role / owner_id）', () => {
  it('个人级 hit：target_role=sales + owner_id=责任人', () => {
    const hits = scan([acct('b1', 'bob')]).filter(h => h.owner_id === 'bob');
    expect(hits.length).toBeGreaterThan(0); // 自检：确实产出了个人级 hit
    for (const h of hits.filter(x => x.kind === 'visit_shortfall' || x.kind === 'info_collect_lag')) {
      expect(h.owner_id).toBe('bob');
      expect(h.target_role).toBe('sales');
      expect(h.metric.scope).toBe('owner');
    }
  });

  it('团队级 hit：owner_id=null + target_role=manager（不再广播给销售员）', () => {
    const hits = scan([acct('b1', 'bob')]);
    const team = hits.filter(h => h.owner_id === null);
    expect(team.length).toBeGreaterThan(0);
    for (const h of team) {
      expect(h.target_role).toBe('manager');
      expect(h.metric.scope).toBe('team');
    }
  });

  it('无主账户不进任何个人组，也不臆造责任人', () => {
    const hits = scan([acct('u1', null), acct('u2', '')]);
    // 无主只体现在团队合计里
    expect(hits.filter(h => h.owner_id !== null)).toHaveLength(0);
    expect(hits.filter(h => h.owner_id === null).length).toBeGreaterThan(0);
  });

  it('账户级信号（覆盖缺口/流失）责任人随账户走，不再落 NULL 广播', () => {
    // 目标户、100 天未拜访（>30 触发覆盖缺口、>90 触发流失警戒）
    const hits = scan([acct('a9', 'alice', { tier: '目标', lastVisitDaysAgo: 100, createdDaysAgo: 200 })]);
    const cov = hits.find(h => h.kind === 'coverage_gap');
    expect(cov).toBeTruthy();
    expect(cov.owner_id).toBe('alice');
    const lost = hits.find(h => h.kind === 'lost_contact');
    expect(lost.owner_id).toBe('alice');
  });
});

describe('salesDailyScan 聚合信号的稳定 dedup_key（去重防堆积）', () => {
  it('聚合 hit 均带 dedup_key；同输入重复调用键完全一致（幂等，不再每 30 分钟新增行）', () => {
    const accounts = [acct('b1', 'bob'), acct('a1', 'alice', { today: 1, week: 1, createdDaysAgo: 1 })];
    const k1 = scan(accounts).filter(h => h.dedup_key).map(h => h.dedup_key).sort();
    const k2 = scan(accounts).filter(h => h.dedup_key).map(h => h.dedup_key).sort();
    expect(k1.length).toBeGreaterThan(0);
    expect(k1).toEqual(k2);
  });

  it('不同责任人的键互不相同（否则会互相覆盖成"大家看到同一条"）', () => {
    const hits = scan([acct('b1', 'bob'), acct('z1', 'zoe')]);
    const bobKeys = hits.filter(h => h.owner_id === 'bob').map(h => h.dedup_key);
    const zoeKeys = hits.filter(h => h.owner_id === 'zoe').map(h => h.dedup_key);
    expect(bobKeys.length).toBeGreaterThan(0);
    expect(zoeKeys.length).toBeGreaterThan(0);
    for (const k of bobKeys) expect(zoeKeys).not.toContain(k);
    // 团队键也不与个人键相撞
    expect(bobKeys.every(k => !k.includes(':team:'))).toBe(true);
  });

  it('责任人名为 "team" 时不与团队键相撞（前缀区分，非裸名拼接）', () => {
    const hits = scan([acct('t1', 'team')]);
    const personal = hits.find(h => h.owner_id === 'team' && h.dedup_key);
    const teamHit = hits.find(h => h.owner_id === null && h.dedup_key);
    expect(personal.dedup_key).not.toBe(teamHit.dedup_key);
  });
});

describe('accountOwner 类型闸（fail-closed：拿不到责任人就不臆造）', () => {
  it('非字符串/空串/纯空白 → null', () => {
    expect(accountOwner({ payload: { owner_id: 123 } })).toBeNull();
    expect(accountOwner({ payload: { owner_id: '' } })).toBeNull();
    expect(accountOwner({ payload: { owner_id: '   ' } })).toBeNull();
    expect(accountOwner({ payload: {} })).toBeNull();
    expect(accountOwner({})).toBeNull();
    expect(accountOwner(null)).toBeNull();
  });
  it('正常 username → 去空白后返回', () => {
    expect(accountOwner({ payload: { owner_id: ' alice ' } })).toBe('alice');
  });
});

describe('接线守卫：产生点必须透传 owner_id 与 dedup_key', () => {
  const src = readFileSync(new URL('../../src/scheduler/timers.js', import.meta.url), 'utf8');

  // 断言「取自 hit」而非「键存在」——写成 owner_id: null 也能通过裸键检查，
  // 那正是本类缺陷的原始形态（参数位在、值恒空），故用 `h.owner_id` 形态锁死。
  const callOf = () => {
    const i = src.indexOf('createAlertWithDb(pool, {');
    expect(i).toBeGreaterThan(-1); // 守卫自检：真的扫到了调用点
    return src.slice(i, src.indexOf('});', i));
  };

  it('sales-daily-scan 的 createAlertWithDb 从 hit 透传 owner_id 与 dedup_key', () => {
    const call = callOf();
    expect(call).toMatch(/owner_id\s*:\s*h\.owner_id/);
    expect(call).toMatch(/dedup_key\s*:\s*h\.dedup_key/);
  });

  it('产生点优先采用巡检给出的 target_role，而非旧的"高危→exec 其余→sales"盲配', () => {
    expect(callOf()).toMatch(/h\.target_role/);
  });

  it('存在陈旧聚合信号的收口调用（稳定 dedup_key 的必然配套）', () => {
    expect(src).toMatch(/closeStaleAggregates/);
    expect(src).toMatch(/keepByKind/);
  });
});
