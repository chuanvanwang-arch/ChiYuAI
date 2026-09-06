// test/agent/aiFill.test.js
// P5(T14): AI Fill 引擎只产出草稿（source='ai', enabled=false），不直写。
import { describe, it, expect } from 'vitest';
import { proposeAiFill } from '../../src/agent/aiFillEngine.js';
import { seedTrainingProfile, TRAINING_TENANT } from '../../db/seed/tenant-profile-training.js';

describe('aiFill engine', () => {
  it('proposes field from raw context (no LLM => deterministic fallback)', async () => {
    const proposal = await proposeAiFill({
      prototype: 'TRAINING_CLIENT',
      rawContext: '客户预算 50 万，目标提升销售',
      tenantId: TRAINING_TENANT,
    });
    expect(proposal).toBeDefined();
    expect(proposal.draft).toBe(true); // 仅建议草稿，不直写
    expect(Array.isArray(proposal.proposal)).toBe(true);
    expect(proposal.proposal.length).toBeGreaterThan(0);
    expect(proposal.proposal.every((p) => p.source === 'ai' && p.enabled === false)).toBe(true);
  });

  it('returns empty proposal for unknown prototype', async () => {
    const proposal = await proposeAiFill({ prototype: 'NOPE_TYPE', rawContext: 'x', tenantId: TRAINING_TENANT });
    expect(proposal.proposal).toEqual([]);
  });

  it('with LLM extractor uses llm path', async () => {
    await seedTrainingProfile(TRAINING_TENANT);
    const proposal = await proposeAiFill({
      prototype: 'TRAINING_CLIENT',
      rawContext: 'anything',
      tenantId: TRAINING_TENANT,
      llm: { extractFields: async () => [{ slug: 'industry', title: '行业', type: 'select' }] },
    });
    expect(proposal.proposal[0].attr_slug).toBe('industry');
  });
});
