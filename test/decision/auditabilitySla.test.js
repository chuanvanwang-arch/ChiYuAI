// test/decision/auditabilitySla.test.js — 可审计性 SLA 物化（物化设计 §6）
// materializeAuditabilitySla：aggregateAuditability 单一事实源 → INSERT crm.agent_sla 一行 → 90d 软轮转
// 测试库 plm_test 隔离；跑后 TRUNCATE（事实表自身，允许 DELETE/TRUNCATE，非粒子/决策/记忆）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { materializeAuditabilitySla } from '../../src/decision/auditabilitySla.js';
import { queryWrite } from '../../src/db.js';

describe('materializeAuditabilitySla 平台级可审计性 SLA 物化', () => {
  beforeAll(async () => {
    // 物化依赖 crm.agent_sla 表存在（migrate 已建）；清空测试库该表保证幂等
    await queryWrite(`DELETE FROM crm.agent_sla`).catch(() => {});
  });
  afterAll(async () => {
    await queryWrite(`DELETE FROM crm.agent_sla`).catch(() => {});
  });

  it('物化一次：INSERT 一行，字段与聚合结果一致，raw_json 含完整快照', async () => {
    const agg = await materializeAuditabilitySla({ limit: 50, retentionDays: 0 });
    expect(agg).toHaveProperty('window');
    expect(agg).toHaveProperty('scored');
    expect(agg).toHaveProperty('auditability_pct');
    expect(agg.per_status.Q1).toHaveProperty('pass');

    // 读回最后一行核对落库字段
    const row = (await queryWrite(
      `SELECT window_size, auditability_pct, full_count, with_conflict_count, tampered_count,
              q1_pass, q3_warn, q4_pass, raw_json
       FROM crm.agent_sla ORDER BY measured_at DESC LIMIT 1`
    )).rows[0];
    expect(Number(row.window_size)).toBe(agg.window);
    // 空窗口兜底：聚合 pct=null（合法空窗口语义）→ 落库为 0（auditability_pct NOT NULL 约束）
    // 非空窗口时二者一致；此处断言「落库值 = 兜底后的 pct」而非原始 null
    expect(Number(row.auditability_pct)).toBe(agg.auditability_pct ?? 0);
    expect(row.full_count).toBe(agg.full);
    expect(row.with_conflict_count).toBe(agg.with_conflict);
    expect(row.tampered_count).toBe(agg.tampered);
    expect(row.q1_pass).toBe(agg.per_status.Q1.pass);
    expect(row.q3_warn).toBe(agg.per_status.Q3.warn);
    expect(row.q4_pass).toBe(agg.per_status.Q4.pass);
    expect(typeof row.raw_json).toBe('object'); // jsonb 解析后为对象
    expect(row.raw_json.scanned ?? row.raw_json.scored).toBeDefined();
  });

  it('retentionDays>0 软轮转：仅保留窗口内快照（不触「禁 DELETE」铁律，事实表自身轮转）', async () => {
    await materializeAuditabilitySla({ limit: 50, retentionDays: 90 });
    // 软轮转 DELETE 至 90 天内；验证 DELETE 后表仍可用且仅剩窗口内数据（此处插入超龄行验证被清）
    await queryWrite(
      `INSERT INTO crm.agent_sla (measured_at, window_size, auditability_pct, raw_json)
       VALUES (now() - interval '120 days', 1, 10.0, '{}'::jsonb)`
    );
    await materializeAuditabilitySla({ limit: 50, retentionDays: 90 });
    const cnt = (await queryWrite(
      `SELECT count(*)::int AS n FROM crm.agent_sla WHERE measured_at < now() - interval '90 days'`
    )).rows[0].n;
    expect(cnt).toBe(0); // 超龄行已被软轮转清除
  });
});