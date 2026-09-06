// test/http/auditability-sla-history.test.js — 可审计性 SLA 历史趋势端点（物化设计 §8）
// 公开只读（对齐 /api/monitor/* 家族）；?days 钳制 1..365；空表降级 rows=[]
// 安全模式 createApp().fetch()（不启真实 server，避免连接池耗尽伪失败）；测试库 plm_test 隔离
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';

const app = createApp();

describe('GET /api/monitor/auditability/history 可审计性 SLA 历史趋势', () => {
  beforeAll(async () => {
    // 种入两行物化快照（直接 INSERT agent_sla，测试物化端点读路径；materialize 本身由 test/decision 覆盖）
    await queryWrite(`DELETE FROM crm.agent_sla`).catch(() => {});
    await queryWrite(
      `INSERT INTO crm.agent_sla (measured_at, window_size, auditability_pct, full_count, with_conflict_count, tampered_count,
        q1_pass,q1_warn,q1_fail, q2_pass,q2_warn,q2_fail, q3_pass,q3_warn,q3_fail, q4_pass,q4_warn,q4_fail, raw_json)
       VALUES (now() - interval '2 days', 8, 53.0, 0, 7, 0, 8,0,0, 8,0,0, 1,7,0, 0,8,0, '{}'::jsonb),
              (now(), 8, 61.0, 1, 6, 0, 8,0,0, 8,0,0, 2,6,0, 0,8,0, '{}'::jsonb)`
    );
  });
  afterAll(async () => { await queryWrite(`DELETE FROM crm.agent_sla`).catch(() => {}); });

  it('公开端点（无 token）→ 200，返回 rows 含字段形状且按时间倒序', async () => {
    const res = await app.fetch('/api/monitor/auditability/history?days=30');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.days).toBe(30);
    expect(b.count).toBeGreaterThanOrEqual(2);
    for (const r of b.rows) {
      expect(r).toHaveProperty('measured_at');
      expect(r).toHaveProperty('window_size');
      expect(r).toHaveProperty('auditability_pct');
      expect(r).toHaveProperty('full_count');
      expect(r).toHaveProperty('with_conflict_count');
      expect(r).toHaveProperty('tampered_count');
      for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
        expect(r.per_status[q]).toHaveProperty('pass');
        expect(r.per_status[q]).toHaveProperty('warn');
        expect(r.per_status[q]).toHaveProperty('fail');
      }
    }
    // 倒序：最新在前
    const first = new Date(b.rows[0].measured_at).getTime();
    const second = new Date(b.rows[1].measured_at).getTime();
    expect(first).toBeGreaterThanOrEqual(second);
  });

  it('days 越界钳制为 365', async () => {
    const res = await app.fetch('/api/monitor/auditability/history?days=99999');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.days).toBe(365);
  });

  it('空窗口：无物化快照时 rows 为空数组（不报错）', async () => {
    await queryWrite(`DELETE FROM crm.agent_sla`).catch(() => {});
    const res = await app.fetch('/api/monitor/auditability/history?days=1');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.count).toBe(0);
    expect(Array.isArray(b.rows)).toBe(true);
    expect(b.rows.length).toBe(0);
  });
});