// test/token-accounting.test.js — G4-T1 Token-业务因果对账（09 §5-V6）
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G4-T1
// 断言：① ensureSchema 幂等 + recordTokens 落库 ② reconcile 聚合（token vs 业务产出=audit_event 写成功数） ③ 幂等/空产出去重
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureTokenSchema, recordTokens, reconcileTokenToBusiness } from '../src/alerts/tokenAccounting.js';
import { ensureAuditSchema, recordAudit } from '../src/action/auditHook.js';
import { actionExecutor } from '../src/action/executor.js';
import { seedActions } from '../src/action/seed-actions.js';
import { query } from '../src/db.js';

async function clearTables() {
  await query(`TRUNCATE crm.token_accounting`);
  await query(`TRUNCATE crm.audit_event`);
}

describe('G4-T1 token 业务因果对账', () => {
  beforeEach(async () => {
    // 审计表先行（token 对账聚合依赖 audit_event；G1 幂等建表）
    await ensureAuditSchema();
    await ensureTokenSchema();
    await clearTables();
  });

  it('① ensureSchema 幂等 + recordTokens 落库（actor/action/tokensIn/Out）', async () => {
    // 幂等：重复 ensure 不报错
    await ensureTokenSchema();
    const r = await recordTokens({ actor: 'sales', action: 'crm-deal-advance', tokensIn: 120, tokensOut: 340, source: 'llm' });
    expect(r.ok).toBe(true);
    const rows = (await query(`SELECT * FROM crm.token_accounting`)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('sales');
    expect(rows[0].action).toBe('crm-deal-advance');
    expect(rows[0].tokens_in).toBe(120);
    expect(rows[0].tokens_out).toBe(340);
    expect(rows[0].source).toBe('llm');
  });

  it('② reconcile 聚合：烧 token vs 业务产出（audit_event 写成功数 + token 总量）', async () => {
    // 造 token 记录（2 笔 sales）
    await recordTokens({ actor: 'sales', action: 'a', tokensIn: 100, tokensOut: 200 });
    await recordTokens({ actor: 'sales', action: 'b', tokensIn: 50, tokensOut: 100 });
    // 造业务产出（audit_event 写成功 2 条 + 无关 1 条）
    await recordAudit({ target_particle_type: 'CRM_DEAL', source: 'action', action: 'crm-deal-advance:executed', actor: 'sales', decision_id: null });
    await recordAudit({ target_particle_type: 'CRM_DEAL', source: 'action', action: 'crm-deal-advance:executed', actor: 'sales', decision_id: null });
    await recordAudit({ target_particle_type: 'CRM_DEAL', source: 'action', action: 'crm-deal-advance:failed', actor: 'sales', decision_id: null });
    const r = await reconcileTokenToBusiness({ actor: 'sales' });
    // 二元组：token 总量 + 业务产出计数（写成功 audit 数）
    expect(r.tokens.total).toBe(450);
    expect(r.tokens.in).toBe(150);
    expect(r.tokens.out).toBe(300);
    expect(r.business.productivity).toBe(2);   // executed 2 条（failed 不计入产出）
    expect(r.business.audit_events).toBe(3);   // 该 actor 全部审计事件
  });

  it('③ 空产出对账：无 token/无审计 → 零值二元组（非报表静态，可观测）', async () => {
    const r = await reconcileTokenToBusiness({ actor: 'nobody' });
    expect(r.tokens.total).toBe(0);
    expect(r.tokens.in).toBe(0);
    expect(r.tokens.out).toBe(0);
    expect(r.business.productivity).toBe(0);
    expect(r.business.audit_events).toBe(0);
    expect(r.since).toBeTruthy();  // 时间窗口存在 → 可复跑
  });

  it('④ executor 写 Action 执行后 token_accounting 有行（G4-T2：ctx.tokensIn/Out 计量）', async () => {
    seedActions();  // Action 注册（无注册 getAction 返回 null，executor 提前返回）
    // 造一个轻量写 Action（data-particle-create 会真写粒子，改用一个注册的写 Action + ctx.bootstrap 豁免决策闸）
    const before = (await query(`SELECT count(*)::int AS n FROM crm.token_accounting`)).rows[0].n;
    const r = await actionExecutor.dispatch('data-particle-create',
      { type: 'CRM_DEAL', payload: { name: 'token对账-测试' } },
      { tenantId: 'system', actor: 'sales', bootstrap: true, tokensIn: 88, tokensOut: 66 });
    expect(r.ok).toBe(true);
    const rows = (await query(`SELECT * FROM crm.token_accounting WHERE actor='sales'`)).rows;
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    expect(row.action).toBe('data-particle-create');
    expect(row.tokens_in).toBe(88);
    expect(row.tokens_out).toBe(66);
    expect(row.source).toBe('llm');
  });
});