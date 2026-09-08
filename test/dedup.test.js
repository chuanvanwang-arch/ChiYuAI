// test/dedup.test.js — P5 实体去重：全称/简称经 alias_of 归一到同一 canonical id
// 2026-09-08 追加：客户去重系统（docs/plans/2026-09-07-crm-dedup.md 任务5）
//   detectAccountDuplicate（创建闸）/ mergeIntoExisting / mergeTwoAccounts / 创建闸集成
import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryWrite } from '../src/db.js';
import { ensureDedupSchema, suggestMerge, confirmMerge } from '../src/particles/dedup.js';
import {
  detectAccountDuplicate, detectAccountDuplicateDeep,
  mergeIntoExisting, mergeTwoAccounts,
} from '../src/particles/dedup.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { actionExecutor } from '../src/action/executor.js';
import { requireDecision } from '../src/decision/autonomyEngine.js';
import { seedScenario } from './decision/_helpers.js';
import { seedActions } from '../src/action/seed-actions.js';

const DEDUP_SCEN = 'DEDUP_TEST_SCEN';
beforeEach(async () => {
  await ensureDedupSchema();
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await seedScenario(DEDUP_SCEN);
  seedActions(); // 注册最新 data-particle-create（含去重创建闸）
});

describe('P5 去重', () => {
  it('全称/简称经 alias_of 指向同一 canonical id', async () => {
    const a = await createParticle('CRM_ACCOUNT', { name: '北京智云科技有限公司', domains: ['zhiyun.com'] });
    const b = await createParticle('CRM_ACCOUNT', { name: '智云科技', alias_of: a.id });
    const s = await suggestMerge(b.id);
    expect(s.candidateId).toBe(a.id);
    await confirmMerge(b.id, a.id);
    const r = await query(`SELECT meta->>'merged_into' AS m FROM crm.particles WHERE id=$1`, [b.id]);
    expect(r.rows[0].m).toBe(String(a.id));
  });
});

// ─── 客户去重系统（2026-09-08 任务5）───────────────────────────────

describe('detectAccountDuplicate（创建闸查重检测）', () => {
  it('归一精确同名+行业相同 → MERGE', async () => {
    const a = await createParticle('CRM_ACCOUNT', { name: 'M 涂料科技有限公司', industry: '涂料/化工', named_owner: 'alice' });
    const r = await detectAccountDuplicate('m涂料科技有限公司 ', '涂料/化工', 'system');
    expect(r.decision).toBe('MERGE');
    expect(r.candidateId).toBe(a.id);
  });
  it('不同名（相距远）→ CREATE', async () => {
    await createParticle('CRM_ACCOUNT', { name: '上海宏远机械有限公司', industry: '机械', named_owner: 'alice' });
    const r = await detectAccountDuplicate('北京青羽智行科技', '软件', 'system');
    expect(r.decision).toBe('CREATE');
  });
  it('仅模糊相似（非精确）→ PROMPT', async () => {
    await createParticle('CRM_ACCOUNT', { name: '深圳兴达包装', industry: '包装', named_owner: 'alice' });
    const r = await detectAccountDuplicate('深圳兴达包装材料', '包装', 'system');
    expect(r.decision).toBe('PROMPT');
    expect(r.candidateId).toBeTruthy();
  });
});

describe('mergeIntoExisting（静默归并，不新建）', () => {
  it('字段级并入且返回已有 id', async () => {
    const a = await createParticle('CRM_ACCOUNT', { name: 'M 涂料科技', industry: '涂料/化工', contacts: [{ name: '苏研发' }], named_owner: 'alice' });
    const merged = await mergeIntoExisting(a.id, { contacts: [{ name: '吕生产' }], phone: '123' }, 'system');
    expect(merged.id).toBe(a.id);
    expect(merged.payload.phone).toBe('123');
    expect(merged.payload.contacts.length).toBe(2);
  });

  it('身份字段保护：主档名称不被从档后缀污染', async () => {
    // 回归：2026-09-08 实测从档带 "(中试推进)" 后缀，曾把主档名称覆盖成从档名
    const a = await createParticle('CRM_ACCOUNT', { name: 'M 涂料科技有限公司', industry: '涂料/化工', named_owner: 'alice' });
    const merged = await mergeIntoExisting(a.id, { name: 'M 涂料科技有限公司(中试推进)', stage: 'S1' }, 'system');
    expect(merged.payload.name).toBe('M 涂料科技有限公司'); // 主档身份不得被覆盖
    expect(merged.payload.stage).toBe('S1');               // 业务字段照常并入
  });
});

