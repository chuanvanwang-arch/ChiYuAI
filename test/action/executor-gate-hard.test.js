// test/action/executor-gate-hard.test.js — Task 5：STAGE_GATES P4→P5/P5→P6 升级 hard + 商机三要素闸 C6
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §3
// 语义（用户已确认「渐进硬化」+「沿用现有证据通道+闸内兜底」）：
//   C4：P4→P5 升级 hard（缺口可拦截；contract_no/signed_at/order_date 任一存在即放行）
//   C5：P5→P6 升级 hard（缺口可拦截；合同签署+全款事实任一存在即放行）
//   C6：data-particle-create 建 CRM_DEAL 非 lead → 三要素（bantcc.*）闸
// 判据分层：C4/C5 走 salesStageGate 纯函数；C6 走 salesDealPrereq 纯函数（零 DB，与既有测试模式一致）；
//    dispatch 集成用例仅验证接线（mock DB 依赖，不经真实 handler 落库）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { salesStageGate, salesDealPrereq } from '../../src/action/executor.js';

describe('executor C4/C5 hard 升级', () => {
  it('S4→S5 无 review-gate 通过且无合同事实 -> 拦截（hard）', () => {
    const r = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: {} });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
    expect(r.gaps.some(g => g.includes('review-gate'))).toBe(true);
  });
  it('S4→S5 有合同签署事实 + 强制附件 -> 放行（证据兜底）', () => {
    const r = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: { contract_no: 'HT-001', attachments: [{ tag: 'customer_approval_screenshot', name: '客户审批截图', url: 'y' }] } });
    expect(r.ok).toBe(true);
  });
  it('S5→S6 无合同/全款 -> 拦截（hard）', () => {
    const r = salesStageGate({ curStage: 'S5', toStage: 'S6', dealPayload: {} });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_prereq');
  });
  it('S5→S6 有合同+全款 -> 放行', () => {
    const r = salesStageGate({ curStage: 'S5', toStage: 'S6', dealPayload: { contract_no: 'HT-001', signed_at: '2026-08-01', paid_at: '2026-08-15' } });
    expect(r.ok).toBe(true);
  });
});

