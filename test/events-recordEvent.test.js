// test/events-recordEvent.test.js — A1 统一事件落库通道（L0 原始轨迹层）
// 背景：生产库 crm.events 恒 0 行，全仓仅 2 处裸 INSERT（ontology/hooks.js:117、
//   particles/interactionIndex.js:44），且均为 .catch(()=>{}) 静默吞错。
//   Lightfield 的 ground truth = raw 轨迹，events 是唯一原料层，缺它则故事线/回填全空转。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import { buildEventPayload, recordEvent, isAnchoredPayload } from '../src/events/recordEvent.js';

const TEST_DOMAIN = 'test-record-event';

async function purge() {
  await queryWrite(`DELETE FROM crm.events WHERE domain=$1`, [TEST_DOMAIN]).catch(() => {});
}

beforeEach(purge);
afterEach(purge);

describe('A1-a buildEventPayload 纯函数', () => {
  it('有客户锚点时写入 entity_id 且不标 unanchored', () => {
    const p = buildEventPayload({ entityId: 'a-1', entityType: 'CRM_ACCOUNT', rawText: '客户说预算下季度才批' });
    expect(p.entity_id).toBe('a-1');
    expect(p.entity_type).toBe('CRM_ACCOUNT');
    expect(p.raw_text).toBe('客户说预算下季度才批');
    expect(p.unanchored).toBeUndefined();
  });

  it('无客户锚点时显式标记 unanchored（可观测，不静默丢失）', () => {
    const p = buildEventPayload({ entityId: null, rawText: '系统内部事件' });
    expect(p.entity_id).toBeUndefined();
    expect(p.unanchored).toBe(true);
  });

  it('extra 不得覆盖保留键（entity_id/raw_text/tenant_id 优先）', () => {
    const p = buildEventPayload({
      entityId: 'real-1',
      rawText: '真实原话',
      extra: { entity_id: 'spoofed', raw_text: '伪造原话', foo: 'bar' },
    });
    expect(p.entity_id).toBe('real-1');
    expect(p.raw_text).toBe('真实原话');
    expect(p.foo).toBe('bar');
  });

  it('isAnchoredPayload 判定与锚点一致', () => {
    expect(isAnchoredPayload(buildEventPayload({ entityId: 'a-1' }))).toBe(true);
    expect(isAnchoredPayload(buildEventPayload({}))).toBe(false);
  });
});

describe('A1-b recordEvent 落库', () => {
  it('落库后 events 出现该行，payload 含 entity_id 与 raw_text', async () => {
    const r = await recordEvent({
      domain: TEST_DOMAIN,
      type: 'call-recorded',
      entityId: 'a-1',
      entityType: 'CRM_ACCOUNT',
      rawText: '客户：预算要下季度才批，但安全问题更急',
      actor: 'alice',
      payload: { channel: 'call' },
    });
    expect(r.ok).toBe(true);
    expect(r.anchored).toBe(true);

    const rows = (await query(`SELECT * FROM crm.events WHERE domain=$1`, [TEST_DOMAIN])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('call-recorded');
    expect(rows[0].actor).toBe('alice');
    expect(rows[0].payload.entity_id).toBe('a-1');
    expect(rows[0].payload.raw_text).toContain('预算要下季度');
    expect(rows[0].payload.channel).toBe('call');
  });

  it('domain 或 type 缺失时拒绝落库并返回码（不抛异常）', async () => {
    const r1 = await recordEvent({ domain: null, type: 'x' });
    expect(r1.ok).toBe(false);
    expect(r1.code).toBe('missing_identity');
    const rows = (await query(`SELECT * FROM crm.events WHERE domain=$1`, [TEST_DOMAIN])).rows;
    expect(rows).toHaveLength(0);
  });

  it('无锚点事件也落库，但 anchored=false（系统事件不该伪造客户锚点）', async () => {
    const r = await recordEvent({ domain: TEST_DOMAIN, type: 'system-scan', rawText: '每日扫描完成' });
    expect(r.ok).toBe(true);
    expect(r.anchored).toBe(false);
    const rows = (await query(`SELECT * FROM crm.events WHERE domain=$1`, [TEST_DOMAIN])).rows;
    expect(rows[0].payload.unanchored).toBe(true);
  });
});
