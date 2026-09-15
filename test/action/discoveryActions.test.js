import { describe, it, expect, beforeAll } from 'vitest';
import { getAction, detectCrudExplosion } from '../../src/action/registry.js';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { seedSkills } from '../../src/skills/seed.js';
import { getSkill } from '../../src/skills/registry.js';
import { writeBlastRadius, isWriteWhitelisted } from '../../src/action/whitelist.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

beforeAll(() => { seedDiscoveryActions(); seedSkills(); });

const NAMES = ['discovery-run', 'discovery-enrich', 'discovery-research'];
const FLAT_FIELDS = ['kind', 'permission', 'namespace', 'agentTool', 'handler', 'schema'];

describe('discovery actions hard closures', () => {
  it('① discovery-* registered in Action Registry', () => {
    for (const n of NAMES) expect(getAction(n), n).not.toBeNull();
  });
  it('④ flat def fields present (non JSON-Schema) + namespace 自动推导', () => {
    const a = getAction('discovery-run');
    for (const k of FLAT_FIELDS) expect(a[k], k).toBeDefined();
    expect(a.namespace).toBe('discovery');
    expect(a.kind).toBe('write');
    expect(a.permission).toBe('auth');
  });
  it('② assertAgentAssembly passes with discovery actions wired', async () => {
    const r = await assertAgentAssembly();   // ⚠ async：必须 await（原稿漏 await → 假红）
    expect(r.ok).toBe(true);
  });
  it('③ skillCalls ⊆ capabilities.actions（discovery-* 两数组同改）', () => {
    const spec = agentSpecs['decision-agent'];
    for (const c of spec.capabilities.skillCalls) expect(spec.capabilities.actions, c).toContain(c);
    for (const n of NAMES) expect(spec.capabilities.skillCalls, n).toContain(n);
  });
  it('⑤ lead-discovery SKILL registered (slug 精确匹配)', () => {
    expect(getSkill('lead-discovery')).not.toBeNull();
    expect(getSkill('lead-discovery').slug).toBe('lead-discovery');
  });
});

// ── T18：ACTION 对外面（MCP 暴露 + 白名单 human_gate + gateway 决策锚定 + R3 反爆炸）──
// 本组为「护栏断言」：锁定 Task 5 已交付的行为，防后续改动静默放宽写闸/破坏暴露面。
// 关键：R3 与暴露计数必须在**真实全量注册表**上判定——空表 / 仅 discovery 表下
//   detectCrudExplosion() 恒返回 {exploded:false}（无可聚合 CRUD 动词）⇒ 假绿。
describe('discovery ACTION 对外面（T18）', () => {
  const EXPOSE = ['discovery-run', 'discovery-enrich', 'discovery-research'];
  beforeAll(() => { seedActions(); });

  it('① 三个动作均为 write / agentTool / namespace=discovery', () => {
    for (const n of EXPOSE) {
      const a = getAction(n);
      expect(a, n).not.toBeNull();
      expect(a.kind, n).toBe('write');
      expect(a.agentTool, n).toBe(true);
      expect(a.namespace, n).toBe('discovery');
    }
  });

  it('② 第 0 闸锚定字段齐（gateway.js:165 mint 触发键 + 两阶段确认）', () => {
    for (const n of EXPOSE) {
      const a = getAction(n);
      expect(a.decisionScenario, n).toBe('LEAD_FIT');  // gateway 据此 mint 决策
      expect(a.autoDecision, n).toBe(true);            // executor 第 0 闸放行键
      expect(a.confirm, n).toBe('stage2');             // 两阶段（先表单后执行）
      expect(a.needsApproval, n).toBe(true);           // 外联/主数据写 → 人工闸
    }
  });

  it('③ 默认 human_gate —— 不进 autonomous 写白名单', () => {
    for (const n of EXPOSE) {
      expect(isWriteWhitelisted(n), n).toBe(false);
      expect(writeBlastRadius(n), n).toBe('human_gate');
    }
  });

  it('④ handler 级 fail-closed：无 decision_id 必拒（第 0 闸不假绿）', async () => {
    await expect(getAction('discovery-run').handler({ seed: {} }, {})).rejects.toThrow(/decision_required/);
    await expect(getAction('discovery-enrich').handler({ account_id: 'x' }, {})).rejects.toThrow(/decision_required/);
    await expect(getAction('discovery-research').handler({ account_id: 'x', brief: 'b' }, {}))
      .rejects.toThrow(/decision_required/);
  });

  it('⑤ 经 MCP 列表对外暴露（全量 surface + 非平凡计数闸）', () => {
    const names = buildMcpTools().tools.map((t) => t.name);  // 默认 seed:true → 真实全量
    expect(names.length).toBeGreaterThan(30);                // 防「空注册表恒含」假绿
    for (const n of EXPOSE) expect(names, n).toContain(n);
  });

  it('⑥ 不触发 R3 CRUD 爆炸护栏（全量注册表上判定）', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).toEqual([]);
  });
});
