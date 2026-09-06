// test/timeline-anchor.test.js — A3 故事线按客户锚点取数（events / memory_log 两源）
// 背景（生产库 crm_native 实测 2026-09-02）：故事线四源中三源实际为空
//   events 0 行 / tasks 0 行 / memory_log 恒空（topic 无客户锚定）→ 故事线只剩 decision 一源。
// 本轮修两处锚点约定：
//   ① memory 源：topic='account:<id>' → memory_log.entity_id 列（A2 新增）
//   ② events 源：payload->>'account_id' → payload->>'entity_id'（对齐 A1 recordEvent 的写入形态）
// 反假绿：不同客户的记忆/事件不得串入同一条故事线。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queryWrite } from '../src/db.js';
import { retrieveTimeline, buildTimelineRows, formatTimelineRow } from '../src/context/timelineSource.js';
import { recordEvent } from '../src/events/recordEvent.js';
import { appendMemory } from '../src/memory/memoryLog.js';

const ACC = 'tl-acct-9001';
const OTHER = 'tl-acct-9002';
const EV_DOMAIN = 'test-timeline-anchor';
const MEM_TOPIC = 'test-timeline:memory';

async function purge() {
  await queryWrite(`DELETE FROM crm.events WHERE domain=$1`, [EV_DOMAIN]).catch(() => {});
  await queryWrite(`DELETE FROM crm.memory_log WHERE topic=$1`, [MEM_TOPIC]).catch(() => {});
}

beforeEach(purge);
afterEach(purge);

describe('A3-a events 源按 entity_id 锚点抽取', () => {
  it('recordEvent 写入的事件能被故事线按客户抽到（写入与读取形态一致）', async () => {
    await recordEvent({
      domain: EV_DOMAIN,
      type: 'call-recorded',
      entityId: ACC,
      entityType: 'CRM_ACCOUNT',
      rawText: '客户 CTO：安全问题比预算更急，预算要下季度',
      payload: { title: '客户电话：安全优先于预算' },
    });

    const rows = await retrieveTimeline({ accountId: ACC });
    const hit = rows.filter((r) => r.type === 'event');
    expect(hit.length).toBe(1);
    expect(hit[0].title).toBe('客户电话：安全优先于预算');
  });

  it('其它客户的事件不串入本客户故事线', async () => {
    await recordEvent({
      domain: EV_DOMAIN, type: 'call-recorded', entityId: OTHER,
      entityType: 'CRM_ACCOUNT', payload: { title: '别家客户的电话' },
    });
    const rows = await retrieveTimeline({ accountId: ACC });
    expect(rows.filter((r) => r.type === 'event')).toHaveLength(0);
  });
});

describe('A3-b memory 源按 entity_id 列抽取', () => {
  it('带锚点的记忆能被故事线抽到（原 topic 前缀约定恒空）', async () => {
    await appendMemory({
      topic: MEM_TOPIC, kind: 'event', entityId: ACC,
      payload: { title: '客户关心安全合规', what: 'CTO 强调安全问题' },
      actor: 'alice', explicit: true,
    });

    const rows = await retrieveTimeline({ accountId: ACC });
    const hit = rows.filter((r) => r.type === 'memory');
    expect(hit.length).toBe(1);
    expect(hit[0].title).toBe('客户关心安全合规');
  });

  it('同一客户的多条记忆不被同秒去重吞掉（去重键须为记录 id 而非客户 id）', async () => {
    // 连写两条同客户记忆，created_at 极可能落在同一秒
    await appendMemory({
      topic: MEM_TOPIC, kind: 'event', entityId: ACC,
      payload: { title: '记忆一' }, explicit: true,
    });
    await appendMemory({
      topic: MEM_TOPIC, kind: 'event', entityId: ACC,
      payload: { title: '记忆二' }, explicit: true,
    });

    const rows = await retrieveTimeline({ accountId: ACC });
    const mem = rows.filter((r) => r.type === 'memory');
    // 反假绿：若去重键误用客户 id，同秒两条会被吞成一条
    expect(mem.length).toBe(2);
    expect(buildTimelineRows(mem.map((r) => ({ ...r, entityId: r.entityId })))).toHaveLength(2);
  });

  it('其它客户的记忆不串入本客户故事线', async () => {
    await appendMemory({
      topic: MEM_TOPIC, kind: 'event', entityId: OTHER,
      payload: { title: '别家客户的记忆' }, explicit: true,
    });
    const rows = await retrieveTimeline({ accountId: ACC });
    expect(rows.filter((r) => r.type === 'memory')).toHaveLength(0);
  });
});

describe('A3-c 故事线渲染', () => {
  it('多源混合后仍按时间倒序，且可渲染为可读文本', async () => {
    await recordEvent({
      domain: EV_DOMAIN, type: 'call-recorded', entityId: ACC,
      entityType: 'CRM_ACCOUNT', payload: { title: '客户电话' },
    });
    await appendMemory({
      topic: MEM_TOPIC, kind: 'event', entityId: ACC,
      payload: { title: '客户记忆' }, explicit: true,
    });

    const rows = await retrieveTimeline({ accountId: ACC });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].ts >= rows[i].ts).toBe(true);
    }
    const text = formatTimelineRow(rows[0]);
    expect(text).toContain('｜');
  });
});
