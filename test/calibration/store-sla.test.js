// D6 SLA 计算与升级扫描单测（mock db；Task B）
// 设计：docs/2026-09-14-d6-calibration-approval-flow-plan.md Task B。
// scanEscalations 仅置 escalated + 写追加日志，绝不改 status / 不触 apply 写通道（守 HITL 铁律）。
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/db.js', () => ({ query: vi.fn(), withTx: async (fn) => fn({ query: vi.fn() }) }));
const db = await import('../../src/db.js');
const { SLA_HOURS, slaDueAt, scanEscalations, createPatch } = await import('../../src/calibration/store.js');

describe('D6 SLA 计算', () => {
  it('SLA_HOURS 风险映射', () => {
    expect(SLA_HOURS).toEqual({ HIGH: 24, MEDIUM: 72, LOW: 168 });
  });

  it('slaDueAt 返回 created_at + 风险窗口', () => {
    const base = new Date('2026-09-14T00:00:00Z');
    const due = slaDueAt('HIGH', base);
    expect(new Date(due).getTime() - base.getTime()).toBe(24 * 3600 * 1000);
  });

  it('createPatch 落库并入 sla_due_at（参数位 $12）', async () => {
    db.query
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ patch_id: 'p1' }] });
    const r = await createPatch({
      knob: 'threshold', target: 'threshold', from_value: { threshold: 0.8 },
      to_value: { threshold: 0.7 }, evidence: { source: 't' }, risk: 'HIGH',
    });
    expect(r).toEqual({ patch_id: 'p1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('sla_due_at');
    expect(params.length).toBe(12);              // 原 11 参 + sla_due_at
    expect(params[11]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 时点
  });
});

describe('D6 超时升级扫描', () => {
  it('翻转超时 PENDING 并写日志', async () => {
    db.query
      .mockReset()
      .mockResolvedValueOnce({ rows: [{ patch_id: 'p1', risk: 'HIGH' }] }) // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] });                                // INSERT log
    const r = await scanEscalations();
    expect(r.escalated).toBe(1);
    const upd = db.query.mock.calls[0][0];
    expect(upd).toContain('SET escalated=true');
    expect(upd).toContain("status='PENDING'");
    expect(upd).toContain('sla_due_at < now()');
    expect(upd).toContain('escalated=false');
    const ins = db.query.mock.calls[1][0];
    expect(ins).toContain('calibration_escalation_log');
  });

  it('无超时项 → 0 翻转、无日志写', async () => {
    db.query.mockReset().mockResolvedValueOnce({ rows: [] });
    const r = await scanEscalations();
    expect(r.escalated).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('绝不改 status（SET 子句仅 escalated，不写 status）', async () => {
    db.query.mockReset().mockResolvedValueOnce({ rows: [] });
    await scanEscalations();
    const upd = db.query.mock.calls[0][0];
    expect(upd).toContain('SET escalated=true');
    // status 仅出现在 WHERE 过滤（PENDING 才可升级），绝不出现在 SET 赋值（状态机未动）
    const setPart = upd.split('WHERE')[0];
    expect(setPart).not.toContain('status');
    expect(upd).toContain("status='PENDING'");
  });
});
