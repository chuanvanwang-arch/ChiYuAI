// test/mcp/channelActions.test.js — T9：通道的 MCP 暴露面（WorkBuddy 对话入口先行）
// 判据：
//   ① 三 Action 存在且 kind 正确（connect=write / query=read / ics-export=read）；
//   ② **身份 fail-closed**：缺 ctx.actor 一律 auth_required（不收窄＝全租户泄漏）；
//   ③ connect kind 判据单一源：generic-rest/mcp/cli 一律 kind_invalid；缺凭据 → credentials_missing；
//      未过 review-gate → approval_required（HITL）；
//   ④ query 未接通时如实报 channel_not_connected（不假装读到 0 条）；
//   ⑤ ics-export **复用 buildIcs**（缺日期不造幽灵日程，skipped 计数可辨）。
import { describe, it, expect } from 'vitest';
import { buildChannelActions } from '../../src/action/channelActions.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

const find = (deps) => Object.fromEntries(buildChannelActions(deps).map((a) => [a.name, a]));

describe('MCP 通道 Action', () => {
  it('三 Action 齐备且 kind 正确', () => {
    const A = find({});
    expect(Object.keys(A).sort()).toEqual(['crm-channel-connect', 'crm-channel-ics-export', 'crm-channel-query']);
    expect(A['crm-channel-connect'].kind).toBe('write');
    expect(A['crm-channel-query'].kind).toBe('read');
    expect(A['crm-channel-ics-export'].kind).toBe('read');
  });

  it('身份 fail-closed：缺 ctx.actor → auth_required（三 Action 同源）', async () => {
    const A = find({});
    for (const n of ['crm-channel-connect', 'crm-channel-query', 'crm-channel-ics-export']) {
      const r = await A[n].handler({ kind: 'generic-email', events: [] }, {});
      expect(r.ok).toBe(false);
      expect(r.error).toBe('auth_required');
    }
  });

  it('connect kind 判据单一源：generic-rest 不是通道 → kind_invalid', async () => {
    const A = find({});
    const r = await A['crm-channel-connect'].handler({ kind: 'generic-rest', credentials: { a: 1 } }, { actor: 'alice', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('kind_invalid');
  });

  it('connect 缺凭据 → credentials_missing（fail-closed，无人闸也挡）', async () => {
    const A = find({});
    const r = await A['crm-channel-connect'].handler({ kind: 'generic-email' }, { actor: 'alice', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('credentials_missing');
  });

  it('connect 未过 review-gate → approval_required（HITL）', async () => {
    const calls = [];
    const A = find({
      persistSecret: async (a) => { calls.push(a); return { ok: true }; },
      verifyScope: async () => ({ ok: true, probe: 'imap_login' }),
      reviewGate: { hasApproval: async () => null },
      writeConfig: async () => { throw new Error('不应写库'); },
    });
    const r = await A['crm-channel-connect'].handler(
      { kind: 'generic-email', credentials: { user: 'u', pass: 'p' } },
      { actor: 'alice', tenantId: 't1' },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('approval_required');
    expect(calls.length).toBe(1); // 凭据已入 vault（这一步先于人工闸）
  });

  it('connect 全通 → 描述符落库（L1 只读起始），响应不含凭据明文', async () => {
    const store = {};
    const A = find({
      persistSecret: async () => ({ ok: true }),
      verifyScope: async () => ({ ok: true, probe: 'imap_login' }),
      reviewGate: { hasApproval: async () => ({ approved: true }) },
      readConfig: async () => ({ value: [] }),
      writeConfig: async (k, v) => { store[k] = v; },
    });
    const r = await A['crm-channel-connect'].handler(
      { kind: 'generic-email', credentials: { user: 'alice', pass: 'secret-pass' } },
      { actor: 'alice', tenantId: 't1' },
    );
    expect(r.ok).toBe(true);
    expect(r.stored).toBe(true);
    expect(r.channel.trust_level).toBe('L1');
    expect(JSON.stringify(r)).not.toContain('secret-pass');
    expect(store['integration-providers'].some((d) => d.kind === 'generic-email' && d.enabled === true)).toBe(true);
  });

  it('query 未接通 → 如实报 channel_not_connected（不假装读到 0 条）', async () => {
    const A = find({});
    const r = await A['crm-channel-query'].handler({ days: 30 }, { actor: 'alice', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('channel_not_connected');
  });

  it('query 已接通 → 返回结构化摘要（不含正文）', async () => {
    const A = find({
      fetchIncremental: async () => ({ ok: true, rows: [{ channel: 'email', kind: 'contact_change', ts: '2026-09-17T08:00:00Z', domain: 'acme.com', content: { subject: '报价' } }] }),
    });
    const r = await A['crm-channel-query'].handler({ days: 7 }, { actor: 'alice', tenantId: 't1' });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.items)).toBe(true);
    expect(r.items[0].subject).toBe('报价');
  });

  it('ics-export 复用 buildIcs：合法日期导出、缺日期 skipped（不造幽灵日程）', async () => {
    const A = find({});
    const r = await A['crm-channel-ics-export'].handler({
      events: [
        { external_id: 'e1', dtstart: '2026-09-18T10:00:00Z', summary: '拜访' },
        { external_id: 'e2', dtstart: null, summary: '无日期' },
      ],
    }, { actor: 'alice', tenantId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.ics).toContain('BEGIN:VCALENDAR');
    expect(r.ics).toContain('DTSTART');
    expect(r.exported).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it('接线守卫：buildMcpTools 工具面含三通道工具（Action Registry 为唯一来源）', () => {
    const { tools } = buildMcpTools({ seed: true });
    const names = tools.map((t) => t.name);
    for (const n of ['crm-channel-connect', 'crm-channel-query', 'crm-channel-ics-export']) {
      expect(names, `工具面缺 ${n}`).toContain(n);
    }
  });
});
