// test/signal/route.test.js — 投递路由与收件人解析（纯函数级，注入替身 readConfig/query）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md v1.1 §3.2（含 D1 修正）
// 执行期修正 P-3（2026-09-16）：工厂名 createSignalRouter → **createDeliveryRouter**。
//   原因：`createSignalRouter` 已被 src/signal/router.js 占用（告警→信号路由，签名 {now}），
//   两模块同名导出、文件路径仅差一个字符（router.js / route.js），是典型的「同名漂移」陷阱。
import { describe, it, expect } from 'vitest';
import { createDeliveryRouter } from '../../src/signal/route.js';

// 替身 readConfig：返回 { value } 形状（与 src/config/configStore.js 真实返回一致）
function fakeRead(value) {
  return async () => (value === null ? null : { value });
}

const ON_ALL = {
  channels: { inbox: 'on', email: 'on', im: 'on', webhook: 'on' },
  route: { high: ['im', 'email'], medium: ['email'], low: ['inbox'] },
  role_recipients: { sales: ['alice'] },
};
const NO_QUERY = { query: async () => ({ rows: [{ c: 0 }] }) };

// Task 2b fixture：既有 inbox 又有出站渠道，配额已配置（见计划 Task 2b Step 1）
const CFG_WITH_RATE_LIMIT = {
  channels: { inbox: 'on', email: 'on' },
  route: { high: ['inbox', 'email'] },
  role_recipients: { sales: ['alice'] },
  rate_limit: { per_hour: 5 },
};

describe('route.loadPolicy（渠道集合必须来自配置）', () => {
  it('配置存在 → channels 只含值为 on/true 的渠道', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { inbox: 'on', email: 'off', im: 'on', webhook: 'off' } }),
      query: NO_QUERY.query,
    });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.configured).toBe(true);
    expect(p.channels).toEqual(['inbox', 'im']);
  });

  it('配置缺失 → configured=false 且 channels 为空（fail-closed，绝不默认全开）', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead(null), query: NO_QUERY.query });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.configured).toBe(false);
    expect(p.reason).toBe('delivery_config_missing');
    expect(p.channels).toEqual([]);
  });

  // 执行期修正 P-2（2026-09-16）：初稿 loadPolicy 用 `.catch(() => null)` 会把「DB 读取失败」
  //   与「配置缺失」压成同一个结果 —— 这正是本项目最忌讳的误归因（把一个真故障降级成一个"待配置项"）。
  it('配置读取抛错 → 与「配置缺失」分别留痕（read_failed ≠ missing）', async () => {
    const r = createDeliveryRouter({
      readConfig: async () => { throw new Error('db down'); },
      query: NO_QUERY.query,
    });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.configured).toBe(false);
    expect(p.reason).toBe('delivery_config_read_failed');
    expect(p.readError).toContain('db down');
    expect(p.channels).toEqual([]);

    const out = await r.resolve({ signal: { signal_id: 's9', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.reason).toBe('delivery_config_read_failed');
    expect(out.decisions).toEqual([]);
  });

  it('retry 缺省为 0（无配置即不重试，零字面量阈值）', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead({ channels: { inbox: 'on' } }), query: NO_QUERY.query });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.retryLimit).toBe(0);
  });

  it('retry 显式配置为 2 → retryLimit=2', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead({ channels: { inbox: 'on' }, retry: 2 }), query: NO_QUERY.query });
    const p = await r.loadPolicy({ tenantId: 't1' });
    expect(p.retryLimit).toBe(2);
  });
});

