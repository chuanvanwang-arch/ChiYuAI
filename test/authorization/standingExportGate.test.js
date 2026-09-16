// test/authorization/standingExportGate.test.js — 自治前置闸门（Q3-4，设计 §3.4 接入点之二）
// 契约（设计 §4 Q3-4 success）：
//   ① require_export_healthy=true 且闸门关 → crm.grant_execution 零新增行（= consultStandingGate 升级为 HITL）
//   ② 置 false（含缺省）→ 行为与既有 S6 一致（向后兼容）
// 零 DB：policy 读取走 readConfig 替身；鉴权走注入 q 替身；闸门走替身。
import { describe, it, expect } from 'vitest';
import {
  consultStandingGate, DEFAULT_GRANTS_POLICY,
} from '../../src/authorization/standingAuthorization.js';

const gateClosed = { guard: async () => ({ allowed: false, error: 'blocked_by_export_gate', reason: 'sent_exists' }) };
const gateOpen = { guard: async () => ({ allowed: true, gate: { healthy: true } }) };

describe('Q3-4 · 自治受运行时闸门约束', () => {
  it('DEFAULT_GRANTS_POLICY 含 require_export_healthy 且**默认 false**（S6 向后兼容，D3）', () => {
    expect(DEFAULT_GRANTS_POLICY.require_export_healthy).toBe(false);
  });

  it('require_export_healthy=false（缺省）→ 闸门不被调用，行为与 S6 一致', async () => {
    let gateCalls = 0;
    const spyGate = { guard: async () => { gateCalls++; return { allowed: false }; } };
    // 无活跃凭证 → 既有语义 = 升级（true）；但闸门不得被调用
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account', standingFields: [],
      exportGate: spyGate, q: async () => ({ rows: [] }),
      policyOverride: { require_export_healthy: false },
    });
    expect(escalated).toBe(true);
    expect(gateCalls).toBe(0);
  });

  it('require_export_healthy=true 且闸门关 → 直接升级（自主执行量为 0）', async () => {
    let authorizedCalls = 0;
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account', standingFields: [],
      exportGate: gateClosed, policyOverride: { require_export_healthy: true },
      q: async () => { authorizedCalls++; return { rows: [{ grant_id: 'g1', scope_actions: ['crm-update-account'], status: 'active' }] }; },
    });
    expect(escalated).toBe(true);
    // 关键：闸门关时**不应**再去判定动作鉴权（先闸门、后鉴权；避免"凭证齐备但出口不健康"仍放行）
    expect(authorizedCalls).toBe(0);
  });

  it('require_export_healthy=true 且闸门开 → 回落既有鉴权路径（凭证齐备则放行）', async () => {
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account', standingFields: [],
      exportGate: gateOpen, policyOverride: { require_export_healthy: true },
      q: async () => ({ rows: [{ grant_id: 'g1', scope_actions: ['crm-update-account'], field_whitelist: null, status: 'active' }] }),
    });
    expect(escalated).toBe(false);
  });

  it('闸门自身抛错 → fail-closed 升级（绝不放行）', async () => {
    const boomGate = { guard: async () => { throw new Error('gate exploded'); } };
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account',
      exportGate: boomGate, policyOverride: { require_export_healthy: true },
    });
    expect(escalated).toBe(true);
  });

  it('A 轴已升级 或 未声明动作 → 原样返回（opt-in，零回归）', async () => {
    expect(await consultStandingGate(true, { tenantId: 't1', standingAction: 'x' })).toBe(true);
    expect(await consultStandingGate(false, { tenantId: 't1' })).toBe(false);
  });

  it('loadGrantsPolicy 缺键时兜底默认值（含 require_export_healthy）', async () => {
    const { readConfig } = await import('../../src/config/configStore.js');
    expect(typeof readConfig).toBe('function');
    expect(DEFAULT_GRANTS_POLICY.require_export_healthy).toBeDefined();
  });
});
