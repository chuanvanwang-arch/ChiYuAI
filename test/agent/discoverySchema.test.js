import { describe, it, expect } from 'vitest';
import { buildEnrichmentPayload, buildDiscoveryPayload, LAYERS } from '../../src/agent/discoverySchema.js';

describe('P0#1 2D judge', () => {
  it('enrichment field carries six elements incl. ts/layer/source', () => {
    const p = buildEnrichmentPayload({ industry: { value: 'X', provider: 'attio', confidence: 0.9 } });
    for (const k of ['value', 'provider', 'confidence', 'ts', 'layer', 'source']) {
      expect(p.industry[k], k).toBeDefined();
    }
    expect(p.industry.layer).toBe('L2');
    expect(p.industry.source).toBe('ontologySync');
  });
  it('non-ontology provider defaults to source=provider_adapter', () => {
    const p = buildEnrichmentPayload({ email: { value: 'a@b.com', provider: 'email-verify', confidence: 0.6 } });
    expect(p.email.source).toBe('provider_adapter');
  });
  it('explicit layer honored; illegal layer throws (no silent fake-green)', () => {
    expect(buildEnrichmentPayload({ x: { value: 1, provider: 'p', confidence: 0.5, layer: 'L3' } }).x.layer).toBe('L3');
    expect(() => buildEnrichmentPayload({ x: { value: 1, provider: 'p', confidence: 0.5, layer: 'L9' } })).toThrow();
  });
  it('discovery score carries 2D judge axis + rule_ref', () => {
    const d = buildDiscoveryPayload(0.82, 0.64, [{ type: 'funding_round' }], 'dec_1');
    for (const k of ['axis', 'rule_ref', 'j_score']) expect(d.icp_fit_score.judge[k], k).toBeDefined();
    expect(d.icp_fit_score.judge.axis).toBe('capability');
    expect(d.intent_score.judge.rule_ref).toContain('ruler:');
  });
  it('why_narrative non-empty and carries rule_ref + decision_id', () => {
    const d = buildDiscoveryPayload(0.82, 0.64, [{ type: 'funding_round' }], 'dec_1');
    expect(d.why_narrative.length).toBeGreaterThan(0);
    expect(d.why_narrative).toContain('dec_1');
    expect(d.why_narrative).toContain('ruler:');
  });
  it('layer enum is L1-L4', () => {
    expect(LAYERS).toEqual(['L1', 'L2', 'L3', 'L4']);
  });
});