describe('executor C6 商机三要素闸（判据纯函数 salesDealPrereq）', () => {
  it('non-lead 缺三要素 -> 拦截 + missing 精确', () => {
    const r = salesDealPrereq({ stage: 'S3' });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['预算', '责任人', '时间表']);
  });
  it('bantcc.* 三维齐全 -> 放行', () => {
    const r = salesDealPrereq({ stage: 'S3', bantcc: { budget: '有预算', authority: '决策人', timetable_ok: true } });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it('ai.bantcc_completeness >= pass -> 放行（已评估兜底）', () => {
    const r = salesDealPrereq({ stage: 'P3', ai: { bantcc_completeness: { value: 0.8 } } });
    expect(r.ok).toBe(true);
  });
  it('ai.bantcc_completeness < pass -> 拦截', () => {
    const r = salesDealPrereq({ stage: 'P3', ai: { bantcc_completeness: { value: 0.4 } } });
    expect(r.ok).toBe(false);
  });
  it('lead 阶段 -> 豁免（线索不进要素闸）', () => {
    const r = salesDealPrereq({ stage: 'lead' });
    expect(r.ok).toBe(true);
  });
  it('线索别名 -> 豁免', () => {
    const r = salesDealPrereq({ stage: '线索' });
    expect(r.ok).toBe(true);
  });
  // ── 2026-09-11 S0/S0P 公海三档（D2）：公海/私海待校验同属线索侧，一并豁免；
  //    升级资格由 S0P→S1 阶段闸（STAGE_GATES，Task 2）负责，不在此处重复判 —─
  it('S0 公海 -> 豁免（未成单线索，不该被 B/A/T 拦）', () => {
    const r = salesDealPrereq({ stage: 'S0' });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it('S0P 私海待校验 -> 豁免（即便 bantcc 全空也不拦）', () => {
    const r = salesDealPrereq({ stage: 'S0P', bantcc: {} });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it('S2 仍进要素闸（豁免面未外溢到正式管道）', () => {
    const r = salesDealPrereq({ stage: 'S2', bantcc: {} });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['预算', '责任人', '时间表']);
  });
});

describe('executor C6 dispatch 接线（mock DB 依赖，验证闸位置与放行路径）', () => {
  beforeEach(() => {
    vi.resetModules();
    // DB 依赖 mock：无 PG 环境下使 dispatch 可走通第 1 闸（角色识别失败 → fail-open）与 handler
    vi.mock('../../src/db.js', () => ({
      query: async () => ({ rows: [] }),
      queryWrite: async () => ({ rows: [] }),
    }));
    vi.mock('../../src/context/scope.js', () => ({
      isParticleScoped: () => true,
      actorRole: async () => null, // 角色未识别 → 第1闸/1.5闸 fail-open 放行
      enforceScope: async () => ({ ok: true }),
    }));
    vi.mock('../../src/context/roleProfiles.js', () => ({
      loadProfile: async () => null,
    }));
    vi.mock('../../src/action/auditHook.js', () => ({ recordAudit: async () => ({}) }));
    vi.mock('../../src/alerts/tokenAccounting.js', () => ({ recordTokens: async () => ({}) }));
    vi.mock('../../src/events/bus.js', () => ({ emit: () => {} }));
    vi.mock('../../src/particles/particleRepo.js', () => ({
      createParticle: async (type, payload) => ({ id: `pt-${Date.now()}`, type, payload }),
      getParticle: async () => null,
      updateParticle: async () => ({}),
      queryParticles: async () => [],
      createEdge: async () => ({}),
      queryNeighbors: async () => [],
    }));
  });

  it('data-particle-create CRM_DEAL 非 lead 缺三要素 -> 拦截（gate=sales_deal_prereq）', async () => {
    const { actionExecutor } = await import('../../src/action/executor.js');
    const { seedActions } = await import('../../src/action/seed-actions.js');
    const { resetRegistry } = await import('../../src/action/registry.js');
    resetRegistry();
    seedActions();
    const r = await actionExecutor.dispatch('data-particle-create', {
      type: 'CRM_DEAL', payload: { name: '测试商机', stage: 'S3' },
    }, { tenantId: 'system', actor: 'alice', decision_id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('sales_deal_prereq');
  });
  it('data-particle-create CRM_DEAL 三要素齐全（bantcc.*）-> 放行并经 handler', async () => {
    const { actionExecutor } = await import('../../src/action/executor.js');
    const { seedActions } = await import('../../src/action/seed-actions.js');
    const { resetRegistry } = await import('../../src/action/registry.js');
    resetRegistry();
    seedActions();
    const r = await actionExecutor.dispatch('data-particle-create', {
      type: 'CRM_DEAL', payload: { name: '测试商机', stage: 'S3', bantcc: { budget: '有预算', authority: '决策人', timetable_ok: true } },
    }, { tenantId: 'system', actor: 'alice', decision_id: 'x' });
    expect(r.ok).toBe(true);
    expect(r.data.id).toMatch(/^pt-/);
  });
  it('data-particle-create CRM_DEAL lead 阶段 -> 豁免（线索不加要素闸）', async () => {
    const { actionExecutor } = await import('../../src/action/executor.js');
    const { seedActions } = await import('../../src/action/seed-actions.js');
    const { resetRegistry } = await import('../../src/action/registry.js');
    resetRegistry();
    seedActions();
    const r = await actionExecutor.dispatch('data-particle-create', {
      type: 'CRM_DEAL', payload: { name: '测试线索', stage: 'lead' },
    }, { tenantId: 'system', actor: 'alice', decision_id: 'x' });
    expect(r.ok).toBe(true);
  });
  it('data-particle-create CRM_DEAL S0 公海 -> 放行（D2 接线验证：公海建粒子不被要素闸拦）', async () => {
    const { actionExecutor } = await import('../../src/action/executor.js');
    const { seedActions } = await import('../../src/action/seed-actions.js');
    const { resetRegistry } = await import('../../src/action/registry.js');
    resetRegistry();
    seedActions();
    const r = await actionExecutor.dispatch('data-particle-create', {
      type: 'CRM_DEAL', payload: { name: '公海线索', stage: 'S0' },
    }, { tenantId: 'system', actor: 'alice', decision_id: 'x' });
    expect(r.ok).toBe(true);
    expect(r.data.id).toMatch(/^pt-/);
  });
});