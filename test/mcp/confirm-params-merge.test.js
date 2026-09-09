// test/mcp/confirm-params-merge.test.js — confirm_token 两阶段参数合并（只增补、禁覆盖）
// 设计文档：docs/2026-09-09-approval-failure-and-write-side-fix-design.md §2
//
// 背景（用户报）：「confirm_token 绑定的是取表单时的 payload，执行阶段传的扩展明细不落库
//   （基础/标准档定价明细首轮丢失）」
// 根因：gateway.js 的 mcpConfirmPhase2 执行时一律用 session.params（phase1 冻结值），
//   phase2 传入的 params 只用于 extractToken → 扩展明细被静默丢弃。
//   旁证：hashParams 原是死代码（:298 `void hashParams;`），说明原设计要做一致性校验却从未接线。
//
// 语义取舍（设计 §2.2）：① 全量合并 → 用户确认 A 执行 B（否决）；② 严格拒绝一切额外参数（体验差）；
//   ③ **只增补、禁覆盖**（采用）——已展示键不可改，新键可补。
import { describe, it, expect, beforeAll } from 'vitest';
import { mergePhase2Params, mcpWritePhase1, mcpConfirmPhase2 } from '../../src/mcp/gateway.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { issueToken } from '../../src/mcp/issueToken.js';

beforeAll(() => seedActions());

describe('mergePhase2Params（纯函数：只增补、禁覆盖）', () => {
  it('新键 → 允许增补（修复「扩展明细首轮丢失」）', () => {
    const session = { params: { name: '甲客户', amount: 100 } };
    const { params, conflict, added } = mergePhase2Params(session, { line_items: [{ sku: 'A', qty: 2 }] });
    expect(conflict).toBeNull();
    expect(added).toEqual(['line_items']);
    expect(params.name).toBe('甲客户');
    expect(params.line_items).toEqual([{ sku: 'A', qty: 2 }]);
  });

  it('已展示键且值一致 → 无冲突（幂等重发）', () => {
    const session = { params: { name: '甲客户', amount: 100 } };
    const { params, conflict } = mergePhase2Params(session, { name: '甲客户', amount: 100 });
    expect(conflict).toBeNull();
    expect(params).toEqual({ name: '甲客户', amount: 100 });
  });

  it('已展示键被改写 → 冲突（confirm 语义保护：不得「确认 A 执行 B」）', () => {
    const session = { params: { name: '甲客户', amount: 100 } };
    const { conflict } = mergePhase2Params(session, { amount: 999 });
    expect(conflict).toBe('amount');
  });

  it('协议位键（confirm_token/api_token/choice/force/…）不参与合并与冲突判定', () => {
    const session = { params: { name: '甲客户' } };
    const { params, conflict } = mergePhase2Params(session, {
      confirm_token: 'ct_x', api_token: 'tk_x', choice: '1', force: true, decision_id: 'd1', extra: 1,
    });
    expect(conflict).toBeNull();
    expect(params).toEqual({ name: '甲客户', extra: 1 });
    expect(params.confirm_token).toBeUndefined();
    expect(params.force).toBeUndefined();
  });

  it('phase2 空 → 与 phase1 完全等价（向后兼容旧调用方）', () => {
    const session = { params: { name: '甲客户' } };
    expect(mergePhase2Params(session).params).toEqual({ name: '甲客户' });
    expect(mergePhase2Params(session, {}).params).toEqual({ name: '甲客户' });
  });
});

describe('gateway 级：冲突时不执行（fail-closed）', () => {
  it('phase2 改写已确认字段 → gate=confirm_params_conflict，拒绝执行', async () => {
    const actor = `gw_cf_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'manager', scopes: {} });
    const p1 = await mcpWritePhase1(
      'agent-dispatch',
      { api_token: tokenPlain, requirement: '跟进华南区线索', decision_id: 'DEC-CF-001' },
      {},
    );
    expect(p1.ok).toBe(true);
    expect(p1.confirm_token).toBeTruthy();

    // phase2 试图把已展示的 requirement 改掉 → 必须被拦截，且不进入 dispatch
    const p2 = await mcpConfirmPhase2(p1.confirm_token, '1', null, {
      api_token: tokenPlain, requirement: '改成别的诉求',
    }, {});
    expect(p2.ok).toBe(false);
    expect(p2.gate).toBe('confirm_params_conflict');
    expect(String(p2.error)).toMatch(/与确认时展示的值不一致/);
  });
});
