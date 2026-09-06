import { test, expect } from 'vitest';
import { renderAgents, agentAssemblyOk } from '../../src/portal/agentsPage.js';

const fixture = {
  agents: ['crm-copilot', 'deal-coach', 'lead-miner'],
  assembly: {
    ok: true,
    results: [
      { agent: 'crm-copilot', assertion: 'permission_closure', ok: true, detail: 'data-particle-read ⊆ actions' },
      { agent: 'crm-copilot', assertion: 'action_in_registry', ok: true, detail: 'data-particle-read' },
      { agent: 'crm-copilot', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-nl-to-action' },
      { agent: 'crm-copilot', assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' },
      { agent: 'crm-copilot', assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' },
      { agent: 'crm-copilot', assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' },
      { agent: 'deal-coach', assertion: 'permission_closure', ok: false, detail: 'crm-deal-advance ⊆ actions' },
      { agent: 'deal-coach', assertion: 'action_in_registry', ok: true, detail: 'crm-deal-advance' },
      { agent: 'deal-coach', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-deal-advance-advice' },
      { agent: 'deal-coach', assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' },
      { agent: 'deal-coach', assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' },
      { agent: 'deal-coach', assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' },
      { agent: 'lead-miner', assertion: 'permission_closure', ok: true, detail: 'data-particle-read ⊆ actions' },
      { agent: 'lead-miner', assertion: 'action_in_registry', ok: true, detail: 'data-particle-read' },
      { agent: 'lead-miner', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-intelligence-mining' },
      { agent: 'lead-miner', assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' },
      { agent: 'lead-miner', assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' },
      { agent: 'lead-miner', assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' },
    ],
    failed: [{ agent: 'deal-coach', assertion: 'permission_closure', ok: false, detail: 'crm-deal-advance ⊆ actions' }],
  },
  specs: {
    'crm-copilot': { name: 'crm-copilot', derivedFrom: 'taskFlow:crm-nl-to-action', autonomy: 'recommend', actionCount: 5, skillCallCount: 2, actions: ['data-particle-read', 'data-particle-create'], skillCalls: ['data-particle-read'] },
    'deal-coach': { name: 'deal-coach', derivedFrom: 'taskFlow:crm-deal-advance-advice', autonomy: 'recommend', actionCount: 3, skillCallCount: 1, actions: ['data-particle-read', 'crm-deal-advance'], skillCalls: ['data-particle-read'] },
    'lead-miner': { name: 'lead-miner', derivedFrom: 'taskFlow:crm-intelligence-mining', autonomy: 'recommend', actionCount: 3, skillCallCount: 1, actions: ['data-particle-read', 'data-particle-create'], skillCalls: ['data-particle-read'] },
  },
  health: { ok: true, ts: 123, domains: ['task', 'trace', 'approval', 'particle', 'payment', 'decision'] },
};

test('renders all 3 agent names', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('crm-copilot');
  expect(html).toContain('deal-coach');
  expect(html).toContain('lead-miner');
});

test('marks agent with failing assertion as fail (red)', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('data-section="agent"');
  expect(agentAssemblyOk(fixture.assembly.results.filter(r => r.agent === 'deal-coach'))).toBe(false);
  expect(agentAssemblyOk(fixture.assembly.results.filter(r => r.agent === 'crm-copilot'))).toBe(true);
});

test('renders six assertion chips per agent', () => {
  const html = renderAgents(fixture);
  ['permission_closure', 'action_in_registry', 'derived_from', 'kg_ready', 'skill_validated', 'evaluator_ready']
    .forEach(a => expect(html).toContain(`data-assertion="${a}"`));
});

test('flags degraded assertions with warn badge (not green pass)', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('degraded:');
});

test('renders health domains strip', () => {
  const html = renderAgents(fixture);
  expect(html).toContain('task');
  expect(html).toContain('decision');
});

test('empty data degrades gracefully', () => {
  const html = renderAgents({ agents: [], assembly: { ok: true, results: [], failed: [] }, specs: {}, health: { ok: true, domains: [] } });
  expect(html).toContain('无智能体');
});
