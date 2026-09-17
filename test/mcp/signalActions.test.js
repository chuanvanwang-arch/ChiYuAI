// test/mcp/signalActions.test.js — 信号读 Action 的注册与 MCP 暴露（P1-4）
//
// 背景（2026-09-17 前台可见性审计）：MCP 工具面由 Action Registry 生成（src/mcp/tools.js buildMcpTools），
//   而 registry 里此前**零 signal action** ⇒ 两个专家包（crm-native / crm-platform-admin）经
//   crm-native-mcp 连上后，工具清单里根本没有信号能力 —— 「更新插件」自然无用（暴露面源头未开）。
// 本测试锁住：① 两 Action 注册（kind=read）；② buildMcpTools 工具面确实含二者（**唯一咽喉**）；
//   ③ 身份 fail-closed（无 actor 拒绝，不收窄=泄漏）；④ 缺参明确失败（不静默）。
import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../../src/action/seed-actions.js';
import { getAction, resetRegistry } from '../../src/action/registry.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('信号读 Action 注册与 MCP 暴露', () => {
  beforeAll(() => {
    resetRegistry();
    seedActions();
  });

  it('registry 注册 crm-signal-list / crm-signal-ics，且均为 kind=read（读类直连、不触写闸）', () => {
    const list = getAction('crm-signal-list');
    const ics = getAction('crm-signal-ics');
    expect(list, '缺 crm-signal-list').toBeTruthy();
    expect(ics, '缺 crm-signal-ics').toBeTruthy();
    expect(list.kind).toBe('read');
    expect(ics.kind).toBe('read');
  });

  it('buildMcpTools 工具面含两工具（MCP 暴露唯一咽喉；不含则插件侧永远看不到）', () => {
    const { tools } = buildMcpTools({ seed: true });
    const names = tools.map((t) => t.name);
    expect(names).toContain('crm-signal-list');
    expect(names).toContain('crm-signal-ics');
  });

  it('身份 fail-closed：无 actor 一律拒绝（不返回全量——那是最危险的假绿方向）', async () => {
    const r = await getAction('crm-signal-list').handler({}, { tenantId: 'system' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('auth_required');
  });

  it('crm-signal-ics 缺 signal_id 明确失败（不静默返回空内容）', async () => {
    const r = await getAction('crm-signal-ics').handler({}, { tenantId: 'system', actor: 'alice' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('signal_id_required');
  });

  it('crm-signal-list 声明 mine 开关与过滤参数（schema 含 status/kind/severity/mine）', () => {
    const s = getAction('crm-signal-list').schema || {};
    for (const k of ['status', 'kind', 'severity', 'mine']) expect(s[k], `schema 缺 ${k}`).toBeTruthy();
  });
});
