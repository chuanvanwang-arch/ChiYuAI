// test/meta-attr-actions.test.js — 元模型 3 Action（attr-read/update + field-permission）+ 白名单 + 决策场景 seed（DB 集成）
// 环境限制：需 PG@5433（沙箱无 PG 时标注环境限制，非回归；代码先落，待本机 PG 启动后验证）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { actionExecutor } from '../src/action/executor.js';
import { getAction, resetRegistry } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { isWriteWhitelisted } from '../src/action/whitelist.js';
import { seedMetaAttr, getMetaAttr } from '../src/metaAttr/metaAttrRepo.js';

beforeAll(async () => {
  await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
  resetRegistry();
  seedActions();
  await seedMetaAttr('system');
});

describe('Action 表面', () => {
  it('三个 Action 已注册', () => {
    expect(getAction('data-particle-attr-read')).not.toBeNull();
    expect(getAction('data-particle-attr-update')).not.toBeNull();
    expect(getAction('crm-field-permission')).not.toBeNull();
  });

  it('attr-update 声明 confirm=critical + namespace=data', () => {
    const a = getAction('data-particle-attr-update');
    expect(a.kind).toBe('write');
    expect(a.confirm).toBe('critical');
    expect(a.namespace).toBe('data');
  });

  it('attr-update 在对话式写白名单内', () => {
    expect(isWriteWhitelisted('data-particle-attr-update')).toBe(true);
  });
});

describe('第 0 闸（不携带 decision_id 不写）', () => {
  it('attr-update 无 decision_id 且非 bootstrap → 拒绝', async () => {
    const r = await actionExecutor.dispatch('data-particle-attr-update',
      { particle_type: 'CRM_DEAL', attr_slug: 'name', patch: { enabled: true } },
      { tenantId: 'system', actor: 'manager' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
  });

  it('attr-update 带 decision_id → 成功且 version 递增', async () => {
    const r = await actionExecutor.dispatch('data-particle-attr-update',
      { particle_type: 'CRM_ACCOUNT', attr_slug: 'name', patch: { enabled: true },
        decision_id: '00000000-0000-0000-0000-000000000001' },
      { tenantId: 'system', actor: 'manager' });
    expect(r.ok).toBe(true);
    const rec = await getMetaAttr('CRM_ACCOUNT', 'name');
    expect(rec.enabled).toBe(true);
    expect(rec.version).toBe(2);
  });
});

describe('ATTR_SCHEMA_CHANGE 场景 seed', () => {
  it('decision_scenario 已有记录（default_tier=HIGH、autonomous_allowed=false）', async () => {
    const r = await query(`SELECT scenario_id, default_tier, autonomous_allowed FROM crm.decision_scenario WHERE scenario_id='ATTR_SCHEMA_CHANGE'`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].default_tier).toBe('HIGH');
    expect(r.rows[0].autonomous_allowed).toBe(false);
  });
});