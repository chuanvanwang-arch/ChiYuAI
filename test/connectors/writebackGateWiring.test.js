// test/connectors/writebackGateWiring.test.js — 回写入网关（Q3-3b，设计 §3.4）
// 既有 test/connectors/writebackAction.test.js 是**静态源码断言**（expect(src).toContain(...)），
//   只能证明"源码里有这个字符串"——本项目已登记反模式：注释/文档承诺 ≠ 实现。
//   本文件用**行为断言**承担 Q3-3b 的验收：真跑 handler，断言返回值与写入载荷。
import { describe, it, expect } from 'vitest';
import { seedConnectorActions } from '../../src/connectors/connectorActions.js';
import { listActions, resetRegistry } from '../../src/action/registry.js';

const rc = (value) => async () => (value === null ? null : { value });
const TRUST = { writeback_fields_whitelist: ['industry'], default_level: 'L3' };

const gateOpen = { guard: async () => ({ allowed: true, gate: { healthy: true } }) };
const gateClosed = { guard: async () => ({ allowed: false, error: 'blocked_by_export_gate', reason: 'sent_exists' }) };

function setup({ gate } = {}) {
  resetRegistry();
  const updateCalls = [];
  seedConnectorActions({
    exportGate: gate,
    readConfig: rc(TRUST),
    updateParticle: async (id, opts) => { updateCalls.push({ id, opts }); return { id }; },
  });
  const action = listActions().find((a) => a.name === 'sync-writeback-fields');
  return { action, updateCalls };
}

describe('Q3-3b · 回写 Action 接闸门（行为断言）', () => {
  it('闸门关 → ok:false + blocked_by_export_gate，且**不写库**', async () => {
    const { action, updateCalls } = setup({ gate: gateClosed });
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工' } }, { tenantId: 't1', actor: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
    expect(r.reason).toBe('sent_exists');
    expect(updateCalls).toHaveLength(0); // 关键：阻断必须发生在**任何写入之前**
  });

  it('闸门开 → 白名单命中字段写入，载荷含静态 Source=crm-ai-native', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工', secret: 'x' } }, { tenantId: 't1', actor: 'u1' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('crm-ai-native');
    expect(r.written).toEqual(['industry']);
    expect(r.denied).toEqual(['secret']);         // 非白名单字段被拒且**可见**
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].opts.patch.Source).toBe('crm-ai-native'); // 静态标记真的写进了载荷
  });

  it('闸门开 + cas_expect → 透传为 casExpectField', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    await action.handler(
      { account_id: 'acc1', fields: { industry: '化工' }, cas_expect: { path: 'industry', value: '涂料' } },
      { tenantId: 't1', actor: 'u1' }
    );
    expect(updateCalls[0].opts.casExpectField).toEqual({ path: 'industry', value: '涂料' });
  });

  it('未注入闸门 → 使用真实 exportGate（生产路径），此时默认阻断（出口判据①未成立）', async () => {
    resetRegistry();
    seedConnectorActions({ readConfig: rc(TRUST), updateParticle: async () => ({ id: 'acc1' }) });
    const action = listActions().find((a) => a.name === 'sync-writeback-fields');
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工' } }, { tenantId: 't1', actor: 'u1' });
    // 无 signal-delivery 配置 + 无 sent 行 → 闸门必关
    expect(r.ok).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
  });

  // Q3-2（设计 §4）：`Source='crm-ai-native'` 必须是**写入载荷**的一部分，
  //   而不是只出现在源码里（既有静态断言 `expect(src).toContain("Source='crm-ai-native'")`
  //   无法区分「真的写了」与「注释里提了」——本项目已登记反模式：注释/文档承诺 ≠ 实现）。
  it('调用方传入伪造 Source → 被静态标记覆盖（不可冒充）', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    await action.handler(
      { account_id: 'acc1', fields: { industry: '化工', Source: 'evil-corp' } },
      { tenantId: 't1', actor: 'u1' }
    );
    // Source 不在白名单 → 走 denied；载荷里的 Source 恒为我们自己的静态值
    expect(updateCalls[0].opts.patch.Source).toBe('crm-ai-native');
    expect(updateCalls[0].opts.patch['evil-corp']).toBeUndefined();
  });

  it('返回值 source 字段与写入载荷一致（可观测，不靠猜）', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工' } }, { tenantId: 't1', actor: 'u1' });
    expect(r.source).toBe(updateCalls[0].opts.patch.Source);
  });
});
