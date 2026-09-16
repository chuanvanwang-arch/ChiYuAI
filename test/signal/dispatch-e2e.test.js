// test/signal/dispatch-e2e.test.js — 出口真库端到端（判据①：signal → 投递 → crm.signal_delivery 出现 sent 行）
// 依赖真库 crm_native_test；每个租户自建自清（tenant 前缀 e2e-，跨会话并发安全）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md v1.1 §3.1 / §5.1（判据①）/ §5.2（N2/N8/N9）
//
// 执行期修正（2026-09-16）：
//   P-3 工厂名：createSignalRouter → createDeliveryRouter（避免与 ../signal/router.js 同名导出漂移）
//   P-6 导入路径深度：计划原文 `'../src/db.js'` → `'../../src/db.js'`（本文件位于 test/signal/，深一级）
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, pool } from '../../src/db.js';
import { createDispatcher } from '../../src/signal/dispatcher.js';
import { createDeliveryRegistry } from '../../src/signal/delivery/index.js';
import { createDeliveryStore } from '../../src/signal/delivery/signalDeliveryStore.js';
import { createDeliveryRouter } from '../../src/signal/route.js';
import { readConfig } from '../../src/config/configStore.js';
import { detectNegativePredicates } from '../../src/monitor/signalMetrics.js';

const T = `e2e-${randomUUID()}`;

function buildDispatcher() {
  return createDispatcher({
    query,
    deliveryRegistry: createDeliveryRegistry({}),
    deliveryStore: createDeliveryStore(pool),
    router: createDeliveryRouter({ query }),
    readConfig, // D2：窗口解析走 config_store（真库路径必须装配，否则只能走兜底值）
  });
}

afterAll(async () => {
  await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [T]);
  await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T]);
  await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T]);
});