describe('mergeTwoAccounts（存量双账户软合并）', () => {
  it('边迁移 + merged_into 标记', async () => {
    const primary = await createParticle('CRM_ACCOUNT', { name: 'M 涂料科技', named_owner: 'alice' });
    const sec = await createParticle('CRM_ACCOUNT', { name: 'M涂料科技有限公司', named_owner: 'alice' });
    const contact = await createParticle('CRM_CONTACT', { name: '苏研发' }, { tenantId: 'system' });
    await queryWrite(
      `INSERT INTO crm.edges (tenant_id, source_type, source_id, edge_type, target_type, target_id, cardinality, meta)
       VALUES ('system','CRM_ACCOUNT',$1,'has_contact','CRM_CONTACT',$2,'many','{}')`,
      [sec.id, contact.id]);
    const res = await mergeTwoAccounts(primary.id, sec.id, 'system');
    expect(res.ok).toBe(true);
    const secAfter = (await query(`SELECT meta FROM crm.particles WHERE id=$1`, [sec.id])).rows[0];
    expect(secAfter.meta.merged_into).toBe(primary.id);
    const e = (await query(`SELECT source_id FROM crm.edges WHERE target_id=$1`, [contact.id])).rows[0];
    expect(e.source_id).toBe(primary.id); // 边已迁移
  });

  it('跨租户归并被硬闸拒绝', async () => {
    // 实测库中存在同名不同租户的 M 涂料科技（system / acme-chem），跨租户并进会污染数据隔离
    const p = await createParticle('CRM_ACCOUNT', { name: '跨租户甲', named_owner: 'alice' }, { tenantId: 'system' });
    const s = await createParticle('CRM_ACCOUNT', { name: '跨租户甲', named_owner: 'zhao' }, { tenantId: 'acme-chem' });
    await expect(mergeTwoAccounts(p.id, s.id, 'system')).rejects.toThrow(/cross_tenant_merge_denied/);
  });
});

describe('创建闸集成（data-particle-create handler）', () => {
  it('同名再创建 → 静默归并不新建', async () => {
    // 写通道第 0 闸语义：data-particle-create 无 autoDecision，须先 mint 真实 decision
    // 作为 decision_id 凭据（uuid + decision 表外键合法），等同生产 gateway 行为
    const d1 = await requireDecision(
      DEDUP_SCEN, { action: 'data-particle-create' }, [], { actor_id: 'alice', tenantId: 'system' });
    const ctx = { tenantId: 'system', actor: 'alice', bootstrap: false, decision_id: d1.decision.decision_id };
    const r1 = await actionExecutor.dispatch('data-particle-create',
      { type: 'CRM_ACCOUNT', payload: { name: 'M 涂料科技有限公司', industry: '涂料/化工' } }, ctx);
    // 第二调用（模拟再建同名）—— bootstrap=false 触发查重
    // 归一化精确相等（大小写/空格差异）→ MERGE 静默归并
    const d2 = await requireDecision(
      DEDUP_SCEN, { action: 'data-particle-create' }, [], { actor_id: 'alice', tenantId: 'system' });
    const ctx2 = { tenantId: 'system', actor: 'alice', bootstrap: false, decision_id: d2.decision.decision_id };
    const r2 = await actionExecutor.dispatch('data-particle-create',
      { type: 'CRM_ACCOUNT', payload: { name: 'm涂料科技有限公司 ', industry: '涂料/化工' } }, ctx2);
    expect(r2.data?.merged).toBe(true);
    expect(r2.data.particle.id).toBe(r1.data.id); // 同一账户，无重复
    const cnt = (await query(`SELECT COUNT(*) FROM crm.particles WHERE type='CRM_ACCOUNT'`)).rows[0].count;
    expect(Number(cnt)).toBe(1);
  });
  it('bootstrap（seed）豁免查重', async () => {
    const ctx = { tenantId: 'system', actor: 'system', bootstrap: true, decision_id: null };
    await actionExecutor.dispatch('data-particle-create',
      { type: 'CRM_ACCOUNT', payload: { name: '演示A', named_owner: 'system' } }, ctx);
    const r2 = await actionExecutor.dispatch('data-particle-create',
      { type: 'CRM_ACCOUNT', payload: { name: '演示A', named_owner: 'system' } }, ctx);
    expect(r2.data?.merged).toBeFalsy(); // seed 允许重复（历史演示数据）
  });
});
