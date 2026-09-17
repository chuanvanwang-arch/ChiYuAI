// test/channels/entityExtractor.test.js
// T3：§5 实体抽取——事件行 → {domain, company, participants, intents, signals}
// 判据：意图/信号按结构化文本模式抽取；空输入 fail-safe 空结构（不抛）；不落原始内容
import { describe, it, expect } from 'vitest';
import { extractEntities } from '../../src/channels/entityExtractor.js';

describe('entityExtractor', () => {
  it('事件行 → 实体（domain/company/participants）', () => {
    const ev = { domain: 'acme.com', participants: [{ name: '赵采购', email: 'zhao@acme.com', corp: 'acme.com' }], content: { subject: '报价' } };
    const ents = extractEntities(ev);
    expect(ents.domain).toBe('acme.com');
    expect(ents.company).toBe('acme.com');
    expect(ents.participants[0].name).toBe('赵采购');
  });

  it('文本含「招标/拜访」→ tender/visit 意图 + 对应信号', () => {
    const ev = { domain: 'acme.com', content: { subject: '关于招标与拜访安排', snippet: '下周应标' } };
    const ents = extractEntities(ev);
    expect(ents.intents).toEqual(expect.arrayContaining(['tender', 'visit']));
    expect(ents.signals).toEqual(expect.arrayContaining(['tender_push', 'follow_reminder']));
  });

  it('空输入 fail-safe 返回空结构（不抛）', () => {
    expect(extractEntities({})).toEqual({ domain: null, company: null, participants: [], intents: [], signals: [] });
    expect(extractEntities(null)).toEqual({ domain: null, company: null, participants: [], intents: [], signals: [] });
  });
});
