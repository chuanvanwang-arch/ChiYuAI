// test/contract-monitor.test.js
import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

const ROWS = [];
const FB_ROWS = [];
vi.mock('../src/db.js', () => ({
  query: vi.fn(async (sql) => {
    // 按 SQL 区分 monitor_event 与 agent_contract_feedback，避免共享同一行集
    if (typeof sql === 'string' && sql.includes('agent_contract_feedback')) return { rows: FB_ROWS };
    return { rows: ROWS };
  }),
  queryWrite: vi.fn(async () => ({ rows: [] })),
}));

const { parseContractsFromDoc, judgeContract, computeCompliance } = await import('../src/agent/contractMonitor.js');
const docFixture = fileURLToPath(new URL('./fixtures/contract-doc.md', import.meta.url));

describe('contractMonitor', () => {
  it('parseContractsFromDoc 复用 validate-contract 抽取契约', () => {
    const cs = parseContractsFromDoc(docFixture);
    expect(cs.length).toBe(1);
    expect(cs[0].agent).toBe('crm-copilot');
    expect(cs[0].skills).toContain('data-particle-read');
  });

  it('judgeContract: skill + memory 双合规', () => {
    const c = { task: 'T-DEMO', agent: 'crm-copilot', skills: ['data-particle-read'], knowledge_scope: { layers: ['L1'] } };
    const eps = [
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' } },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' } },
    ];
    const r = judgeContract(c, eps);
    expect(r.skill_ok).toBe(true);
    expect(r.memory_ok).toBe(true);
    expect(r.success).toBe('pending');
  });

  it('judgeContract: 缺 layer → memory 不合规', () => {
    const c = { task: 'T-DEMO', agent: 'crm-copilot', skills: ['data-particle-read'], knowledge_scope: { layers: ['L1'] } };
    const eps = [
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' } },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: [], contract_task_id: 'T-DEMO' } },
    ];
    expect(judgeContract(c, eps).memory_ok).toBe(false);
  });

  it('judgeContract: successMarker 回写驱动 success 列', () => {
    const c = { task: 'T-DEMO', agent: 'crm-copilot', skills: [], knowledge_scope: { layers: [] } };
    expect(judgeContract(c, [], 'pass').success).toBe('pass');
    expect(judgeContract(c, [], 'fail').success).toBe('fail');
    expect(judgeContract(c, []).success).toBe('pending');
  });

  it('computeCompliance: 按 task 标题关联 episode', async () => {
    ROWS.length = 0;
    ROWS.push(
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' }, payload: {} },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' }, payload: {} },
    );
    const matrix = await computeCompliance(docFixture);
    expect(matrix[0].skill_ok).toBe(true);
    expect(matrix[0].memory_ok).toBe(true);
  });

  it('computeCompliance: 回写 success 标记 → 矩阵 success=pass', async () => {
    ROWS.length = 0;
    ROWS.push(
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' }, payload: {} },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' }, payload: {} },
    );
    FB_ROWS.length = 0;
    FB_ROWS.push({ contract_task_id: 'T-DEMO', observed: 'pass' });
    const matrix = await computeCompliance(docFixture);
    expect(matrix[0].success).toBe('pass');
  });
});
