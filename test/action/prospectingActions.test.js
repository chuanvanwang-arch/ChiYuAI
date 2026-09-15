// test/action/prospectingActions.test.js — prospecting 三 MCP Action（T5）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §4 + 实施计划 T5
// search/select 只读；confirm 写（autoDecision + decisionScenario + needsApproval）
// fit_score 仅服务端计算（修订 2）；select 防注入（圈选 ∈ 候选）；confirm 无 decision_id 必拒
import { describe, it, expect, beforeEach } from 'vitest';
import { getAction, resetRegistry } from '../../src/action/registry.js';
import { seedProspectingActions } from '../../src/action/prospectingActions.js';
import { createProspectingSession, updateSession } from '../../src/action/prospectingSession.js';
import { computeFitScore, DEFAULT_PROSPECTING_RULES } from '../../src/config/prospectingRules.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

beforeEach(() => { resetRegistry(); seedProspectingActions(); });

describe('prospecting Action 三件套（T5）', () => {
  it('① search/select 只读：kind=read，confirm 写：kind=write + 第0闸', () => {
    expect(getAction('prospecting-search').kind).toBe('read');
    expect(getAction('prospecting-select').kind).toBe('read');
    const c = getAction('prospecting-confirm');
    expect(c.kind).toBe('write');
    expect(c.autoDecision).toBe(true);
    expect(c.decisionScenario).toBe('PROSPECTING_CONFIRM');
    expect(c.confirm).toBe('stage2');
  });
  it('② fit_score 仅服务端计算（T1b：适配器注入被覆盖）', () => {
    // 候选带 fit_score（恶意）→ computeFitScore 只看 signals 字段
    const c = { name: 'X', signals: { hiring: true, funding: true }, fit_score: 0.99 };
    const rules = { ...DEFAULT_PROSPECTING_RULES, signals: { hiring: 0.7, funding: 0.9 } };
    const s = computeFitScore(c, rules);
    expect(s).toBeCloseTo(1.0);   // (0.7+0.9)/(0.7+0.9) = 1.0（无视注入的 0.99）
  });
  it('③ select 只允许圈选候选列表内 id（防注入）', async () => {
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }] });
    await expect(getAction('prospecting-select').handler({ session_id: sid, selected_ids: ['c1', 'c3'] }, { tenantId: 'acme', actor: 'alice' }))
      .rejects.toThrow(/c3/);
    await expect(getAction('prospecting-select').handler({ session_id: sid, selected_ids: ['c1'] }, { tenantId: 'acme', actor: 'alice' }))
      .resolves.toMatchObject({ state: 'selecting', selected_ids: ['c1'] });
  });
  it('④ confirm 无 decision_id 必拒（第0闸 fail-closed）', async () => {
    await expect(getAction('prospecting-confirm').handler({ session_id: 'x', confirmed_ids: [] }, { tenantId: 'acme', actor: 'alice' }))
      .rejects.toThrow(/decision_required|decision_id/);
  });
  it('⑤ MCP 列表含三个工具', () => {
    const tools = buildMcpTools({ seed: false });
    const names = tools.tools.map((t) => t.name);
    for (const n of ['prospecting-search', 'prospecting-select', 'prospecting-confirm']) expect(names, n).toContain(n);
  });
});