describe('判据①：出口链路真库端到端', () => {
  it('配置开 inbox → 泵一次后 crm.signal_delivery 出现 sent 行，且判据A对该渠道不再触发', async () => {
    // 1) 造配置：只开 inbox（inbox 恒可用，无需外部凭据 → 真库可稳定复现）
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'e2e',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()`,
      [T, JSON.stringify({ channels: { inbox: 'on', email: 'off', im: 'off', webhook: 'off' }, route: { medium: ['inbox'] } })],
    );
    // 2) 造一条 open 信号
    const sid = `sig-${randomUUID()}`;
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe','medium','sales','open',now())`,
      [sid, T],
    );
    // 3) 泵
    const r = await buildDispatcher().pumpOnce({ tenantId: T });
    expect(r.signals).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBeGreaterThanOrEqual(1);

    // 4) 判据①：sent 行存在且 delivered_at 非空
    const { rows } = await query(
      `SELECT channel, status, delivered_at FROM crm.signal_delivery
       WHERE tenant_id=$1 AND signal_id=$2 AND status='sent'`,
      [T, sid],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].delivered_at).not.toBeNull();

    // 5) 判据A：已投递渠道不再报 delivery_silent
    const alerts = await detectNegativePredicates({ tenantId: T, since: new Date(Date.now() - 3600 * 1000) });
    const silent = alerts.filter((a) => a.type === 'delivery_silent').map((a) => a.channel);
    expect(silent).not.toContain('inbox');
  });

  it('幂等：连跑两次不产生重复 sent 行', async () => {
    const before = await query(
      `SELECT COUNT(*)::int AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND status='sent'`, [T]);
    await buildDispatcher().pumpOnce({ tenantId: T });
    const after = await query(
      `SELECT COUNT(*)::int AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND status='sent'`, [T]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  it('负向 N2：收件人解析不到 → 落 skipped 行且 last_error=no_recipient', async () => {
    const T2 = `e2e-${randomUUID()}`;
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'e2e',now())`,
      [T2, JSON.stringify({ channels: { email: 'on' }, route: { medium: ['email'] }, role_recipients: {} })],
    );
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, T2],
    );
    await buildDispatcher().pumpOnce({ tenantId: T2 });
    const { rows } = await query(
      `SELECT status, last_error FROM crm.signal_delivery WHERE tenant_id=$1 AND channel='email'`, [T2]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', last_error: 'no_recipient' });
    await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [T2]);
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T2]);
    await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T2]);
  });

  // ---- D1（设计 §3.1.1 修正）：平台租户 system 的出口路径必须真实可跑 ----
  it('负向 N8：tenant_id=system 的 signal 可被泵并落 sent 行（平台信号不得静默）', async () => {
    const sid = `sig-${randomUUID()}`;
    const kk = 'e2e-probe-system';
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ('system','signal-delivery',$1::jsonb,'e2e',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$1::jsonb, updated_at=now()`,
      [JSON.stringify({ channels: { inbox: 'on', email: 'off', im: 'off', webhook: 'off' }, route: { medium: ['inbox'] } })],
    );
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,'system','rule-scan',$2,'medium','sales','open',now())`,
      [sid, kk],
    );
    try {
      const r = await buildDispatcher().pumpOnce({ tenantId: 'system' });
      expect(r.signals).toBeGreaterThanOrEqual(1);
      expect(r.sent).toBeGreaterThanOrEqual(1);
      const { rows } = await query(
        `SELECT status, delivered_at FROM crm.signal_delivery
          WHERE tenant_id='system' AND signal_id=$1 AND status='sent'`, [sid]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].delivered_at).not.toBeNull();
    } finally {
      await query(`DELETE FROM crm.signal_delivery WHERE tenant_id='system' AND signal_id=$1`, [sid]);
      await query(`DELETE FROM crm.signal WHERE tenant_id='system' AND signal_id=$1`, [sid]);
      await query(`DELETE FROM crm.config_store WHERE tenant_id='system' AND key='signal-delivery' AND updated_by='e2e'`);
    }
  });

  // ---- D2（设计 §3.1.1 修正）：窗口只收窄候选集，绝不删/迁移行 ----
  it('负向 N9：窗口外的 open signal 不被泵，但其行仍在库（零 DELETE）', async () => {
    const T3 = `e2e-${randomUUID()}`;
    const oldSid = `sig-${randomUUID()}`;
    await query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
       VALUES ($1,'signal-delivery',$2::jsonb,'e2e',now())`,
      [T3, JSON.stringify({ channels: { inbox: 'on' }, route: { medium: ['inbox'] } })],
    );
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe-old','medium','sales','open', now() - interval '30 days')`,
      [oldSid, T3],
    );
    try {
      const r = await buildDispatcher().pumpOnce({ tenantId: T3, windowDays: 7 });
      expect(r.signals).toBe(0); // 窗口外 → 不在候选集
      const { rows: s } = await query(
        `SELECT status FROM crm.signal WHERE tenant_id=$1 AND signal_id=$2`, [T3, oldSid]);
      expect(s).toHaveLength(1);            // 行仍在（窗口不删行）
      expect(s[0].status).toBe('open');      // 状态未迁移
      const { rows: d } = await query(
        `SELECT count(*)::int AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND signal_id=$2`, [T3, oldSid]);
      expect(d[0].c).toBe(0);                // 未投递
    } finally {
      await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [T3]);
      await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T3]);
      await query(`DELETE FROM crm.config_store WHERE tenant_id=$1`, [T3]);
    }
  });

  // ---- P-5（执行期修正）：零投递必须可归因 ----
  it('P-5：未配置 signal-delivery 的租户 → 泵空转且回带 idle 原因（不静默）', async () => {
    const T4 = `e2e-${randomUUID()}`;
    await query(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
       VALUES ($1,$2,'rule-scan','e2e-probe-noconfig','medium','sales','open',now())`,
      [`sig-${randomUUID()}`, T4],
    );
    try {
      const r = await buildDispatcher().pumpOnce({ tenantId: T4 });
      expect(r.signals).toBe(1);
      expect(r.sent + r.failed + r.skipped).toBe(0);
      expect(r.idle).toEqual({ delivery_config_missing: 1 });
    } finally {
      await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T4]);
    }
  });
});
