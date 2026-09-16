// T20-1 signalMetrics 单测：getSignalMetrics 真库聚合（租户隔离）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import { getSignalMetrics, detectNegativePredicates, getDowngradeEvents } from '../../src/monitor/signalMetrics.js';

const T = `t20m-${randomUUID()}`;
const EMPTY = `t20e-${randomUUID()}`;

async function seed() {
  await query(
    `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
     VALUES ($1,$2,'rule-scan','budget-drift','high','sales','open',now())`,
    [`sig-${randomUUID()}`, T]
  );
  // 投递：1 sent(延迟~1s) / 1 failed / 1 skipped（email sent, email failed, im skipped）
  await query(
    `INSERT INTO crm.signal_delivery (delivery_id, signal_id, tenant_id, channel, status, delivered_at, created_at)
     VALUES ($1,'sig-seed',$2,'email','sent',now()+interval '1 second',now()),
            ($3,'sig-seed',$2,'email','failed','1900-01-01',now()),
            ($4,'sig-seed',$2,'im','skipped','1900-01-01',now())`,
    [`dl-${randomUUID()}`, T, `dl-${randomUUID()}`, `dl-${randomUUID()}`]
  );
  await query(
    `INSERT INTO crm.grant_execution (execution_id, tenant_id, grant_id, action_name, actor, created_at)
     VALUES ($1,$2,'grant-seed','crm-writeback-internal','standing-auth',now())`,
    [`ex-${randomUUID()}`, T]
  );
}

async function cleanup() {
  await query(`DELETE FROM crm.grant_execution WHERE tenant_id IN ($1,$2)`, [T, EMPTY]);
  await query(`DELETE FROM crm.signal_delivery WHERE tenant_id IN ($1,$2)`, [T, EMPTY]);
  await query(`DELETE FROM crm.signal WHERE tenant_id IN ($1,$2)`, [T, EMPTY]);
  await query(`DELETE FROM crm.standing_grant WHERE tenant_id IN ($1,$2)`, [T, EMPTY]);
}

beforeAll(async () => { await seed(); });
afterAll(async () => { await cleanup(); });

describe('getSignalMetrics（T20-1）', () => {
  it('聚合投递成功率/延迟/冲突/执行量/by_channel', async () => {
    const m = await getSignalMetrics({ tenantId: T, since: new Date(Date.now() - 3600 * 1000) });
    expect(m.tenant_id).toBe(T);
    expect(m.delivery_success_rate).toBeCloseTo(0.5, 5);          // sent=1 / (sent+failed)=1/2
    expect(m.avg_latency_ms).toBeGreaterThan(0);
    expect(m.avg_latency_ms).toBeLessThan(5000);
    expect(m.conflict).toBe(2);                                    // failed(1)+skipped(1)
    expect(m.execution_volume).toBe(1);
    expect(m.signal_count).toBe(1);
    const email = m.by_channel.find(c => c.channel === 'email');
    expect(email.sent).toBe(1);
    expect(email.failed).toBe(1);
  });

  it('无数据租户 → delivery_success_rate=null（不谎报 100%）', async () => {
    const m = await getSignalMetrics({ tenantId: EMPTY, since: new Date(Date.now() - 3600 * 1000) });
    expect(m.delivery_success_rate).toBeNull();
    expect(m.conflict).toBe(0);
    expect(m.execution_volume).toBe(0);
    expect(m.signal_count).toBe(0);
    expect(m.by_channel).toEqual([]);
  });
});

