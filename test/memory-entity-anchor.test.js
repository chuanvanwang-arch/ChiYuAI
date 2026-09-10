// test/memory-entity-anchor.test.js — A2 记忆客户锚点列（memory_log.entity_id）
// 背景（生产库 crm_native 实测 2026-09-02）：memory_log 38 行，topic 前缀仅 event:(32) / decision:(6)，
//   **无一条按客户锚定**。而两处消费方对锚点的约定还互相矛盾：
//     src/memory/memoryLog.js:71  rrfSearch  → topic = 'entity:<id>'
//     src/context/timelineSource.js:95       → topic = 'account:<id>'
//   两个约定都与实际数据形态不匹配，导致「按客户取记忆」在任何路径下都恒空。
// 解法：锚点不再编码进 topic 字符串，改由独立列 entity_id 承载，topic 回归业务分类语义。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import { appendMemory } from '../src/memory/memoryLog.js';

const TOPIC_A = 'test-anchor:entity-a';
const TOPIC_B = 'test-anchor:entity-b';

async function purge() {
  await queryWrite(`DELETE FROM crm.memory_log WHERE topic IN ($1,$2)`, [TOPIC_A, TOPIC_B]).catch(() => {});
}

beforeEach(purge);
afterEach(purge);

describe('A2-a appendMemory 写入客户锚点', () => {
  it('带 entityId 时落库 entity_id 列，topic 保持业务语义不变', async () => {
    const r = await appendMemory({
      topic: TOPIC_A,
      kind: 'event',
      entityId: 'acct-1001',
      payload: { what: '客户 CTO 明确预算需下季度审批', channel: 'call' },
      actor: 'alice',
      explicit: true,
    });
    expect(r.ok).toBe(true);

    const rows = (await query(`SELECT * FROM crm.memory_log WHERE topic=$1`, [TOPIC_A])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe('acct-1001');
    expect(rows[0].topic).toBe(TOPIC_A); // topic 不被改写成锚点格式
  });

  it('不带 entityId 时向后兼容（存量调用方零修改）', async () => {
    const r = await appendMemory({
      topic: TOPIC_B,
      kind: 'event',
      payload: { what: '系统每日扫描完成' },
      explicit: true,
    });
    expect(r.ok).toBe(true);
    const rows = (await query(`SELECT * FROM crm.memory_log WHERE topic=$1`, [TOPIC_B])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBeNull();
  });
});

