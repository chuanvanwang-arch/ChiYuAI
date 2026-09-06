// test/agent/eventTrigger.test.js
import { describe, it, expect, afterEach } from 'vitest';
import { emit } from '../../src/events/bus.js';
import {
  registerAgentEventTrigger, unregisterAgentEventTrigger,
  matchTrigger, dedupKeyFor, AGENT_EVENT_TRIGGER_DEFAULT,
} from '../../src/agent/eventTrigger.js';
import { query, queryWrite } from '../../src/db.js';

const DEAL1 = '11111111-1111-1111-1111-111111111111';
const DEAL2 = '22222222-2222-2222-2222-222222222222';
const DEFAULT_CFG = AGENT_EVENT_TRIGGER_DEFAULT;

// 事件触发为 fire-and-forget 异步（readConfig→读粒子→去重查→INSERT 串联），轮询等待避免冷启动 flaky
async function waitForTask(dedupKey, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [dedupKey]);
    if (r.rows[0].c > 0) return r.rows[0].c;
    await new Promise((res) => setTimeout(res, 50));
  }
  return 0;
}

// 种入带已知 stage 的 CRM_DEAL 粒子（去重键嵌入的是粒子当前 stage，非事件里的 stage）
async function seedDeal(id, stage) {
  await queryWrite(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, payload)
     VALUES ($1,'system','CRM_DEAL',$2,$3,$4::jsonb)
     ON CONFLICT (id) DO UPDATE SET payload=$4::jsonb`,
    [id, `deal-${id.slice(0, 4)}`, `deal ${id.slice(0, 4)}`, JSON.stringify({ stage })]
  );
}

afterEach(async () => {
  unregisterAgentEventTrigger();
  await queryWrite(`DELETE FROM crm.tasks WHERE payload->>'entity_id' IN ($1,$2)`, [DEAL1, DEAL2]);
  await queryWrite(`DELETE FROM crm.particles WHERE id IN ($1,$2)`, [DEAL1, DEAL2]);
});

describe('matchTrigger 纯函数', () => {
  it('CRM_DEAL ontology-sync → 命中 stage-progression / quote-engine / method-stage-progression', () => {
    const m = matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, DEFAULT_CFG);
    expect(m).toBeTruthy();
    expect(m.intent).toBe('stage-progression');
    expect(m.agent).toBe('quote-engine');
    expect(m.skill_slug).toBe('method-stage-progression');
  });
  it('未知实体类型 → 返回 null', () => {
    expect(matchTrigger('ontology-sync', { entity_type: 'CRM_TASK' }, DEFAULT_CFG)).toBeNull();
  });
  it('非只读 SKILL（白名单外）→ 返回 null', () => {
    const cfg = { ...DEFAULT_CFG, matrix: [{ ...DEFAULT_CFG.matrix[0], skill_slug: 'method-decision-execute' }] };
    expect(matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, cfg)).toBeNull();
  });
});

describe('dedupKeyFor', () => {
  it('含 dedup_field 时键 = {entity_id}:{intent}:{值}', () => {
    const m = DEFAULT_CFG.matrix[0];
    expect(dedupKeyFor(m, { entity_id: 'deal-1', stage: 'S4' })).toBe('deal-1:stage-progression:S4');
  });
  it('dedup_field 为 null → 键 = {entity_id}:{intent}:new', () => {
    const m = DEFAULT_CFG.matrix[2];
    expect(dedupKeyFor(m, { entity_id: 'kn-1' })).toBe('kn-1:decision-enrich:new');
  });
});

describe('注册幂等 + 集成派发（键含粒子真实 stage）', () => {
  it('emit 后队列出现 ready 任务，去重键嵌入粒子当前 stage；同键二次写不重复建单', async () => {
    await seedDeal(DEAL1, 'S4');
    registerAgentEventTrigger();
    registerAgentEventTrigger(); // 二次调用应幂等（不双订阅）
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL1, tenant_id: 'system', stage: 'S4' });
    const n1 = await waitForTask(`${DEAL1}:stage-progression:S4`);
    expect(n1).toBe(1);
    const r1 = await query(`SELECT status FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [`${DEAL1}:stage-progression:S4`]);
    expect(r1.rows[0].status).toBe('ready');
    // 同键二次写（粒子 stage 未变 → 键相同 → DB 去重抑制）
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL1, tenant_id: 'system', stage: 'S4' });
    await new Promise((r) => setTimeout(r, 350));
    const n2 = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [`${DEAL1}:stage-progression:S4`]);
    expect(n2.rows[0].c).toBe(1);
  });

  it('register 两次仅一个订阅；unregister 后事件不再建单', async () => {
    await seedDeal(DEAL2, 'S3');
    registerAgentEventTrigger();
    registerAgentEventTrigger();
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL2, tenant_id: 'system', stage: 'S3' });
    const before = await waitForTask(`${DEAL2}:stage-progression:S3`);
    expect(before).toBe(1);
    unregisterAgentEventTrigger();
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL2, tenant_id: 'system', stage: 'S3' });
    await new Promise((r) => setTimeout(r, 350));
    const after = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [`${DEAL2}:stage-progression:S3`]);
    expect(after.rows[0].c).toBe(1); // 未新增
  });
});
