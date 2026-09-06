// test/http/connector-zhizao.test.js — T8 外部工商采集闭环（方案 A：读链路 + 手动同步端点）
// 契约：POST /api/connector/zhizao-verify（admin/sysadmin 闸）→ dispatch conn-zhizao-verify-account
//       → 第0闸 produceDecision + F18 抬头校验 + business_verified/business_title 落库
//       → S35 读链路（/api/page/account-insight 的 attr-field biz 注入）消费
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

let app;
let adminToken;
let salesToken;
beforeAll(() => {
  app = createApp(); // routes.js:273 seedConnectorActions() 已注册 conn-zhizao-verify-account
  adminToken = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
  salesToken = issueToken({ username: 't-sales', role: 'sales', display_name: '销售' });
});

// plm_test 无种子，自造最小 account + EXTERNAL_ENRICHMENT 决策场景（第0闸必需；与 db/test-setup.sql 同源）
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges, crm.events RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.decision_scenario (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed) VALUES
    ('EXTERNAL_ENRICHMENT', 'meta', '外部数据自动采集（连接器写客户，第0闸载体）',
     '{"action":["conn-attio-enrich-account","conn-zhizao-verify-account"]}'::jsonb,
     ARRAY[]::TEXT[],
     '[{"cond":"source_legit","label":"来源合规","weight":1,"required":true},{"cond":"data_origin","label":"数据落唯一事实字段","weight":1,"required":true},{"cond":"approval","label":"对外部写已授权","weight":1,"required":true}]'::jsonb,
     'HIGH', FALSE)
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`);
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a5555555-5555-5555-5555-555555555555','system','CRM_ACCOUNT','account-zhenghe','浙江正合智造有限公司','ACTIVE',
     '{"name":"浙江正合智造有限公司","industry":"装备制造","region":"华东"}',
     '2026-06-01T09:00:00+08:00','2026-08-20T09:00:00+08:00')`);
});

const VERIFY_BODY = {
  account_id: 'a5555555-5555-5555-5555-555555555555',
  verification: {
    verified: true,
    business_title: '浙江正合智造有限公司',
    source_knowledge_id: 'a1b2c3d4-1111-1111-1111-111111111111', // 合法 UUID（连接器知识源 id）
    confidence: 0.92,
  },
};

describe('T8 外部工商采集闭环（conn-zhizao-verify）', () => {
  it('POST /api/connector/zhizao-verify（admin）→ 落库 business_verified/business_title + 返回 decision_id', async () => {
    const res = await app.fetch('/api/connector/zhizao-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(VERIFY_BODY),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.decision_id).toBeTruthy(); // 第0闸 mint 的决策 ID

    // 落库验证：account payload 写入工商事实（非人工冒充，F18 已校验抬头）
    const r = await query("SELECT payload FROM crm.particles WHERE id='a5555555-5555-5555-5555-555555555555'");
    expect(r.rows[0].payload.business_verified).toBe(true);
    expect(r.rows[0].payload.business_title).toBe('浙江正合智造有限公司');

    // sourcedFrom 边（auto_weak 来源语义 + relation_confidence 落 meta）
    // edges 列：edge_type（受控谓词）+ meta（置信度落 JSONB）
    const e = await query("SELECT * FROM crm.edges WHERE source_id='a5555555-5555-5555-5555-555555555555' AND edge_type='sourcedFrom'");
    expect(e.rows.length).toBe(1);
    expect(e.rows[0].meta?.relation_confidence).toBe(0.92);
  });

  it('sales 无权触发（403：外部写通道仅 admin/sysadmin）', async () => {
    const res = await app.fetch('/api/connector/zhizao-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${salesToken}` },
      body: JSON.stringify(VERIFY_BODY),
    });
    expect(res.status).toBe(403);
    const j = await res.json();
    expect(j.error).toBe('forbidden');
    expect(j.gate).toBe('role');
  });

  it('缺参数 → 400（account_id 与 verification 必填）', async () => {
    const res = await app.fetch('/api/connector/zhizao-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ account_id: 'a5555555-5555-5555-5555-555555555555' }),
    });
    expect(res.status).toBe(400);
  });

  it('F18 校验闸：非法抬头拒绝（对象形式缺四要素 → 500）', async () => {
    const res = await app.fetch('/api/connector/zhizao-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        account_id: 'a5555555-5555-5555-5555-555555555555',
        verification: {
          verified: true,
          // 对象形式 = 连接器结构化工商档案：四要素（credit_code/reg_address/legal_person）缺失 → F18 拒绝
          business_title: { title: '短' },
        },
      }),
    });
    expect(res.status).toBe(400); // F18 校验拒绝 → 4xx 业务拒绝（端点不透传 200）
    const j = await res.json();
    expect(j.error).toContain('工商抬头校验拒绝');
  });

  it('S35 读链路：工商采集后 /api/page/account-insight 的 attr-field biz 注入 verified=true + 抬头', async () => {
    // 先触发采集
    await app.fetch('/api/connector/zhizao-verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(VERIFY_BODY),
    });
    // 读 S35
    const res = await app.fetch(`/api/page/account-insight?accountId=a5555555-5555-5555-5555-555555555555`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data?.components?.['attr-field']?.biz?.value).toBe('浙江正合智造有限公司');
    expect(j.data?.components?.['attr-field']?.biz?.verified).toBe(true);
  });
});