// test/e2e-agent-event-trigger.test.js
// C1 事件触发派发 · 端到端回归护栏
// 覆盖全链路：ontology-sync 事件 → eventTrigger 订阅 → 矩阵匹配 → 三级防风暴 → crm.tasks ready 派发任务
// 隔离：仅删除本测试自插行（按 entity_id 过滤，非 TRUNCATE CASCADE）；一次性租户配置覆盖用 upsert 回默认（禁 DELETE）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emit } from '../src/events/bus.js';
import {
  registerAgentEventTrigger, unregisterAgentEventTrigger,
  AGENT_EVENT_TRIGGER_DEFAULT,
} from '../src/agent/eventTrigger.js';
import { query, queryWrite } from '../src/db.js';
import { writeConfig } from '../src/config/configStore.js';

const DEAL = 'e2e00000-0000-0000-0000-000000000001';
const ACC = 'e2e00000-0000-0000-0000-000000000002';
const KN = 'e2e00000-0000-0000-0000-000000000003';
const RO_TENANT = 'e2e-readonly-gate';
const SELF_IDS = [DEAL, ACC, KN];

// fire-and-forget 异步链（readConfig→读粒子→去重查→INSERT），轮询避免冷启动 flaky
async function waitForTask(dedupKey, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [dedupKey]);
    if (r.rows[0].c > 0) return r.rows[0].c;
    await new Promise((res) => setTimeout(res, 50));
  }
  return 0;
}

async function seedParticle(id, type, payload) {
  await queryWrite(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, payload)
     VALUES ($1,'system',$2,$3,$4,$5::jsonb)
     ON CONFLICT (id) DO UPDATE SET payload=$5::jsonb`,
    [id, type, `e2e-${type.slice(-4)}`, `e2e ${type}`, JSON.stringify(payload)]
  );
}

beforeEach(() => { registerAgentEventTrigger(); });

afterEach(async () => {
  unregisterAgentEventTrigger();
  // 仅清本测试自插行（按键过滤），非 TRUNCATE CASCADE
  await queryWrite(`DELETE FROM crm.tasks WHERE payload->>'entity_id' = ANY($1)`, [SELF_IDS]);
  await queryWrite(`DELETE FROM crm.particles WHERE id = ANY($1)`, [SELF_IDS]);
  // 一次性租户配置覆盖 upsert 回默认（禁 DELETE）
  await writeConfig('agent-event-trigger', AGENT_EVENT_TRIGGER_DEFAULT, { tenantId: RO_TENANT });
});

describe('E2E·全链路 happy path', () => {
  it('deal 阶段推进事件 → crm.tasks 出现 ready 派发任务，形态正确', async () => {
    await seedParticle(DEAL, 'CRM_DEAL', { stage: 'S3' });
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL, tenant_id: 'system' });
    const n = await waitForTask(`${DEAL}:stage-progression:S3`);
    expect(n).toBe(1);
    const r = await query(
      `SELECT status, payload FROM crm.tasks WHERE payload->>'dedup_key'=$1`,
      [`${DEAL}:stage-progression:S3`]
    );
    expect(r.rows[0].status).toBe('ready');
    const p = r.rows[0].payload;
    expect(p.intent).toBe('stage-progression');
    expect(p.targetAgent).toBe('quote-engine');
    expect(p.skill_slug).toBe('method-stage-progression');
    expect(p.entity_type).toBe('CRM_DEAL');
    expect(p.dispatchedFrom).toBe('intake-router');
  });
});

describe('E2E·三级防风暴（DB 去重为主）', () => {
  it('同一粒子 stage 重复事件 → 仅建单一次', async () => {
    await seedParticle(DEAL, 'CRM_DEAL', { stage: 'S3' });
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL, tenant_id: 'system' });
    await waitForTask(`${DEAL}:stage-progression:S3`);
    // 二次事件（粒子 stage 未变 → 去重键相同 → DB 去重抑制）
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL, tenant_id: 'system' });
    await new Promise((res) => setTimeout(res, 350));
    const r = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [`${DEAL}:stage-progression:S3`]);
    expect(r.rows[0].c).toBe(1);
  });
});

describe('E2E·全矩阵多实体派发', () => {
  it('CRM_ACCOUNT → funnel-classification / followup-agent', async () => {
    await seedParticle(ACC, 'CRM_ACCOUNT', { tier: 'A' });
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_ACCOUNT', entity_id: ACC, tenant_id: 'system' });
    const n = await waitForTask(`${ACC}:funnel-classification:A`);
    expect(n).toBe(1);
    const r = await query(`SELECT payload FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [`${ACC}:funnel-classification:A`]);
    expect(r.rows[0].payload.intent).toBe('funnel-classification');
    expect(r.rows[0].payload.targetAgent).toBe('followup-agent');
    expect(r.rows[0].payload.skill_slug).toBe('method-funnel-classification');
  });

  it('CRM_KNOWLEDGE → decision-enrich / decision-agent（dedup_field=null 恒 new）', async () => {
    await seedParticle(KN, 'CRM_KNOWLEDGE', {});
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_KNOWLEDGE', entity_id: KN, tenant_id: 'system' });
    const n = await waitForTask(`${KN}:decision-enrich:new`);
    expect(n).toBe(1);
    const r = await query(`SELECT payload FROM crm.tasks WHERE payload->>'dedup_key'=$1`, [`${KN}:decision-enrich:new`]);
    expect(r.rows[0].payload.intent).toBe('decision-enrich');
    expect(r.rows[0].payload.targetAgent).toBe('decision-agent');
    expect(r.rows[0].payload.skill_slug).toBe('method-decision-enrich');
  });

  it('未知实体类型 → 不建单', async () => {
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_TASK', entity_id: 'x', tenant_id: 'system' });
    await new Promise((res) => setTimeout(res, 300));
    const r = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'entity_id'='x'`);
    expect(r.rows[0].c).toBe(0);
  });
});

describe('E2E·只读闸（fail-closed）', () => {
  it('生产配置含非只读 skill_slug → 整链路拒绝建单', async () => {
    // 给一次性租户写「非只读」配置覆盖（模拟误配/越权 SKILL）
    await writeConfig('agent-event-trigger', {
      enabled: true,
      cooldown_ms: 300000,
      matrix: [{
        domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL',
        intent: 'stage-progression', agent: 'quote-engine',
        skill_slug: 'method-decision-execute', // 非只读白名单 → 必被闸拒
        dedup_field: 'payload.stage',
      }],
    }, { tenantId: RO_TENANT });

    await seedParticle(DEAL, 'CRM_DEAL', { stage: 'S3' });
    emit('ontology', 'ontology-sync', { entity_type: 'CRM_DEAL', entity_id: DEAL, tenant_id: RO_TENANT });
    await new Promise((res) => setTimeout(res, 400));
    const r = await query(`SELECT count(*)::int c FROM crm.tasks WHERE payload->>'entity_id'=$1`, [DEAL]);
    expect(r.rows[0].c).toBe(0); // 闸拒 → 零派发
  });
});
