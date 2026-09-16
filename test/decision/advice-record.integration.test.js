// test/decision/advice-record.integration.test.js
// E3（2026-09-16）建议落库：crm.advice_record 的真实链路验证（不是 mock）。
//
// 覆盖三类判据：
//   正向 —— 落库/回读/采纳配对；
//   负向哨兵 —— 未定位场景不落库、fail-open 不阻断、**轴 CHECK 拒绝跨轴值**；
//   租户隔离 —— 跨租户不可互见（与既有 tenant 回退范式一致）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/db.js';
import {
  recordAdvice, listAdvice, linkAdviceToDecision, buildAdviceRecord, ADVICE_SOURCE,
} from '../../src/decision/adviceRecord.js';

const TA = 'advice-iso-a';
const TB = 'advice-iso-b';
const SCEN = 'ADV_PROBE_SCEN';

beforeAll(async () => {
  await query(`DELETE FROM crm.advice_record WHERE tenant_id IN ($1, $2)`, [TA, TB]);
});

afterAll(async () => {
  await query(`DELETE FROM crm.advice_record WHERE tenant_id IN ($1, $2)`, [TA, TB]);
});

describe('DDL 就位（防"两处写了但没跑迁移"）', () => {
  it('crm.advice_record 存在且含轴约束与配套索引', async () => {
    const cols = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='crm' AND table_name='advice_record' ORDER BY ordinal_position`
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const c of ['advice_id', 'advice_tier', 'summary', 'linked_decision_id', 'tenant_id']) {
      expect(names, `缺列 ${c} —— 迁移未执行或 DDL 未同步`).toContain(c);
    }
    const cons = await query(
      `SELECT conname FROM pg_constraint WHERE conname='ck_advice_record_tier_axis'`
    );
    expect(cons.rows.length, '缺轴约束 ck_advice_record_tier_axis').toBe(1);
    const idx = await query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='crm' AND tablename='advice_record'`
    );
    const inames = idx.rows.map((r) => r.indexname);
    expect(inames).toContain('idx_advice_record_tenant_time');
    expect(inames).toContain('idx_advice_record_unlinked');
  });
});

describe('正向：建议落库与回读', () => {
  it('recordAdvice 返回 advice_id，且摘要/档位/发起人按口径落库', async () => {
    const id = await recordAdvice(
      {
        tier: 'C', disposition: null, scenario_id: SCEN, stage: 'S2', coverage: 0.42,
        confidence: 'low', headline: 'S2 · 建议档位 C', hits: ['预算'],
        gaps: [{ cond: 'budget', label: '预算' }], reasons: [], redlines: [],
        // 故意夹带原文：实现不消费该字段，落库不得出现
        utterance: '客户要求 8 折，还要再降 10%（这句原文不得入库）',
      },
      { tenantId: TA, actor: { username: 'alice', display_name: '艾丽丝', role: 'sales' } }
    );
    expect(id).toBeTruthy();

    const rows = await listAdvice({ tenantId: TA, scenarioId: SCEN });
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.advice_tier).toBe('C');            // 轴原名落库，未跨轴改写
    expect(r.stage).toBe('S2');
    expect(r.card_confidence).toBe('low');
    expect(r.actor_id, '审计主体应取 username（唯一稳定），非可重名的 display_name').toBe('alice');
    expect(r.source).toBe(ADVICE_SOURCE);
    expect(Number(r.coverage)).toBeCloseTo(0.42, 4);
    // D2 前提：对话原文零落库
    const blob = JSON.stringify(r);
    expect(blob).not.toContain('还要再降 10%');
    expect(r.summary).toContain(SCEN);
  });

  it('采纳配对可回填，且重复回填幂等（UPDATE 覆盖，零 DELETE）', async () => {
    const id = await recordAdvice(
      { tier: 'A', disposition: 'APPROVE', scenario_id: SCEN, stage: 'S3', hits: ['预算'] },
      { tenantId: TA, actor: { username: 'alice' } }
    );
    expect(await linkAdviceToDecision(id, 'dec-0001', { tenantId: TA })).toBe(1);
    expect(await linkAdviceToDecision(id, 'dec-0002', { tenantId: TA })).toBe(1);
    const r = (await query(`SELECT linked_decision_id FROM crm.advice_record WHERE advice_id=$1`, [id])).rows[0];
    expect(r.linked_decision_id).toBe('dec-0002');
  });
});

describe('负向哨兵', () => {
  it('未定位到场景 → 不落库（不产出无观测价值的脏行）', async () => {
    const before = (await query(`SELECT count(*)::int n FROM crm.advice_record WHERE tenant_id=$1`, [TB])).rows[0].n;
    expect(await recordAdvice({ tier: 'C', scenario_id: null, hits: ['x'] }, { tenantId: TB })).toBeNull();
    expect(await recordAdvice(null, { tenantId: TB })).toBeNull();
    const after = (await query(`SELECT count(*)::int n FROM crm.advice_record WHERE tenant_id=$1`, [TB])).rows[0].n;
    expect(after).toBe(before);
  });

  it('fail-open：构造期异常不得抛出（观测写入绝不阻断建议主链路）', async () => {
    const boom = { scenario_id: 'ADV_BOOM', reasons: [{ get cond() { throw new Error('boom'); } }] };
    await expect(recordAdvice(boom, { tenantId: TB })).resolves.toBeNull();
  });

  it('轴约束：业务分级值写入建议档被数据库直接拒绝（跨轴混用的最后一道闸）', async () => {
    for (const bad of ['HIGH', 'LEAD', 'NORMAL']) {
      await expect(
        query(
          `INSERT INTO crm.advice_record (tenant_id, scenario_id, advice_tier) VALUES ($1, 'ADV_AXIS', $2)`,
          [TB, bad]
        ),
        `建议档接受了自主分级值 ${bad} —— 两轴混用`
      ).rejects.toThrow(/ck_advice_record_tier_axis|check constraint/i);
    }
  });

  it('buildAdviceRecord 为纯函数：输出不含业务分级字段，且不消费对话原文', () => {
    const rec = buildAdviceRecord(
      { tier: 'B', scenario_id: SCEN, utterance: '原文不得出现' },
      { tenantId: TA }
    );
    const keys = Object.keys(rec);
    expect(keys).not.toContain('business_tier');
    expect(keys).not.toContain('tier');
    expect(JSON.stringify(rec)).not.toContain('原文不得出现');
  });
});

describe('租户隔离', () => {
  it('A 租户读不到 B 租户的建议行', async () => {
    await recordAdvice({ tier: 'C', scenario_id: SCEN, hits: ['b-only'] }, { tenantId: TB });
    const a = await listAdvice({ tenantId: TA, scenarioId: SCEN });
    const b = await listAdvice({ tenantId: TB, scenarioId: SCEN });
    expect(b.length).toBeGreaterThan(0);
    expect(a.every((r) => r.tenant_id !== TB), 'A 租户读到了 B 租户的行 —— 隔离破坏').toBe(true);
    // 反向确证：B 的行确实带 own tenant，非"都没数据"导致的假绿
    expect(b.some((r) => r.tenant_id === TB)).toBe(true);
  });
});
