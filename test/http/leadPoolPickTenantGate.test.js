// test/http/leadPoolPickTenantGate.test.js — 公海认领的**租户闸两层一致性**守卫
//
// 背景（2026-09-18 实测修复）：
//   `POST /api/lead-pool/:id/pick`（REST 端点）与 `POST /api/action/crm-lead-pick`（Action 通道）
//   是同一动作的两条入口，却给出**相反**结论：
//     · 端点侧 `routes.js` 用 `!me.tenantId || me.tenantId === 'system'` 一刀切 → 显式 system 租户 400；
//     · Action 侧 `executor.js` 第 1.7 闸「显式 system 租户恒全权益」→ 200 成功。
//   根因：`resolveMe` 把「缺租户」兜底成 'system'，使调用方**无法区分**二者，只能一刀切。
//   后果：本地演示环境的业务租户（alice/manager/zimeng 皆属 system）看得到 12 条公海却认领不了
//        （全库 S0P = 0），需求①「公海线索可认领也可回退」闭环从未执行；前台认领走 REST、回退走
//        Action，同页两对称动作通道不一致。
//   修法：`resolveMe` 增 `hasExplicitTenant`（token 是否真的带 tenantId）；端点只拦「缺租户」，
//        显式 system 放行 —— 与 Action 层对齐（`planGate.e2e.test.js`「system 租户豁免权益闸」）。
//
// 本测试的**核心断言**：#4「两层闸同结论」——防端点与 Action 再次各自漂移。
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { actionExecutor } from '../../src/action/executor.js';

const app = createApp();
seedActions();

const mkDeal = (tenantId, name, stage = 'S0') =>
  queryWrite(
    `INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
     VALUES ($1, 'CRM_DEAL', 'crm-deal', $2, 'ACTIVE', $3::jsonb, NULL) RETURNING id`,
    [tenantId, name, JSON.stringify({ name, stage, source: 'gate-test', pool_type: 'new', owner_id: null })]
  );

const pickViaEndpoint = (id, tok) =>
  app.fetch(`/api/lead-pool/${id}/pick`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
  });

const pickViaAction = (id, ctx) =>
  actionExecutor.dispatch('crm-lead-pick', { deal_id: id, owner_id: 'gate-tester' }, { actor: 'gate-tester', channel: 'http', ...ctx });

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('resolveMe.hasExplicitTenant：区分「显式 system」与「缺租户」', () => {
  it('显式 system 租户 → hasExplicitTenant=true；缺 tenantId → false（且 tenantId 仍兜底 system）', async () => {
    const { resolveMe } = await import('../../src/http/auth.js');
    const explicit = resolveMe({ headers: { authorization: `Bearer ${issueToken({ username: 'u', role: 'sales', tenantId: 'system' })}` } });
    const missing = resolveMe({ headers: { authorization: `Bearer ${issueToken({ username: 'u', role: 'sales' })}` } });

    expect(explicit.tenantId).toBe('system');
    expect(explicit.hasExplicitTenant).toBe(true);

    // 兜底行为保持不变（向后兼容既有调用方），但**可被区分**
    expect(missing.tenantId).toBe('system');
    expect(missing.hasExplicitTenant).toBe(false);
  });
});

describe('POST /api/lead-pool/:id/pick 的租户闸', () => {
  it('显式 system 租户可认领（S0→S0P）—— 修前此处 400，前台「可看不可领」', async () => {
    const tok = issueToken({ username: 'sys_sales', role: 'sales', tenantId: 'system' });
    const id = (await mkDeal('system', 'sys-pool-deal')).rows[0].id;

    const r = await pickViaEndpoint(id, tok);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);

    const after = (await query(`SELECT payload->>'stage' AS stage, payload->>'owner_id' AS owner FROM particles WHERE id=$1`, [id])).rows[0];
    expect(after.stage).toBe('S0P');
    expect(after.owner).toBe('sys_sales');
  });

  it('缺租户（token 无 tenantId）→ 400 fail-closed（不静默获得 system 全权益）', async () => {
    const tok = issueToken({ username: 'ghost', role: 'sales' }); // 无 tenantId
    const id = (await mkDeal('system', 'ghost-pool-deal')).rows[0].id;

    const r = await pickViaEndpoint(id, tok);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBe('plan_entitlement_missing_tenant');

    // 反向：绝不能被认领
    const after = (await query(`SELECT payload->>'stage' AS stage FROM particles WHERE id=$1`, [id])).rows[0];
    expect(after.stage).toBe('S0');
  });

  it('真实业务租户可认领（回归保护：修法不得误伤正常租户）', async () => {
    const tok = issueToken({ username: 'biz_sales', role: 'sales', tenantId: 'tBiz' });
    const id = (await mkDeal('tBiz', 'biz-pool-deal')).rows[0].id;

    const r = await pickViaEndpoint(id, tok);
    expect(r.status).toBe(200);
    const after = (await query(`SELECT payload->>'stage' AS stage FROM particles WHERE id=$1`, [id])).rows[0];
    expect(after.stage).toBe('S0P');
  });
});

describe('两层闸一致性（核心守卫：防端点与 Action 再次各自漂移）', () => {
  it('显式 system 租户：端点与 Action 通道同结论（均放行）', async () => {
    const tok = issueToken({ username: 'sys2', role: 'sales', tenantId: 'system' });
    const ids = [(await mkDeal('system', 'consist-a')).rows[0].id, (await mkDeal('system', 'consist-b')).rows[0].id];

    const ep = await pickViaEndpoint(ids[0], tok);
    const ac = await pickViaAction(ids[1], { tenantId: 'system' });

    expect(ep.status).toBe(200);
    expect(ac.ok).toBe(true);
    expect(ep.status === 200).toBe(ac.ok === true); // 同结论
  });

  it('缺租户：端点与 Action 通道同结论（均 fail-closed，且同一 gate 名）', async () => {
    const tok = issueToken({ username: 'ghost2', role: 'sales' });
    const ids = [(await mkDeal('system', 'consist-c')).rows[0].id, (await mkDeal('system', 'consist-d')).rows[0].id];

    const ep = await pickViaEndpoint(ids[0], tok);
    const ac = await pickViaAction(ids[1], { tenantId: null });

    expect(ep.status).toBe(400);
    const epBody = await ep.json();
    expect(ac.ok).toBe(false);
    // 两层必须报**同一个**闸名，否则上游无法归因
    expect(epBody.gate).toBe('plan_entitlement_missing_tenant');
    expect(ac.gate).toBe('plan_entitlement_missing_tenant');
  });
});