describe('detectNegativePredicates（T20-2）', () => {
  it('信号存在但某 enabled 渠道零投递 → delivery_silent', async () => {
    const alerts = await detectNegativePredicates({ tenantId: T, since: new Date(Date.now() - 3600 * 1000), enabledChannels: ['email', 'webhook'] });
    const silent = alerts.filter(a => a.type === 'delivery_silent');
    expect(silent.some(a => a.channel === 'webhook')).toBe(true);   // webhook 无投递行
    expect(silent.some(a => a.channel === 'email')).toBe(false);    // email 有投递
  });

  it('event-trigger 命中但无内部信号生成 → gen_silent', async () => {
    // T 已有 event-trigger 信号，但同窗口也有 rule-scan 内部信号 → 不应触发 gen_silent
    const a1 = await detectNegativePredicates({ tenantId: T, since: new Date(Date.now() - 3600 * 1000) });
    expect(a1.some(x => x.type === 'gen_silent')).toBe(false);

    // 构造纯 event-trigger 租户：仅 event-trigger 信号，无内部信号
    const G = `t20g-${randomUUID()}`;
    await query(`INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
                 VALUES ($1,$2,'event-trigger','tender-hit','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, G]);
    const a2 = await detectNegativePredicates({ tenantId: G, since: new Date(Date.now() - 3600 * 1000) });
    expect(a2.some(x => x.type === 'gen_silent' && x.fired >= 1)).toBe(true);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [G]);
  });
});

describe('getDowngradeEvents（T20-3）', () => {
  it('paused 凭证 + rejected 执行可被查询（降级追溯）', async () => {
    const g = await query(
      `INSERT INTO crm.standing_grant
         (grant_id, tenant_id, title, scope_actions, risk_tier, status, approved_by, approved_at, paused_at, paused_reason)
       VALUES ($1,$2,'降级追溯测试',ARRAY['crm-writeback-internal'],'T1','paused','alice',now(),now(),'consecutive-rejects')
       RETURNING grant_id`,
      [`grant-${randomUUID()}`, T]
    );
    await query(
      `INSERT INTO crm.grant_execution (execution_id, tenant_id, grant_id, action_name, actor, hitl_verdict, rejected_at, created_at)
       VALUES ($1,$2,$3,'crm-writeback-internal','standing-auth','rejected',now(),now())`,
      [`ex-${randomUUID()}`, T, g.rows[0].grant_id]
    );
    const d = await getDowngradeEvents({ tenantId: T, since: new Date(Date.now() - 3600 * 1000) });
    const pg = d.paused_grants.find(x => x.grant_id === g.rows[0].grant_id);
    expect(pg).toBeTruthy();
    expect(pg.paused_reason).toBe('consecutive-rejects');
    expect(pg.paused_at).toBeTruthy();
    expect(d.rejected_executions.length).toBeGreaterThanOrEqual(1);
  });
});

// ── 全链集成 Q1-4（2026-09-16）：消除 detectNegativePredicates 的 enabledChannels 假前提 ──
// 修正前：enabledChannels 缺省 = DEFAULT_CHANNELS（四渠道硬编码全开），而定时器⑯ 调用时不传参
//   → 面板「渠道『email』已开启」是判据自己注入的假前提（防假绿的判据自己制造假绿）。
// 修正后：渠道集合从 config_store['signal-delivery'].channels 读取；读不到 → 判据 A 不触发并留痕。
// 边界：**判据 A 的解析限定在自身内部**，绝不因配置缺失而提前 return（否则判据 B 被连带跳过）。
describe('detectNegativePredicates 配置驱动（Q1-4：消除 enabledChannels 假前提）', () => {
  it('租户无 signal-delivery 配置 → 不产生 delivery_silent（且不回退为「全开」）', async () => {
    const H = `q14-${randomUUID()}`;
    // 造一条信号，使判据 A 的前置（signalCount>0）成立
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','q14-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, H],
    );
    const alerts = await detectNegativePredicates({ tenantId: H, since: new Date(Date.now() - 3600 * 1000) });
    const silent = alerts.filter((a) => a.type === 'delivery_silent');
    expect(silent).toEqual([]);   // 配置缺失 → 判据 A 不触发（而非按 DEFAULT_CHANNELS 全开误报）
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [H]);
  });

  it('配置只开 inbox → 只对 inbox 判 delivery_silent', async () => {
    const H2 = `q14b-${randomUUID()}`;
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','q14-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, H2],
    );
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'test',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()`,
      [H2, JSON.stringify({ channels: { inbox: 'on', email: 'off', im: 'off', webhook: 'off' } })],
    );
    const alerts = await detectNegativePredicates({ tenantId: H2, since: new Date(Date.now() - 3600 * 1000) });
    const silent = alerts.filter((a) => a.type === 'delivery_silent');
    expect(silent.map((a) => a.channel)).toEqual(['inbox']);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [H2]);
    await query(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='signal-delivery'`, [H2]);
  });

  it('配置读取抛错 → 不产生 delivery_silent 且不抛出（「读取失败」与「配置缺失」分别留痕）', async () => {
    const H3 = `q14c-${randomUUID()}`;
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','q14-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, H3],
    );
    const alerts = await detectNegativePredicates({
      tenantId: H3,
      since: new Date(Date.now() - 3600 * 1000),
      readConfigFn: async () => { throw new Error('db down'); },
    });
    // 读取失败 → 判据 A 不触发（不得伪报渠道沉默），但**不得把异常吞成「配置缺失」**：
    //   两者 trace 名不同（read-failed / config-missing），由代码断言 + 巡检核对。
    expect(alerts.filter((a) => a.type === 'delivery_silent')).toEqual([]);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [H3]);
  });
});
