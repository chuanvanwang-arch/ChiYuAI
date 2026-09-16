// test/agent/eventTrigger.s5.test.js — T12 三源触发器（向后兼容旧 matchTrigger 签名）
import { describe, it, expect } from 'vitest';
import { emit, on } from '../../src/events/bus.js';
import {
  matchTriggerBySource, matchTrigger, AGENT_EVENT_TRIGGER_DEFAULT,
  setSignalStore, createEventTrigger,
} from '../../src/agent/eventTrigger.js';

const CFG = AGENT_EVENT_TRIGGER_DEFAULT;

describe('T12 三源匹配（matchTriggerBySource）', () => {
  it('event(ontology) 旧行可匹配', () => {
    const m = matchTriggerBySource({ source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL' }, CFG);
    expect(m).toBeTruthy();
    expect(m.skill_slug).toBe('method-stage-progression');
  });
  it('event(particle) 新增域行可匹配', () => {
    const m = matchTriggerBySource({ source: 'event', domain: 'particle', type: 'particle-change', entity_type: 'CRM_ACCOUNT' }, CFG);
    expect(m).toBeTruthy();
    expect(m.source).toBe('event');
  });
  it('event(approval) 新增域行可匹配', () => {
    const m = matchTriggerBySource({ source: 'event', domain: 'approval', type: 'approval-event', entity_type: 'CRM_DEAL' }, CFG);
    expect(m).toBeTruthy();
  });
  it('timer 源行可匹配', () => {
    const m = matchTriggerBySource({ source: 'timer', domain: 'schedule', type: 'signal-schedule', entity_type: 'CRM_DEAL' }, CFG);
    expect(m).toBeTruthy();
  });
  it('external 源行可匹配', () => {
    const m = matchTriggerBySource({ source: 'external', domain: 'external-sync', type: 'sync-new', entity_type: 'CRM_ACCOUNT' }, CFG);
    expect(m).toBeTruthy();
  });
  it('非只读 SKILL 被拒并 emit trace', () => {
    const traces = [];
    const off = on('trace', (msg) => { if (msg.type === 'agent-event-trigger-rejected') traces.push(msg); });
    const bad = { ...CFG.matrix[0], skill_slug: 'conn-attio-enrich-account' };
    const m = matchTriggerBySource({ source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL' }, { ...CFG, matrix: [bad] });
    off();
    expect(m).toBeNull();
    expect(traces.length).toBe(1);
  });
});

describe('向后兼容旧 matchTrigger 签名', () => {
  it('旧签名仍命中 ontology 行', () => {
    const m = matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, CFG);
    expect(m?.intent).toBe('stage-progression');
  });
  it('旧签名非只读返回 null', () => {
    const cfg = { ...CFG, matrix: [{ ...CFG.matrix[0], skill_slug: 'method-decision-execute' }] };
    expect(matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, cfg)).toBeNull();
  });
});

describe('dispatchFromTrigger 感知落库（新域触发后落 crm.signal + dedup）', () => {
  it('particle 域匹配 → 落一条信号；二次同键 dedup', async () => {
    const created = [];
    const fakeStore = {
      create(o) {
        // 模拟 store 幂等：同 dedup_key 第二次返回 deduped
        const hit = created.find((c) => c.dedup_key === o.dedup_key);
        if (hit) return Promise.resolve({ ok: true, deduped: true, alert: hit });
        created.push(o);
        return Promise.resolve({ ok: true, deduped: false, alert: { signal_id: 's' + created.length } });
      },
    };
    setSignalStore(fakeStore);
    const { dispatchFromTrigger } = createEventTrigger({ pool: null });
    const m1 = await dispatchFromTrigger({ source: 'event', domain: 'particle', type: 'particle-change', entity_type: 'CRM_ACCOUNT' }, { entity_id: 'acc-x', tenant_id: 't1' }, 't1');
    const m2 = await dispatchFromTrigger({ source: 'event', domain: 'particle', type: 'particle-change', entity_type: 'CRM_ACCOUNT' }, { entity_id: 'acc-x', tenant_id: 't1' }, 't1');
    expect(m1).toBeTruthy();
    expect(m2).toBeTruthy();
    expect(created.length).toBe(1); // dedup 生效，未叠加
    expect(created[0].source).toBe('event-trigger');
  });
});
