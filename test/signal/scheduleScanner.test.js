// test/signal/scheduleScanner.test.js — T15 时间型信号（signal-schedule 配置驱动）
import { describe, it, expect } from 'vitest';
import { createScheduleScanner } from '../../src/signal/scheduleScanner.js';

function makeCtx({ rows = [], signals = [], readConfigValue } = {}) {
  const q = async () => ({ rows });
  const signalStore = {
    created: signals,
    create(o) { signals.push(o); return Promise.resolve({ ok: true, alert: { signal_id: 's' + signals.length }, deduped: false }); },
  };
  const readConfig = async () => ({ value: readConfigValue });
  return { q, signalStore, readConfig };
}

const RULE = { id: 'quote-timeout', kind: 'quote_approval_timeout', entity_type: 'CRM_DEAL',
  condition: { field: 'quote_status', op: 'eq', value: 'pending_approval' },
  threshold_days: 3, ts_field: 'approval_requested_at', severity: 'high', target_role: 'sales', enabled: true, bucket: 'day' };

describe('T15 时间型信号', () => {
  it('阈值配置化：threshold_days 改变命中集合', async () => {
    const deal = { id: 'd1', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5 * 86400000).toISOString() } };
    const { q, signalStore, readConfig } = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [RULE] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(1);
    expect(signalStore.created[0].kind).toBe('quote_approval_timeout');
  });

  // T21 个人隔离：时间型信号须带上粒子 payload 里的责任人
  //   鉴别力：原实现**读得到 entity.payload.owner_id 却从不传** → 此断言红（204 行 owner_id 全 NULL 的成因之一）
  it('owner_id 透传：粒子 payload.owner_id 落到信号（无主则显式 null）', async () => {
    const withOwner = { id: 'd-own', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5 * 86400000).toISOString(), owner_id: 'alice' } };
    const ctx1 = makeCtx({ rows: [withOwner], readConfigValue: { enabled: true, rules: [RULE] } });
    await createScheduleScanner({ query: ctx1.q, signalStore: ctx1.signalStore, readConfig: ctx1.readConfig }).scanOnce({ tenantId: 't1' });
    expect(ctx1.signalStore.created[0].owner_id).toBe('alice');

    const noOwner = { id: 'd-no', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5 * 86400000).toISOString() } };
    const ctx2 = makeCtx({ rows: [noOwner], readConfigValue: { enabled: true, rules: [RULE] } });
    await createScheduleScanner({ query: ctx2.q, signalStore: ctx2.signalStore, readConfig: ctx2.readConfig }).scanOnce({ tenantId: 't1' });
    expect(ctx2.signalStore.created[0].owner_id).toBeNull();
  });
  it('阈值调大后同数据不再命中（可证配置生效）', async () => {
    const deal = { id: 'd1', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5 * 86400000).toISOString() } };
    const bigRule = { ...RULE, threshold_days: 10 };
    const { q, signalStore, readConfig } = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [bigRule] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(0);
  });
  it('hitsRule 纯函数：op=eq 不匹配 / 未超阈值 不命中', async () => {
    const { q, signalStore, readConfig } = makeCtx({ readConfigValue: { enabled: true, rules: [RULE] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    expect(sc.hitsRule(RULE, { payload: { quote_status: 'approved' } })).toBe(false); // op=eq 不匹配
    expect(sc.hitsRule(RULE, { payload: { quote_status: 'pending_approval', approval_requested_at: new Date().toISOString() } })).toBe(false); // 未超阈值
  });
  it('disabled 配置 → 不扫描', async () => {
    const { q, signalStore, readConfig } = makeCtx({ rows: [{ id: 'd', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 9 * 86400000).toISOString() } }], readConfigValue: { enabled: false, rules: [RULE] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(0);
  });
});

// ── L3 前瞻语义（2026-09-16）：'due_within_days' ──
// 为什么需要：既有 hitsRule 只支持 threshold_days 的「已逾期 N 天」（age ≥ N）。
//   而「投标截止」「汇报到期」是**前瞻**型：把 age 语义套上去 → 只在截止日**过去 N 天之后**才提醒，
//   提醒时机完全反了。两者必须共存，且旧语义零回归。
const sc = createScheduleScanner({
  query: async () => ({ rows: [] }),
  signalStore: { create: async () => ({ ok: true }) },
  readConfig: async () => ({ value: {} }),
});
describe('hitsRule：due_within_days 前瞻语义 + 旧语义零回归', () => {
  const NOW = Date.parse('2026-11-01T00:00:00Z');
  const DUE_RULE = {
    id: 'tender-deadline', kind: 'tender_deadline', entity_type: 'CRM_DEAL',
    condition: { op: 'due_within_days', threshold_days: 7 },
    ts_field: 'tender_deadline', severity: 'high', target_role: 'sales',
  };

  it('截止日在未来 3 天（窗口 7 天）→ 命中', () => {
    const e = { id: 'd1', payload: { tender_deadline: '2026-11-04T00:00:00Z' } };
    expect(sc.hitsRule(DUE_RULE, e, NOW)).toBe(true);
  });

  it('截止日在未来 10 天（超出窗口）→ 不命中', () => {
    const e = { id: 'd1', payload: { tender_deadline: '2026-11-11T00:00:00Z' } };
    expect(sc.hitsRule(DUE_RULE, e, NOW)).toBe(false);
  });

  it('截止日已过 → 不命中（前瞻不承担逾期，逾期由既有 age 语义覆盖）', () => {
    const e = { id: 'd1', payload: { tender_deadline: '2026-10-30T00:00:00Z' } };
    expect(sc.hitsRule(DUE_RULE, e, NOW)).toBe(false);
  });

  it('规则未声明 ts_field → 不命中（禁止回退 updated_at 冒充截止日）', () => {
    const e = { id: 'd1', payload: { updated_at: '2026-11-04T00:00:00Z' } };
    expect(sc.hitsRule({ ...DUE_RULE, ts_field: undefined }, e, NOW)).toBe(false);
  });

  it('实体缺该字段 → 不命中（不抛）', () => {
    expect(sc.hitsRule(DUE_RULE, { id: 'd1', payload: {} }, NOW)).toBe(false);
  });

  it('负向对照：旧 age≥ 语义（threshold_days）零回归', () => {
    const AGE_RULE = { id: 'q', kind: 'quote_approval_timeout', entity_type: 'CRM_DEAL', threshold_days: 3 };
    expect(sc.hitsRule(AGE_RULE, { payload: { updated_at: '2026-10-20T00:00:00Z' } }, NOW)).toBe(true);  // 12 天前 → 命中
    expect(sc.hitsRule(AGE_RULE, { payload: { updated_at: '2026-10-31T00:00:00Z' } }, NOW)).toBe(false); // 1 天前 → 不命中
  });
});

// ── L3 周期型规则（2026-09-16）：schedule_kind='periodic' ──
// 为什么需要：report_due（周报到期）约束的是**人**而非实体，没有对应粒子。
//   强行绑粒子只能硬塞到某个 CRM_DEAL 上 → 语义造假（给不存在的商机发提醒）。
//   故须有不读 particles 的周期分支，按租户内启用用户逐人产个人级信号。
describe('scanOnce：periodic 规则（不读 particles）', () => {
  function ctxPeriodic() {
    const created = [];
    const queries = [];
    return {
      created, queries,
      q: async (sql) => {
        queries.push(sql);
        if (/FROM crm\.crm_users/.test(sql)) return { rows: [{ username: 'alice' }, { username: 'bob' }] };
        return { rows: [] };                       // 粒子查询恒空
      },
      store: { create: async (o) => { created.push(o); return { ok: true, deduped: false }; } },
      readConfig: async () => ({ value: { enabled: true, rules: [
        { id: 'report-due', kind: 'report_due', entity_type: null, schedule_kind: 'periodic',
          weekday: 5, hour: 17, severity: 'low', target_role: 'sales', enabled: true, bucket: 'week' },
      ] } }),
    };
  }

  it('落在窗口内 → 按启用用户逐人产信号，owner_id 落到人', async () => {
    const c = ctxPeriodic();
    const sc2 = createScheduleScanner({ query: c.q, signalStore: c.store, readConfig: c.readConfig });
    const NOW = Date.parse('2026-09-18T17:05:00+08:00');   // 2026-09-18 是周五
    const r = await sc2.scanOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(2);
    expect(c.created.map((x) => x.owner_id).sort()).toEqual(['alice', 'bob']);
    expect(c.created[0].dedup_key).toContain('schedule:report-due:');
    expect(c.created[0].dedup_key).toContain('2026-W38');
  });

  it('不在窗口（非该星期/小时）→ 零产出', async () => {
    const c = ctxPeriodic();
    const sc2 = createScheduleScanner({ query: c.q, signalStore: c.store, readConfig: c.readConfig });
    const r = await sc2.scanOnce({ tenantId: 't1', now: Date.parse('2026-09-17T17:05:00+08:00') }); // 周四
    expect(r.signals).toBe(0);
  });

  it('窗口内重复扫描 → dedup_key 不变（幂等由桶键保证）', async () => {
    const c = ctxPeriodic();
    const sc2 = createScheduleScanner({ query: c.q, signalStore: c.store, readConfig: c.readConfig });
    const NOW = Date.parse('2026-09-18T17:05:00+08:00');
    await sc2.scanOnce({ tenantId: 't1', now: NOW });
    await sc2.scanOnce({ tenantId: 't1', now: NOW + 60_000 });
    const keys = new Set(c.created.map((x) => x.dedup_key));
    expect(keys.size).toBe(2);                     // 两个用户各一把键，不因二次扫描翻倍
    expect(c.created).toHaveLength(4);             // 但 create 被调 4 次（幂等由 store.create 的 dedup 承担）
  });

  it('纯函数 hitsPeriodic / bucketKey', async () => {
    const sc2 = createScheduleScanner({ query: async () => ({ rows: [] }), signalStore: { create: async () => ({ ok: true }) }, readConfig: async () => ({ value: {} }) });
    const FRI = Date.parse('2026-09-18T17:05:00+08:00');
    expect(sc2.hitsPeriodic({ weekday: 5, hour: 17 }, FRI)).toBe(true);
    expect(sc2.hitsPeriodic({ weekday: 4, hour: 17 }, FRI)).toBe(false);
    expect(sc2.bucketKey(FRI, 'week')).toBe('2026-W38');
    expect(sc2.bucketKey(FRI, 'day')).toBe('2026-09-18');
    expect(sc2.bucketKey(FRI, 'month')).toBe('2026-09');
  });
});

// ── 日历载体（2026-09-17 补）：前瞻型命中的日期写入 payload.event_at ──
// 缺口实证（本地 crm_native）：全库 `payload ? 'event_at'` 的 crm.signal = **0** 行
//   ⇒ buildIcs() 恒返回 null ⇒ 需求③「到点自动运行……**同时建立日历**」在此之前结构性不可达。
//   根因不在日历模块（ics.js 正确实现了「缺日期不造日程」铁律②），而在**没有任何生产者写该键**。
// 边界（必须锁死，否则会从「没有日历」变成「有假日历」）：
//   · 只有 due_within_days（前瞻型）才写 —— age 型（静默/超时）的时间戳在**过去**，
//     写进去会生成过去的幽灵日程；周期型本就不绑日期。
//   · ts_field 必须显式声明；非 ISO 自由文本（`"2026-11-04 前后"`）不得写入。
describe('日历载体：前瞻型命中 → payload.event_at（.ics 可达）', () => {
  const NOW = Date.parse('2026-11-01T00:00:00Z');
  const DUE = {
    id: 'tender-deadline', kind: 'tender_deadline', entity_type: 'CRM_DEAL',
    condition: { op: 'due_within_days', threshold_days: 7 },
    ts_field: 'tender_deadline', severity: 'high', target_role: 'sales', enabled: true, bucket: 'day',
  };

  it('命中 → payload.event_at 等于被判定日期，且 buildIcs 能产出 VEVENT（端到端可生成日历）', async () => {
    const { buildIcs } = await import('../../src/signal/ics.js');
    const deal = { id: 'd-tender', tenant_id: 't1', payload: {
      tender_deadline: '2026-11-04T02:00:00Z', owner_id: 'alice' } };
    const c = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [DUE] } });
    const sc2 = createScheduleScanner({ query: c.q, signalStore: c.signalStore, readConfig: c.readConfig });
    const r = await sc2.scanOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    const sig = c.signalStore.created[0];
    expect(sig.payload.event_at).toBe('2026-11-04T02:00:00Z');
    // 关键：载体真能被 ics 渲染（同一 payload 走生产构建器）——这才是「建日历」成立的证据
    const ics = buildIcs({ signal_id: 'sig-1', kind: sig.kind, payload: sig.payload });
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART:20261104T020000Z');
  });

  it('age 型（静默/超时）命中 → **不写** event_at（防过去的幽灵日程）', async () => {
    const deal = { id: 'd-quiet', tenant_id: 't1', payload: {
      quote_status: 'pending_approval', approval_requested_at: new Date(NOW - 9 * 86400000).toISOString() } };
    const c = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [RULE] } });
    const sc2 = createScheduleScanner({ query: c.q, signalStore: c.signalStore, readConfig: c.readConfig });
    const r = await sc2.scanOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(c.signalStore.created[0].payload).not.toHaveProperty('event_at');
  });

  it('前瞻型但日期是非 ISO 自由文本（payload.bidding.started_at 实况）→ 不写 event_at', async () => {
    const deal = { id: 'd-free', tenant_id: 't1', payload: { tender_deadline: '2026-11-04 前后' } };
    const c = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [{ ...DUE, ts_field: 'started_at' }] } });
    const sc2 = createScheduleScanner({ query: c.q, signalStore: c.signalStore, readConfig: c.readConfig });
    await sc2.scanOnce({ tenantId: 't1', now: NOW });
    // 非 ISO → hitsRule 的 NaN 分支已判不命中，故压根不产信号；即便产出也必须不带 event_at
    for (const s of c.signalStore.created) expect(s.payload).not.toHaveProperty('event_at');
  });

  it('纯函数 calendarDate 三态：前瞻型取日期 / age 型返 null / 无 ts_field 返 null', () => {
    const sc3 = createScheduleScanner({ query: async () => ({ rows: [] }), signalStore: { create: async () => ({ ok: true }) }, readConfig: async () => ({ value: {} }) });
    expect(sc3.calendarDate(DUE, { payload: { tender_deadline: '2026-11-04T00:00:00Z' } })).toBe('2026-11-04T00:00:00Z');
    expect(sc3.calendarDate(RULE, { payload: { approval_requested_at: '2026-10-01T00:00:00Z' } })).toBeNull();
    expect(sc3.calendarDate({ ...DUE, ts_field: undefined }, { payload: { tender_deadline: '2026-11-04T00:00:00Z' } })).toBeNull();
    expect(sc3.calendarDate(DUE, { payload: {} })).toBeNull();
    expect(sc3.calendarDate(DUE, { payload: { tender_deadline: '不是日期' } })).toBeNull();
  });
});
