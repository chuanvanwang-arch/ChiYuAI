// test/decision/methodologyEvidenceView.test.js — P3 D1 续：Pre 装配「当前方法论证据」三件套收口
//
// 被测能力：buildMethodologyEvidenceView 把 F5 算出的方法论证据（14 维 met/null）并回决策前链路，
//   与 autonomyEngine ②a-2 **同口径**（先读落库断言 → DEAL 粒子读时派生垫底 → mergeEvidence 派生垫底），
//   但**只读、无 autofill 副作用**。决策者在写前即看到 概念清单 + 启用规则 + 当前证据 三件套。
//
// 红线（任何回归必须立刻红）：
//   ① DEAL 有预算信号 → B 维派生 met=true（不靠存储、不静默）
//   ② 无字段信号的维度**不产出**（保持 met=null，绝不冒充不达标——F5 错误本体不可复发）
//   ③ 非 DEAL 主体 / 无主体 / 空 methodologyIds → 返回 {}（fail-open，不派生假证据）
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query, pool } from '../../src/db.js';
import { buildMethodologyEvidenceView } from '../../src/decision/methodologyExtractor.js';

// 用区别于 F5 测试的 uuid，避免共享库 fixture 碰撞
const DEAL_ID = 'f5000000-0000-4000-8000-0000000000e1';
const ACC_ID = 'f5000000-0000-4000-8000-0000000000a1';
const MIDS = ['BANT', 'MEDDICC', 'OPP_MATRIX'];
// 生产实测形态（CRM_DEAL 有 expected_amount/probability，无 authority/needs 等字段）
const PROD_SHAPE = {
  name: '测试礼品盒项目', stage: 'lead', amount: 173128,
  probability: 0.75, expected_amount: 3351935, win_strategy: '差异化方案设计',
};

async function clean() {
  await query(`DELETE FROM crm.particles WHERE id = ANY($1)`, [[DEAL_ID, ACC_ID]]);
}
async function upsertDeal() {
  await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
     VALUES ($1,'system','CRM_DEAL',$2,$3,'ACTIVE',$4::jsonb)`,
    [DEAL_ID, `deal-${DEAL_ID}`, '测试礼品盒', JSON.stringify(PROD_SHAPE)]
  );
}

beforeEach(async () => { await clean(); await upsertDeal(); });
afterAll(async () => { await clean(); });

describe('buildMethodologyEvidenceView', () => {
  it('红线①：DEAL 有预算信号 → B 维派生 met=true（仅靠读时派生，不依赖存储）', async () => {
    const ev = await buildMethodologyEvidenceView(pool, { subjectId: DEAL_ID, methodologyIds: MIDS, tenant: 'system' });
    expect(ev && ev.B).toBeDefined();
    expect(ev.B.met).toBe(true); // expected_amount 字段信号 → 派生 met=true
    expect(ev.B.source).toBe('derived');
  });

  it('红线②：无字段信号的维度不产出（保持 met=null，不冒充不达标）', async () => {
    const ev = await buildMethodologyEvidenceView(pool, { subjectId: DEAL_ID, methodologyIds: MIDS, tenant: 'system' });
    // PROD_SHAPE 无 authority/needs/expected_close_date → A/N/T 等维度不得被伪造
    expect(ev.A).toBeUndefined();
    expect(ev.N).toBeUndefined();
    expect(ev.T).toBeUndefined();
  });

  it('红线③：无主体 / 空 methodologyIds → 返回 {}（fail-open 友好）', async () => {
    expect(await buildMethodologyEvidenceView(pool, { subjectId: null, methodologyIds: MIDS })).toEqual({});
    expect(await buildMethodologyEvidenceView(pool, { subjectId: DEAL_ID, methodologyIds: [] })).toEqual({});
  });

  it('红线③续：非 DEAL 粒子（CRM_ACCOUNT）不派生（形状/类型闸）', async () => {
    await query(
      `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
       VALUES ($1,'system','CRM_ACCOUNT',$2,$3,'ACTIVE',$4::jsonb)`,
      [ACC_ID, `acc-${ACC_ID}`, '某客户', JSON.stringify({ name: 'x' })]
    );
    const ev = await buildMethodologyEvidenceView(pool, { subjectId: ACC_ID, methodologyIds: MIDS, tenant: 'system' });
    expect(ev).toEqual({}); // 非 DEAL 不派生，避免误把账户当商机证据
  });
});
