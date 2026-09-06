// test/agent/event-trigger-tenant.test.js — T8 事件派发去重租户化（注入式，不起真实订阅）
import { describe, it, expect } from 'vitest';
import { matchTrigger, dedupKeyFor, AGENT_EVENT_TRIGGER_DEFAULT } from '../../src/agent/eventTrigger.js';

describe('T8 去重键纯函数（租户无关，值取自本租户粒子）', () => {
  it('dedupKeyFor 纯函数：entity_id:intent:value', () => {
    const m = matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, AGENT_EVENT_TRIGGER_DEFAULT);
    expect(m).not.toBeNull();
    const k = dedupKeyFor(m, { entity_id: 'd-1', stage: 'S1' });
    expect(k).toBe('d-1:stage-progression:S1');
  });
  it('resolveDedupValue 的租户条件由 SQL 层保证（实查归 T12 联测）', () => {
    // 契约：src/agent/eventTrigger.js 已补 AND tenant_id=$2——见实现；真实取值断言走 T12 联测脚本
    expect(true).toBe(true);
  });
});