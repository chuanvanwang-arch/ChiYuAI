// test/backfill-attribute.test.js — A4 属性回填（backfill）通道
// 背景（Lightfield 落地方案 C1 / §7.2 A4）：
//   Lightfield 的 schema-less 成立依赖后半句能力——
//     "making it possible to arbitrarily generate values for it any time...
//      If you've spoken about it in your conversations, it's easy enough to backfill."
//   本项目 meta_attr 支持「写时自适应登记」= 能后贴 schema，但**没有回填**：
//   属性登记晚于数据产生时，历史数据永远补不回来（identity 指纹漂移类缺陷的深层根因）。
//   回填的前提是 raw 轨迹常驻（A1 已建 events 写入通道），本模块补上后半句。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import { mineBackfillCandidates, backfillAttribute } from '../src/ontology/backfill.js';
import { recordEvent } from '../src/events/recordEvent.js';

// particles.id 为 UUID，故用 UUID 形态的测试 id（便于直接断言 payload）
const ACC = '77770001-0000-0000-0000-000000000001';
const OTHER = '77770002-0000-0000-0000-000000000002';
const EV_DOMAIN = 'test-backfill';
const MEM_TOPIC = 'backfill:decision_power';

async function purge() {
  await queryWrite(`DELETE FROM crm.events WHERE domain=$1`, [EV_DOMAIN]).catch(() => {});
  await queryWrite(`DELETE FROM crm.memory_log WHERE topic=$1`, [MEM_TOPIC]).catch(() => {});
  await queryWrite(`DELETE FROM crm.particles WHERE id IN ($1,$2)`, [ACC, OTHER]).catch(() => {});
}

beforeEach(purge);
afterEach(purge);

async function seedParticles() {
  await queryWrite(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload) VALUES
     ($1,'system','CRM_ACCOUNT','acct-a','客户A','active','{"name":"客户A"}'::jsonb),
     ($2,'system','CRM_ACCOUNT','acct-b','客户B','active','{"name":"客户B"}'::jsonb)`,
    [ACC, OTHER]
  );
}

describe('A4-a mineBackfillCandidates 纯函数（候选挖掘）', () => {
  it('只有「有 raw_text 且有客户锚点」的事件才是候选', () => {
    const events = [
      { id: 'e1', entity_id: ACC, raw_text: '客户说决策权在王总手上', created_at: '2026-01-02' },
      { id: 'e2', entity_id: ACC, raw_text: null, created_at: '2026-01-03' },          // 无原话 → 不可回填
      { id: 'e3', entity_id: null, raw_text: '无锚点的原话', created_at: '2026-01-04' }, // 无锚点 → 定位不到粒子
    ];
    const r = mineBackfillCandidates(events, { keywords: ['决策权'] });
    expect(r.candidates.map((c) => c.eventId)).toEqual(['e1']);
    expect(r.stats.noRawText).toBe(1);
    expect(r.stats.unanchored).toBe(1);
  });

  it('关键词不匹配的不进候选（避免全量回填噪声）', () => {
    const events = [
      { id: 'e1', entity_id: ACC, raw_text: '聊了天气', created_at: '2026-01-02' },
      { id: 'e2', entity_id: ACC, raw_text: '王总有决策权', created_at: '2026-01-01' },
    ];
    const r = mineBackfillCandidates(events, { keywords: ['决策权', '决策人'] });
    expect(r.candidates.map((c) => c.eventId)).toEqual(['e2']);
    expect(r.candidates[0].matched).toContain('决策权');
  });

  it('候选按时间倒序（最近的证据优先回填）', () => {
    const events = [
      { id: 'old', entity_id: ACC, raw_text: '决策权在王总', created_at: '2026-01-01' },
      { id: 'new', entity_id: ACC, raw_text: '决策权已转到李总', created_at: '2026-03-01' },
    ];
    const r = mineBackfillCandidates(events, { keywords: ['决策权'] });
    expect(r.candidates[0].eventId).toBe('new');
  });
});

describe('A4-b backfillAttribute 落库回填', () => {
  it('从历史原话回填属性值到粒子 payload', async () => {
    await seedParticles();
    await recordEvent({
      domain: EV_DOMAIN, type: 'call-recorded', entityId: ACC, entityType: 'CRM_ACCOUNT',
      rawText: '客户明确：决策权在王总手上',
    });

    const r = await backfillAttribute({
      attrKey: 'decision_power',
      keywords: ['决策权'],
      extractor: (rawText) => (rawText.includes('王总') ? '王总' : null),
    });

    expect(r.ok).toBe(true);
    expect(r.stats.applied).toBe(1);
    const p = (await query(`SELECT payload FROM crm.particles WHERE id=$1`, [ACC])).rows[0];
    expect(p.payload.decision_power).toBe('王总');
  });

  it('回填留痕可审计（写 memory_log，含来源事件与旧值）', async () => {
    await seedParticles();
    await recordEvent({
      domain: EV_DOMAIN, type: 'call-recorded', entityId: ACC, entityType: 'CRM_ACCOUNT',
      rawText: '客户明确：决策权在王总手上',
    });

    await backfillAttribute({
      attrKey: 'decision_power',
      keywords: ['决策权'],
      extractor: () => '王总',
    });

    const logs = (await query(`SELECT * FROM crm.memory_log WHERE topic=$1`, [MEM_TOPIC])).rows;
    expect(logs).toHaveLength(1);
    expect(logs[0].entity_id).toBe(ACC);
    expect(logs[0].payload.attr_key).toBe('decision_power');
    expect(logs[0].payload.new_value).toBe('王总');
    expect(logs[0].payload.from_event_id).toBeTruthy();
  });

  it('反假绿：抽不到值不写 payload，但必须留痕 skipped（不静默）', async () => {
    await seedParticles();
    await recordEvent({
      domain: EV_DOMAIN, type: 'call-recorded', entityId: ACC, entityType: 'CRM_ACCOUNT',
      rawText: '客户明确：决策权在王总手上',
    });

    const r = await backfillAttribute({
      attrKey: 'decision_power',
      keywords: ['决策权'],
      extractor: () => null, // 抽不到
    });

    expect(r.stats.applied).toBe(0);
    expect(r.stats.skipped).toBe(1);
    const p = (await query(`SELECT payload FROM crm.particles WHERE id=$1`, [ACC])).rows[0];
    expect(p.payload.decision_power).toBeUndefined(); // 不写脏值
    const logs = (await query(`SELECT * FROM crm.memory_log WHERE topic=$1`, [MEM_TOPIC])).rows;
    expect(logs).toHaveLength(1);
    expect(logs[0].payload.result).toBe('skipped');
  });

  it('其它客户的原话不会回填到本客户（锚点隔离）', async () => {
    await seedParticles();
    await recordEvent({
      domain: EV_DOMAIN, type: 'call-recorded', entityId: OTHER, entityType: 'CRM_ACCOUNT',
      rawText: '决策权在张总',
    });

    await backfillAttribute({
      attrKey: 'decision_power',
      keywords: ['决策权'],
      extractor: () => '张总',
    });

    const a = (await query(`SELECT payload FROM crm.particles WHERE id=$1`, [ACC])).rows[0];
    expect(a.payload.decision_power).toBeUndefined();
    const b = (await query(`SELECT payload FROM crm.particles WHERE id=$1`, [OTHER])).rows[0];
    expect(b.payload.decision_power).toBe('张总');
  });
});
