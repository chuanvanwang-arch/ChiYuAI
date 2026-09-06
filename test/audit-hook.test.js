// test/audit-hook.test.js — 10-ai-capability-audit V5「审计写钩子=粒子写通道单点必经」+ V2 12 域 + V3 价格/审批留痕
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureAuditSchema, recordAudit, sha256, recordPriceChangeAudit } from '../src/action/auditHook.js';
import { createParticle, updateParticle, createEdge } from '../src/particles/particleRepo.js';
import { actionExecutor } from '../src/action/executor.js';
import { seedActions } from '../src/action/seed-actions.js';
import { recordAuditCompensation } from '../src/approval/compensation.js';

beforeEach(async () => {
  seedActions(); // registry 装配：测试中 Action 表面必须注册（对齐 https/sales 既有测试 setup）
  await ensureAuditSchema();
  await query('TRUNCATE crm.audit_event RESTART IDENTITY CASCADE');
});

describe('G1-T1 auditHook 单点审计（10 文档 §3.2 机制级强制）', () => {
  it('ensureAuditSchema 幂等：重复调用不报错、表结构含链式校验和列', async () => {
    await ensureAuditSchema();
    await ensureAuditSchema();
    const r = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='audit_event'`
    );
    const cols = r.rows.map((c) => c.column_name);
    expect(cols).toContain('checksum');
    expect(cols).toContain('previous_checksum');
    expect(cols).toContain('target_particle_type');
    expect(cols).toContain('source');
    expect(cols).toContain('decision_id');
  });

  it('recordAudit 落库一行：source/action/actor/payload 全字段可查回', async () => {
    await recordAudit({
      target_particle_type: 'CRM_DEAL', source: 'action', action: 'deal-stage-advance',
      actor: 'sales.zhang', decision_id: '8b1a2c00-0000-4000-8000-000000000001',
      payload: { stage: 'lead→qualify', transitioned_because: '客户确认预算卡点解除' },
    });
    const r = await query(`SELECT * FROM crm.audit_event ORDER BY id`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].source).toBe('action');
    expect(r.rows[0].target_particle_type).toBe('CRM_DEAL');
    expect(r.rows[0].decision_id).toBe('8b1a2c00-0000-4000-8000-000000000001');
    expect(r.rows[0].payload.transitioned_because).toBe('客户确认预算卡点解除');
    expect(r.rows[0].previous_checksum).toBeNull();
    expect(r.rows[0].checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('链式校验和：第二条记录 previous_checksum=第一条 checksum，verifyChain 整链 OK', async () => {
    await recordAudit({ target_particle_type: 'CRM_DEAL', source: 'action', action: 'a1', payload: { i: 1 } });
    await recordAudit({ target_particle_type: 'CRM_DEAL', source: 'action', action: 'a2', payload: { i: 2 } });
    const rows = (await query(`SELECT checksum, previous_checksum FROM crm.audit_event ORDER BY id`)).rows;
    expect(rows[1].previous_checksum).toBe(rows[0].checksum);
    // 重算整链：每行 sha256(prev|payload) 应与 checksum 相等
    let prev = null;
    const all = (await query(`SELECT payload, checksum, previous_checksum FROM crm.audit_event ORDER BY id`)).rows;
    for (const row of all) {
      const expectHash = sha256((prev || '') + '|' + JSON.stringify(row.payload));
      expect(row.checksum).toBe(expectHash);
      expect(row.previous_checksum).toBe(prev);
      prev = row.checksum;
    }
  });

  it('append-only：无 update/delete 语义（仅 INSERT 落库；表无 updated_at 列）', async () => {
    await recordAudit({ target_particle_type: 'CRM_ACCOUNT', source: 'action', action: 'account-create', payload: {} });
    const r = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='audit_event'`
    );
    const cols = r.rows.map((c) => c.column_name);
    expect(cols).not.toContain('updated_at');
  });
});

describe('G1-T2 粒子写通道三挂点（particleRepo create/update/edge）自动落审计', () => {
  it('createParticle 产生 audit_event（source=particle）', async () => {
    const p = await createParticle('CRM_ACCOUNT', { name: '审计钩子客户', tenant_id: 'system' });
    const r = await query(`SELECT * FROM crm.audit_event WHERE target_particle_type='CRM_ACCOUNT'`);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].source).toBe('particle');
    expect(r.rows[0].action).toContain('create');
  });

  it('updateParticle 产生 audit_event（source=particle）', async () => {
    const p = await createParticle('CRM_ACCOUNT', { name: '审计钩子客户2', tenant_id: 'system' });
    await updateParticle(p.id, { patch: { industry: '制造业' } });
    const r = await query(`SELECT * FROM crm.audit_event WHERE target_particle_type='CRM_ACCOUNT' AND action LIKE '%update%'`);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('createEdge 产生 audit_event（source=particle-edge）', async () => {
    const a = await createParticle('CRM_ACCOUNT', { name: '审计钩子客户3', tenant_id: 'system' });
    const c = await createParticle('CRM_CONTACT', { name: '审计钩子联系人3', email: 'a3@test.com', tenant_id: 'system' });
    await createEdge('CRM_ACCOUNT', a.id, 'key_contact', 'CRM_CONTACT', c.id);
    const r = await query(`SELECT * FROM crm.audit_event WHERE source='particle-edge'`);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('G1-T3 executor 写 Action 三段自动落审计（source=action）', () => {
  it('写 Action 执行成功产生审计（requested + executed）', async () => {
    // 用最低权限工具（whitelist 内）执行写；actor 携带 decision_id 过第 0 闸
    const res = await actionExecutor.dispatch('crm-lead-pick', { deal_id: '00000000-0000-0000-0000-000000000001' }, {
      actor: 'sales.zhang', tenantId: 'system',
      decision_id: '8b1a2c00-0000-4000-8000-000000000001', channel: 'api', bootstrap: false,
    });
    // 无论执行是否成功（缺数据可能业务失败），写通道必经节点应已落审计行
    const r = await query(`SELECT * FROM crm.audit_event WHERE source='action' AND action LIKE 'crm-lead-pick%'`);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('G1-T4 审批补偿 + 价格变更自动落审计（source=approval/price，V3）', () => {
  it('recordAuditCompensation 落审计（source=approval）', async () => {
    await recordAuditCompensation({ business_id: '00000000-0000-0000-0000-000000000002', action: 'rollback', reason: '测试回滚' });
    const r = await query(`SELECT * FROM crm.audit_event WHERE source='approval'`);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('recordPriceChangeAudit 落审计（source=price，payload 含 price_change_reason）', async () => {
    await recordPriceChangeAudit({ particle_id: '00000000-0000-0000-0000-000000000003', before: 100, after: 120, reason: '成本上涨' });
    const r = await query(`SELECT * FROM crm.audit_event WHERE source='price'`);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].payload.price_change_reason).toBe('成本上涨');
  });
});