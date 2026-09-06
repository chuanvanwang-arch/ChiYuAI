// test/mcp-gateway.test.js — MCP 网关两阶段协议单测（阶段2 验收：读直连/写两阶段/决策第0闸/绝对禁删）
// 设计输入：总体设计 §6.13（对外无头暴露）+ mcp-pack-complete-plan 阶段2 验收项
// 纯逻辑用例不触 PG；集成用例（读直连 + phase2 派发）在 PG 可达时跑真实路径
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mcpWritePhase1, mcpWritePhase2, mcpReadDirect, mcpReadSensitivePhase1, mcpConfirmPhase2, mcpConfirmCancel, assertMcpAccess } from '../src/mcp/gateway.js';
import { registerAction, getAction } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { query, queryWrite } from '../src/db.js';
import { issueToken } from '../src/mcp/issueToken.js';
import { seedBillingPlans } from './helpers/seedBillingPlans.js';

// 业务通道鉴权：用 env 兜底 token 让既有「带凭证」用例保持通过（requireAuth 默认开）
let GW_TOKEN;
beforeAll(async () => {
  const { tokenPlain } = await issueToken({ actor: `gw_${Date.now()}`, roleTag: 'sales', scopes: {} });
  GW_TOKEN = tokenPlain;
  process.env.CRM_API_TOKEN = GW_TOKEN;
});
afterAll(() => { delete process.env.CRM_API_TOKEN; });

// 测试专用写 Action（不触 PG、无 scope/approval 依赖，专测 gateway→executor 派发链路）
function registerTestWriteAction() {
  registerAction({
    name: 'mcp-test-write', kind: 'write', namespace: 'mcp-test',
    description: 'MCP 网关测试专用写 Action（handler 幂等返回，无副作用）',
    handler: async (params) => ({ ok: true, echo: params?.echo || null }),
  });
}

