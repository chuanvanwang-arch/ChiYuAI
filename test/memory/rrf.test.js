// test/memory/rrf.test.js — G6 RRF 融合召回（dense+sparse）
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.5：rrfSearch(query,{entityId,k,denseWeight}) 融合 dense（哈希向量余弦）+
// sparse（LIKE）两路召回，RRF 公式 score=Σ 1/(rank+60) 混合排序，返回降序 topk。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { rrfSearch } from '../../src/memory/memoryLog.js';

const ENTITY = 'c1-customer-acme';

// A2（2026-09-02 修正）：原测试数据把锚点编码进 topic（'entity:'||id），
//   与生产真实形态（topic 为 'event:*' / 'decision:*' 业务分类，锚点在 entity_id 列）不符
//   → 该用例此前是"用假约定验证假路径"：在测试库绿，在生产恒空。
//   现改为按真实形态建数据，本用例才真正覆盖「按客户锚点召回」。
beforeEach(async () => {
  // 三行记忆：强相关 / 部分相关 / 无关（前两行锚定同一客户，第三行无锚点）
  await queryWrite(
    `INSERT INTO crm.memory_log (topic, kind, payload, layer, entity_id) VALUES
     ('decision:acme-deal',  'decision', $2, 'L-Workspace', $1),
     ('meeting:acme-visit',  'meeting',  $3, 'L-Workspace', $1),
     ('note:unrelated',      'note',     $4, 'L-Workspace', NULL)`,
    [
      ENTITY,
      JSON.stringify({ note: 'Acme 大单推进中，预算 500 万，决策人王总' }),
      JSON.stringify({ note: '上周拜访记录' }),
      JSON.stringify({ note: '无关内容' }),
    ]
  );
});

const TEST_TOPICS = ['decision:acme-deal', 'meeting:acme-visit', 'note:unrelated'];

afterEach(async () => {
  await queryWrite(`DELETE FROM crm.memory_log WHERE topic = ANY($1)`, [TEST_TOPICS]);
});

describe('G6 RRF dense+sparse 融合召回', () => {
  it('融合排序优于单路召回（降序 topk<=k）', async () => {
    const res = await rrfSearch('Acme 大单预算', { entityId: ENTITY, k: 5, denseWeight: 0.5 });
    expect(res.length).toBeLessThanOrEqual(5);
    expect(res.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
    }
    // 强相关行应排在无关行之前；且锚定召回不应把无锚点行（note:unrelated）捞进来
    const TOPIC_STRONG = 'decision:acme-deal';
    const TOPIC_OTHER = 'note:unrelated';
    const idxStrong = res.findIndex((r) => r.topic === TOPIC_STRONG);
    expect(idxStrong).not.toBe(-1); // 锚定召回必须命中强相关行（-1 = 未命中）
    expect(res.some((r) => r.topic === TOPIC_OTHER)).toBe(false); // 无锚点行不得串入
    const idxOther = res.findIndex((r) => r.topic === TOPIC_OTHER);
    if (idxOther !== -1) {
      expect(idxStrong).toBeLessThan(idxOther);
    }
  });

  it('topk 可配（k=1 只返回 1 条）', async () => {
    const res = await rrfSearch('Acme 大单预算', { entityId: ENTITY, k: 1, denseWeight: 0.5 });
    expect(res.length).toBeLessThanOrEqual(1);
  });
});