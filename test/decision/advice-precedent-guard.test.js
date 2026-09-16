// test/decision/advice-precedent-guard.test.js
// E3（2026-09-16）先例检索硬前置的**机械守卫**。
//
// 背景：接线建议落库时，曾把"先例检索必须排除 ADVISED"列为人工硬前置——
//   否则 AI 的**推测**会混进**人的决策先例**，直接污染 autonomyEngine 的置信度依据
//   （先例越像→置信度越高→越容易自主放行，即「用 AI 自己的猜测给自己发通行证」）。
//
// 本任务改用独立表 crm.advice_record 后，该前置由**结构**满足（crm.decision 里永不出现 ADVISED）。
//   但"结构满足"必须可验，否则下一个人把它挪回去时无人报警 —— 本文把它变成断言：
//     ① 白名单不含 ADVISED（粗召回的准入闸是白名单，非黑名单）；
//     ② 运行态 crm.decision 零 ADVISED 行（真实库断言，不是"看代码觉得没有"）；
//     ③ 源码级：粗召回确实用白名单（防有人把 IN(...) 改成 state <> 'X' 的黑名单式）；
//     ④ 源码级：无任何模块向 crm.decision 写 ADVISED。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { query } from '../../src/db.js';
import { DECISION_DECIDED_STATES } from '../../src/decision/decisionRepo.js';
import { recordAdvice } from '../../src/decision/adviceRecord.js';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

describe('① 先例检索准入闸为白名单，且不含任何"非决策态"', () => {
  it('DECISION_DECIDED_STATES 是白名单且不含 ADVISED', () => {
    expect(Array.isArray(DECISION_DECIDED_STATES)).toBe(true);
    expect(DECISION_DECIDED_STATES.length).toBeGreaterThan(0);
    expect(DECISION_DECIDED_STATES, 'ADVISED 混入决策白名单 → AI 推测将成为先例').not.toContain('ADVISED');
  });
});

describe('③ 源码级：粗召回用白名单（黑名单式写法会让"新状态"默认混入）', () => {
  it('searchPrecedents 的粗召回以 IN (白名单) 过滤 state', () => {
    const src = read('../../src/decision/decisionRepo.js');
    const at = src.indexOf('export async function searchPrecedents');
    expect(at, 'searchPrecedents 不存在').toBeGreaterThan(0);
    const body = src.slice(at, at + 1200);
    expect(body, '粗召回未用 DECISION_DECIDED_STATES 白名单').toContain('DECISION_DECIDED_STATES');
    expect(body, '粗召回出现黑名单式 state <> 写法：新状态会默认混入先例池')
      .not.toMatch(/state\s*<>\s*'/);
  });
});

describe('④ 源码级：任何模块都不得向 crm.decision 写入 ADVISED', () => {
  it('全 src/ 无 state: ADVISED 的决策写入点', () => {
    const files = [
      '../../src/decision/adviceStore.js',
      '../../src/decision/adviceRecord.js',
      '../../src/decision/adviseService.js',
      '../../src/decision/autonomyEngine.js',
    ];
    for (const f of files) {
      const txt = read(f);
      expect(txt, `${f} 出现 state=ADVISED 写入：旧路线回潮，先例检索硬前置将失效`)
        .not.toMatch(/state\s*:\s*['"]ADVISED['"]/);
    }
  });
});

describe('② 运行态：crm.decision 零 ADVISED 行（真实库断言）', () => {
  const PROBE_TENANT = 'advice-guard-probe';

  beforeAll(async () => {
    // 自给自足：不依赖其他测试文件的副作用（共享库避免顺序依赖）
    await query(`DELETE FROM crm.advice_record WHERE tenant_id=$1`, [PROBE_TENANT]);
    await recordAdvice(
      { tier: 'C', scenario_id: 'ADV_GUARD', stage: 'S2', hits: ['guard'] },
      { tenantId: PROBE_TENANT }
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM crm.advice_record WHERE tenant_id=$1`, [PROBE_TENANT]);
  });

  it('已落库的建议不得在 crm.decision 留下任何行', async () => {
    const r = await query(`SELECT count(*)::int AS n FROM crm.decision WHERE state = 'ADVISED'`);
    expect(r.rows[0].n, 'crm.decision 出现 ADVISED 行 —— 先例检索将把 AI 推测当人的决策先例').toBe(0);
  });

  it('建议确实落在了 advice_record（反向确证：不是"两边都没写"的假绿）', async () => {
    const r = await query(`SELECT count(*)::int AS n FROM crm.advice_record WHERE tenant_id=$1`, [PROBE_TENANT]);
    expect(r.rows[0].n, 'advice_record 零行：落库链路可能整体没跑通').toBeGreaterThan(0);
  });
});