describe('MCP 网关 · 决策第 0 闸（写两阶段 phase1）', { timeout: 20000 }, () => {
  beforeAll(() => { seedActions(); registerTestWriteAction(); });

  it('无 decision_id → 拒绝（无决策不写，第0闸）', async () => {
    const r = await mcpWritePhase1('mcp-test-write', { echo: 'no-decision' }, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
  });

  it('crm-deal-advance 无决策 → 业务提问按 to_stage 动态生成（S2→S3 等可复用）', async () => {
    // 2026-09-02 设计裁定：推进商机是通用 autoDecision Action，S2→S3 / S3→S4 / S4→S5 / S5→S6 均复用；
    // 第0闸文案不可写死「P1→P2」（P1-P6 仅方法论显示别名），须随 params.to_stage 真实跃迁。
    const r = await mcpWritePhase1('crm-deal-advance', { deal_id: 'D-TEST', to_stage: 'S3', transitionedBecause: '方案匹配完成' }, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
    expect(r.code).toBe('DECISION_NEEDED');
    expect(r.question).toContain('S3');
    expect(r.question).toContain('方案匹配');
    expect(r.question).not.toContain('P2');
  });

  it('crm-deal-advance 无决策且 to_stage 非法 → 回退通用推进文案（不误报具体阶段）', async () => {
    const r = await mcpWritePhase1('crm-deal-advance', { deal_id: 'D-TEST', to_stage: 'XXX' }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DECISION_NEEDED');
    expect(r.question).toContain('推进商机为自动决策');
    expect(r.question).not.toContain('XXX');
  });

  it('携带 decision_id → 签发 confirm_token（不执行写）', async () => {
    const r = await mcpWritePhase1('mcp-test-write', { echo: 'with-decision', decision_id: 'DEC-TEST-001' }, {});
    expect(r.ok).toBe(true);
    expect(r.confirm_token).toMatch(/^ct_/);
    expect(r.form.decision_id).toBe('DEC-TEST-001');
  });

  it('未知写 Action → 拒绝', async () => {
    const r = await mcpWritePhase1('mcp-not-exist', { decision_id: 'DEC-TEST-002' }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未知写 Action');
  });
});

describe('MCP 网关 · 写两阶段 phase2（确认执行）', { timeout: 20000 }, () => {
  beforeAll(() => { seedActions(); registerTestWriteAction(); });

  it('confirm_token 无效/过期 → 拒绝', async () => {
    const r = await mcpWritePhase2('ct_invalid_token', {}, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('confirm_expired');
  });

  it('有效 confirm_token → 经 actionExecutor 派发执行', async () => {
    const phase1 = await mcpWritePhase1('mcp-test-write', { echo: 'hello-mcp', decision_id: 'DEC-TEST-003' }, {});
    expect(phase1.ok).toBe(true);
    const r = await mcpWritePhase2(phase1.confirm_token, { echo: 'hello-mcp' }, {});
    expect(r.ok).toBe(true);
    expect(r.data?.echo).toBe('hello-mcp'); // dispatch 包装 {ok, data}
  });

  it('confirm_token 一次性消费（二次使用被拒）', async () => {
    const phase1 = await mcpWritePhase1('mcp-test-write', { echo: 'once', decision_id: 'DEC-TEST-004' }, {});
    const first = await mcpWritePhase2(phase1.confirm_token, {}, {});
    expect(first.ok).toBe(true);
    const second = await mcpWritePhase2(phase1.confirm_token, {}, {});
    expect(second.ok).toBe(false);
    expect(second.gate).toBe('confirm_expired');
  });
});

describe('MCP 网关 · 读直连（默认读放行）', { timeout: 20000 }, () => {
  beforeAll(() => { seedActions(); });

  it('data-particle-read 走真实 Action 路径（PG 可达时返回粒子数组）', async () => {
    const r = await mcpReadDirect('data-particle-read', { type: 'CRM_DEAL', limit: 5 }, {});
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true); // registry handler 返回 items 数组本身
  });

  it('未知读 Action → 拒绝', async () => {
    const r = await mcpReadDirect('mcp-read-not-exist', {}, {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未知读 Action');
  });
});

describe('MCP 网关 · 绝对禁删（安全红线）', { timeout: 20000 }, () => {
  it('Action Registry 无任何 delete/remove 工具', async () => {
    const { query: q } = await import('../src/db.js');
    // 通过工具清单检查读/写集合，无 delete
    const { buildMcpTools } = await import('../src/mcp/tools.js');
    const { tools } = buildMcpTools({ seed: true });
    const delNames = tools.filter(t => /delete|remove/.test(t.name)).map(t => t.name);
    expect(delNames).toEqual([]);
    void q;
  });
});

// ── T2 新增：confirm 弹窗构造 + 敏感读闸 + 降级短路 ──

describe('MCP 网关 · confirm 弹窗（含角色 + 切换选项）', { timeout: 20000 }, () => {
  beforeAll(() => { seedActions(); registerTestWriteAction(); });

  it('写 phase1 表单含 role + switch_options + task_id', async () => {
    const r = await mcpWritePhase1('mcp-test-write', { echo: 'f', decision_id: 'DEC-X1' }, {});
    expect(r.ok).toBe(true);
    expect(r.form.role).toBe('sales');
    expect(Array.isArray(r.form.switch_options)).toBe(true);
    expect(r.form.switch_options).toEqual(expect.arrayContaining(['sales','manager','presales','exec','finance','contract_admin']));
    expect(r.form.code).toBe('CONFIRM_REQUIRED');
  });

  it('敏感读（read_sensitive）→ CONFIRM_REQUIRED，不直接 dispatch', async () => {
    registerAction({ name: 'mcp-test-sensitive', kind: 'read_sensitive', namespace: 'mcp-test',
      handler: async () => ({ secret: 'should-not-run-yet' }) });
    const r = await mcpReadSensitivePhase1('mcp-test-sensitive', {}, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRM_REQUIRED');
    expect(r.confirm_token).toMatch(/^ct_/);
  });

  it('confirm choice=1 执行（以原角色）', async () => {
    const p1 = await mcpWritePhase1('mcp-test-write', { echo: 'confirm1', decision_id: 'DEC-X2' }, {});
    const r = await mcpConfirmPhase2(p1.confirm_token, '1', null, { echo: 'confirm1' }, {});
    expect(r.ok).toBe(true);
    expect(r.data?.echo).toBe('confirm1');
  });

  it('confirm choice=2 切换到允许角色 → 执行；切换至无权限角色 → 拒绝', async () => {
    // 切换到 manager（无 rbac 限制，放行）
    const p1 = await mcpWritePhase1('mcp-test-write', { echo: 'switch-ok', decision_id: 'DEC-X3' }, {});
    const ok = await mcpConfirmPhase2(p1.confirm_token, '2', 'manager', { echo: 'switch-ok' }, {});
    expect(ok.ok).toBe(true);
    // crm-deal-rollback 限 rbac_roles:['admin']，切到 sales 应拒
    const p2 = await mcpWritePhase1('crm-deal-rollback', { deal_id: 'D1', to_stage: 'lead', reason: 't', decision_id: 'DEC-X4' }, {});
    const denied = await mcpConfirmPhase2(p2.confirm_token, '2', 'sales', { deal_id: 'D1', to_stage: 'lead', reason: 't' }, {});
    expect(denied.ok).toBe(false);
    expect(denied.gate).toBe('permission_denied');
  });

  it('confirm choice=3 取消 → 会话作废', async () => {
    const p1 = await mcpWritePhase1('mcp-test-write', { echo: 'cancel', decision_id: 'DEC-X5' }, {});
    const c = await mcpConfirmCancel(p1.confirm_token);
    expect(c.ok).toBe(true);
    const after = await mcpConfirmPhase2(p1.confirm_token, '1', null, {}, {});
    expect(after.ok).toBe(false);
    expect(after.gate).toBe('confirm_expired');
  });
});

describe('MCP 网关 · 无凭证 + requireAuth → auth_required 硬拒绝', { timeout: 20000 }, () => {
  it('无凭证调用写 → 拒绝（不再降级 sales 放行）', async () => {
    const saved = process.env.CRM_API_TOKEN;
    delete process.env.CRM_API_TOKEN; // 模拟首次接入无 token
    try {
      const r = await mcpWritePhase1('mcp-test-write', { echo: 'deg', decision_id: 'DEC-X6' }, {});
      expect(r.ok).toBe(false);
      expect(r.gate).toBe('auth_required');
      expect(r.error).toContain('crm_login');
    } finally {
      if (saved) process.env.CRM_API_TOKEN = saved;
    }
  });

  it('无凭证调用读直连 → 拒绝', async () => {
    const saved = process.env.CRM_API_TOKEN;
    delete process.env.CRM_API_TOKEN;
    try {
      const r = await mcpReadDirect('data-particle-read', { type: 'CRM_DEAL', limit: 5 }, {});
      expect(r.ok).toBe(false);
      expect(r.gate).toBe('auth_required');
    } finally {
      if (saved) process.env.CRM_API_TOKEN = saved;
    }
  });
});

// ── 2026-09-06 交付补齐：MCP 通道套餐权益闸（mcp_access）──
// 设计依据 docs/2026-09-06-billing-gate-repair-design.md §7：mcp_access 在 gateway 层统一校验。
// 对照：free 档 entitlements=[core_crm,ai_agents,customer_360,memory]（无 mcp_access）→ 应被拒；
//       starter/pro/enterprise/local_flagship 均含 mcp_access → 应放行。
describe('MCP 网关 · 套餐权益闸 mcp_access（2026-09-06 交付）', { timeout: 20000 }, () => {
  const T_DENY = '__mcp_gate_denied';   // plan=free（无 mcp_access）
  const T_ALLOW = '__mcp_gate_allowed'; // plan=starter（含 mcp_access）
  let DENY_TOKEN; // 绑定 T_DENY 的 MCP token（令 buildMcpCtx 推导出 tenantId=T_DENY）
  beforeAll(async () => {
    await seedBillingPlans('test'); // 保证测试库 billing-plans 含 free/starter 且 free 无 mcp_access
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,'t','active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free'`, [T_DENY]);
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,'t','active','starter') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='starter'`, [T_ALLOW]);
    // 造一枚绑定 T_DENY 的 MCP 接入 token（走真实 token 解析链路，使 mcpReadDirect 等入口 ctx.tenantId=T_DENY）
    const { newStructuredToken } = await import('../src/mcp/tokenFormat.js');
    const { id, tokenPlain } = newStructuredToken();
    await queryWrite(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, role_tag, tenant_id, scopes)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, 'sales', $4, '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET tenant_id=$4`,
      [id, tokenPlain, 'mcp_gate_denied_actor', T_DENY]
    );
    DENY_TOKEN = tokenPlain;
  });
  afterAll(async () => {
    // 禁 DELETE：软清理
    await queryWrite(`UPDATE crm.tenants SET status='retired' WHERE tenant_id IN ($1,$2)`, [T_DENY, T_ALLOW]);
    await queryWrite(`UPDATE crm.mcp_identity SET revoked_at=now() WHERE actor='mcp_gate_denied_actor'`);
  });

  it('assertMcpAccess：system 平台身份恒豁免（exempt）', async () => {
    const r = await assertMcpAccess({ tenantId: 'system' });
    expect(r.ok).toBe(true);
    expect(r.exempt).toBe(true);
  });

  it('assertMcpAccess：缺 tenantId → fail-closed 拒绝（不静默放行）', async () => {
    const r = await assertMcpAccess({ tenantId: null });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('mcp_entitlement_missing_tenant');
  });

  it('assertMcpAccess：free 档（无 mcp_access）→ 拒绝并提示升级', async () => {
    const r = await assertMcpAccess({ tenantId: T_DENY });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('mcp_entitlement');
    expect(r.error).toContain('mcp_access');
  });

  it('assertMcpAccess：starter 档（含 mcp_access）→ 放行', async () => {
    const r = await assertMcpAccess({ tenantId: T_ALLOW });
    expect(r.ok).toBe(true);
  });

  it('mcpReadDirect 集成：free 档租户被 mcp_access 闸拦截', async () => {
    const r = await mcpReadDirect('data-particle-read', { type: 'CRM_DEAL', limit: 1, api_token: DENY_TOKEN }, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('mcp_entitlement');
  });

  it('mcpWritePhase1 集成：free 档租户写被 mcp_access 闸拦截（先于决策第0闸）', async () => {
    const r = await mcpWritePhase1('mcp-test-write', { echo: 'x', decision_id: 'DEC-MCP-1', api_token: DENY_TOKEN }, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('mcp_entitlement');
  });
});