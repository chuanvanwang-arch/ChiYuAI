import { describe, it, expect, beforeAll } from 'vitest';
import { getAction } from '../../src/action/registry.js';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { seedSkills } from '../../src/skills/seed.js';
import { getSkill } from '../../src/skills/registry.js';

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
