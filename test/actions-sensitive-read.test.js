// test/actions-sensitive-read.test.js — 敏感读 Action 注册 + confirm 闸（Task 3）
import { describe, it, expect, beforeAll } from 'vitest';
import { getAction } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { mcpReadSensitivePhase1, mcpConfirmPhase2 } from '../src/mcp/gateway.js';
import { buildMcpTools } from '../src/mcp/tools.js';
import { issueToken } from '../src/mcp/issueToken.js';

describe('敏感读 Action 注册', () => {
  beforeAll(() => seedActions());
  const names = ['crm-customer-360', 'crm-cross-entity-query', 'crm-finance-receivables', 'crm-contract-expiring'];
  for (const n of names) {
    it(`${n} 注册且 kind=read_sensitive`, () => {
      const a = getAction(n);
      expect(a).toBeTruthy();
      expect(a.kind).toBe('read_sensitive');
    });
  }
});

describe('敏感读经 gateway confirm 闸', () => {
  let tokenPlain;
  beforeAll(async () => {
    await seedActions();
    // requireAuth 默认开：敏感读需先持凭证过 auth 闸，再用 confirm_token 走 confirm 闸
    tokenPlain = (await issueToken({ actor: `sens_${Math.random().toString(36).slice(2, 8)}`, roleTag: 'exec', scopes: {} })).tokenPlain;
  });
  it('crm-customer-360 → CONFIRM_REQUIRED（不直接 dispatch）', async () => {
    const r = await mcpReadSensitivePhase1('crm-customer-360', { api_token: tokenPlain, customer_id: '11111111-1111-1111-1111-111111111111' }, {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CONFIRM_REQUIRED');
    expect(r.confirm_token).toMatch(/^ct_/);
  });
  it('confirm choice=1 → 执行返回数据形态', async () => {
    const p1 = await mcpReadSensitivePhase1('crm-customer-360', { api_token: tokenPlain, customer_id: '11111111-1111-1111-1111-111111111111' }, {});
    const r = await mcpConfirmPhase2(p1.confirm_token, '1', null, { customer_id: '11111111-1111-1111-1111-111111111111' }, {});
    expect(r.ok).toBe(true);
    expect(r.data).toBeTruthy();
  });
});

describe('tools.js 暴露 read_sensitive（MCP 暴露面收敛）', () => {
  it('registry 中 4 个 read_sensitive 通道 action 已注册（gateway confirm 闸依赖）', () => {
    // 对齐 describe 1：read_sensitive 通道 action 在 registry 中存在且 kind 正确。
    for (const n of ['crm-customer-360', 'crm-cross-entity-query', 'crm-finance-receivables', 'crm-contract-expiring']) {
      const a = getAction(n);
      expect(a, `${n} 应已注册`).toBeTruthy();
      expect(a.kind).toBe('read_sensitive');
    }
  });

  it('buildMcpTools 按 lifecycle 收敛：reserved 的 read_sensitive 不进 MCP 发现面', () => {
    // 2026-09-03 方案 A（用户拍板）：MCP 暴露面隐藏 lifecycle=reserved 死表面，仅暴露 active+engine。
    //   4 个 read_sensitive 通道 action 经收敛被标 reserved（gateway 仍可按名调用，见 describe 2），
    //   故不应出现在 buildMcpTools 的 MCP 工具清单中。原断言期望它们被暴露，已随收敛失效 → 改为断言收敛行为。
    const { readSensitiveTools } = buildMcpTools();
    const sens = readSensitiveTools.map(t => t.name);
    for (const n of ['crm-customer-360', 'crm-cross-entity-query', 'crm-finance-receivables', 'crm-contract-expiring']) {
      expect(sens, `${n} 为 reserved，不应暴露到 MCP 发现面`).not.toContain(n);
    }
  });
});