describe('route.resolve（逐渠道决策）', () => {
  it('severity=high → 路由到 im+email（且均在 channels 内）', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead(ON_ALL), query: NO_QUERY.query });
    const out = await r.resolve({ signal: { signal_id: 's1', tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions.map((d) => d.channel)).toEqual(['im', 'email']);
  });

  it('severity=low → 路由到 inbox', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead(ON_ALL), query: NO_QUERY.query });
    const out = await r.resolve({ signal: { signal_id: 's2', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions.map((d) => d.channel)).toEqual(['inbox']);
  });

  it('路由要求的渠道未被启用 → 被过滤掉（绝不越出配置开关）', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { inbox: 'on', email: 'off' }, route: { high: ['im', 'email'] }, role_recipients: { sales: ['alice'] } }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({ signal: { signal_id: 's3', tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    // route.high 要求 im+email，但 channels 只开了 inbox（email='off'）→ 交集为空 → 零决策
    expect(out.decisions).toEqual([]);
    expect(out.reason).toBe('no_channel_for_severity');
  });

  it('role_recipients 解析不到 → 出站渠道 skip 且 reason=no_recipient（不静默）', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { email: 'on' }, route: { high: ['email'] }, role_recipients: {} }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({ signal: { signal_id: 's4', tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]);
  });

  it('inbox 渠道无需收件人（不依赖 role_recipients）', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { inbox: 'on' }, route: { low: ['inbox'] }, role_recipients: {} }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({ signal: { signal_id: 's5', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions).toEqual([{ channel: 'inbox', recipient: null, skip: false, reason: null }]);
  });

  it('静默时段（含跨午夜）→ 全渠道 skip 且 reason=quiet_hours', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { inbox: 'on' }, quiet_hours: { start: 22, end: 6 } }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({
      signal: { signal_id: 's6', tenant_id: 't1', severity: 'low', target_role: 'sales' },
      tenantId: 't1',
      now: new Date('2026-09-16T23:30:00'),
    });
    expect(out.decisions).toEqual([{ channel: 'inbox', recipient: null, skip: true, reason: 'quiet_hours' }]);
  });

  it('超出 per_hour 限速 → 仅出站渠道 skip（Task 2b：inbox 不因限速被拦）', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { inbox: 'on' }, rate_limit: { per_hour: 5 } }),
      query: async () => ({ rows: [{ c: 5 }] }), // 已用满
    });
    const out = await r.resolve({ signal: { signal_id: 's7', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.decisions).toEqual([{ channel: 'inbox', recipient: null, skip: false, reason: null }]);
  });

  // ===== Task 2b：rate_limit 只约束出站渠道，不得连带拦截 inbox 站内投递 =====
  it('rate_limit 只统计出站渠道（SQL 必须按渠道收窄，inbox sent 行不计入）', async () => {
    const q = async (sql) => {
      // 鉴别力断言：计数 SQL 必须含渠道收窄条件（缺 channel 条件即失败）
      expect(sql).toMatch(/channel\s*(=|<>|!=)\s*(ANY|ALL)|channel\s+NOT\s+IN|channel\s*=\s*\$/i);
      return { rows: [{ c: 0 }] }; // 出站渠道未超限
    };
    const r = createDeliveryRouter({ query: q, readConfig: async () => ({ value: CFG_WITH_RATE_LIMIT }) });
    const pol = await r.loadPolicy({ tenantId: 't1' });
    expect(await r.overRateLimit(pol.rateLimit, { tenantId: 't1' })).toBe(false);
  });

  it('rate_limited 不拦 inbox（限速命中时站内仍投递，出站 skip）', async () => {
    const r = createDeliveryRouter({
      query: async () => ({ rows: [{ c: 999 }] }), // 远超限速
      readConfig: async () => ({ value: CFG_WITH_RATE_LIMIT }),
    });
    const res = await r.resolve({ signal: { tenant_id: 't1', severity: 'high', target_role: 'sales' }, tenantId: 't1' });
    const inbox = res.decisions.find((d) => d.channel === 'inbox');
    expect(inbox.skip).toBe(false); // 现状为 true → 先红
    const email = res.decisions.find((d) => d.channel === 'email');
    expect(email.skip).toBe(true);
    expect(email.reason).toBe('rate_limited');
  });

  it('静默时段仍全局生效（Task 2b 保留语义：静默 ≠ 配额）', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { inbox: 'on', email: 'on' }, quiet_hours: { start: 22, end: 6 }, rate_limit: { per_hour: 5 } }),
      query: async () => ({ rows: [{ c: 0 }] }),
    });
    const out = await r.resolve({
      signal: { signal_id: 's2b', tenant_id: 't1', severity: 'high', target_role: 'sales' },
      tenantId: 't1',
      now: new Date('2026-09-16T23:30:00'),
    });
    const inbox = out.decisions.find((d) => d.channel === 'inbox');
    const email = out.decisions.find((d) => d.channel === 'email');
    expect(inbox.skip).toBe(true); // 静默全局生效，inbox 也要 skip
    expect(inbox.reason).toBe('quiet_hours');
    expect(email.skip).toBe(true);
    expect(email.reason).toBe('quiet_hours');
  });

  it('配置缺失 → reason=delivery_config_missing 且 decisions 为空', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead(null), query: NO_QUERY.query });
    const out = await r.resolve({ signal: { signal_id: 's8', tenant_id: 't1', severity: 'low', target_role: 'sales' }, tenantId: 't1' });
    expect(out.reason).toBe('delivery_config_missing');
    expect(out.decisions).toEqual([]);
  });
});

// D1（设计 §3.2 修正，2026-09-16）：泵范围含 system，故 system 的收件人路径必须被显式验证
describe('route 平台租户收件人回退（D1：system 不享有投递豁免）', () => {
  const CFG_WITH_PLATFORM = {
    channels: { email: 'on' },
    route: { high: ['email'] },
    role_recipients: { platform: ['ops@example.com'], sales: ['alice'] },
  };

  it('system 租户 + 业务角色解析不到 → 回退 role_recipients.platform', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead(CFG_WITH_PLATFORM), query: NO_QUERY.query });
    const out = await r.resolve({
      signal: { signal_id: 'p1', tenant_id: 'system', severity: 'high', target_role: 'unknown-role' },
      tenantId: 'system',
    });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: 'ops@example.com', skip: false, reason: null }]);
  });

  it('system 租户 + platform 键也缺失 → 仍返回 no_recipient（不因平台租户而豁免）', async () => {
    const r = createDeliveryRouter({
      readConfig: fakeRead({ channels: { email: 'on' }, route: { high: ['email'] }, role_recipients: { sales: ['alice'] } }),
      query: NO_QUERY.query,
    });
    const out = await r.resolve({
      signal: { signal_id: 'p2', tenant_id: 'system', severity: 'high', target_role: 'unknown-role' },
      tenantId: 'system',
    });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]);
  });

  it('非 system 租户绝不回退 platform（跨租户隔离：不得借用他人收件人）', async () => {
    const r = createDeliveryRouter({ readConfig: fakeRead(CFG_WITH_PLATFORM), query: NO_QUERY.query });
    const out = await r.resolve({
      signal: { signal_id: 'p3', tenant_id: 't1', severity: 'high', target_role: 'unknown-role' },
      tenantId: 't1',
    });
    expect(out.decisions).toEqual([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]);
  });
});
