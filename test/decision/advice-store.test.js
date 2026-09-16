// 建议摘要口径 + E3 退役守卫（对话驱动决策建议 T8 / 2026-09-16 E3 变更）
//
// E3 变更：建议落库从「crm.decision + state='ADVISED'」改为独立运行态表 crm.advice_record。
//   本文件守护两件事：
//     ① 摘要口径（禁对话原文）不变；
//     ② 旧路线（向 crm.decision 写 ADVISED 锚点）**不得回潮**——它已因污染统计面被否决。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as store from '../../src/decision/adviceStore.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
// 本文件位于 test/decision/，故回仓根需 ../../

describe('结构化摘要（对话原文零落库，D2 前提）', () => {
  it('摘要含场景与阶段，且不含任何对话原文片段', () => {
    // 故意多传 utterance：实现签名不消费该字段，摘要中不得出现任何原文片段
    const s = store.buildStructuredSummary({
      scenario_id: 'QUOTE_PRICING', stage: 'S4', hits: ['折扣'],
      utterance: '客户要求 8 折，还要再降 10%（这句原文不得入库）',
    });
    expect(s).toContain('QUOTE_PRICING');
    expect(s).toContain('S4');
    expect(s).toContain('折扣');
    expect(s).not.toContain('还要再降 10%');
  });

  it('摘要长度 ≤120 且长输入只截断不延展', () => {
    const s = store.buildStructuredSummary({ scenario_id: 'OPP_QUALIFY', stage: 'S2', hits: ['预'.repeat(500)] });
    expect(s.length).toBeLessThanOrEqual(120);
  });

  it('未定位场景 / 无关键词命中时给出显式口径（不静默为空）', () => {
    expect(store.buildStructuredSummary({})).toContain('未定位');
    expect(store.buildStructuredSummary({ scenario_id: 'OPP_QUALIFY', stage: 'S2' })).toContain('无关键词命中');
  });
});

describe('E3 退役守卫：不再向 crm.decision 写 ADVISED 锚点', () => {
  it('ADVISED_STATE / buildAdviceAnchor 已退役（导出不存在）', () => {
    expect(store.ADVISED_STATE).toBeUndefined();
    expect(store.buildAdviceAnchor).toBeUndefined();
  });

  it('adviceStore / adviceRecord 源码均不得出现 state=ADVISED 或 createDecision 调用', () => {
    const s = read('../../src/decision/adviceStore.js');
    expect(s, 'adviceStore 出现 ADVISED 状态写入 —— 旧路线回潮').not.toMatch(/^\s*state:\s*['"]ADVISED['"]/m);
    expect(s, 'ADVISED_STATE 应保持退役').not.toMatch(/export const ADVISED_STATE/);
    const rec = read('../../src/decision/adviceRecord.js');
    // 自包含去注释（不依赖文件级 helper，避免"定义丢、用法留"的不对称改动）
    const recCode = read('../../src/decision/adviceRecord.js')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
    expect(recCode, 'adviceRecord 不得走 createDecision（会污染 crm.decision 并受 sevenDimensionsCheck 拦截）')
      .not.toMatch(/createDecision/);
  });

  it('新建库 DDL 与幂等迁移两处均含 crm.advice_record（防"只改一处"漂移）', () => {
    for (const p of ['../../db/schema.sql', '../../db/migration-advice-record.sql']) {
      const txt = read(p);
      expect(txt, `${p} 缺 advice_record 建表`).toContain('crm.advice_record');
      expect(txt, `${p} 缺轴约束`).toContain('ck_advice_record_tier_axis');
    }
  });
});
