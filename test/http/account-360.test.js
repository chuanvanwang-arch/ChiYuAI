// test/http/account-360.test.js — S06 客户 360 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/account-360 返回 renderPage(S06_SCHEMA) 产物，且 7 维指标卡为「派生真实值」（非七卡同值）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

let app;
let token;
beforeAll(async () => {
  app = createApp();
  // /api/page/account-360 需认证（resolveMe → 401）。与全仓其它受测路由一致，直接 issueToken
  // 签发 Bearer，避免依赖测试库是否含 admin 登录种子（route 仅校验 token 签名，不查 crm_users）。
  token = issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' });
});

// plm_test 无种子（home 测试会 TRUNCATE），此处自造 account/contact/deal/event 最小闭环
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges, crm.events RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a1111111-1111-1111-1111-111111111101','system','CRM_ACCOUNT','account-yintong','上海印通包装科技有限公司','ACTIVE',
     '{"name":"上海印通包装科技有限公司","industry":"包装印刷","region":"华东","rating":"A","last_interaction":"2026-08-20T09:00:00+08:00"}',
     '2026-06-01T09:00:00+08:00','2026-08-20T09:00:00+08:00'),
    ('a2222222-2222-2222-2222-222222222201','system','CRM_CONTACT','contact-liwei','李伟','ACTIVE',
     '{"name":"李伟","title":"采购总监","decision_power":"high"}',
     '2026-06-02T10:00:00+08:00','2026-08-20T09:00:00+08:00'),
    ('d1111111-1111-1111-1111-111111111111','system','CRM_DEAL','deal-lead','彩盒打样询盘','ACTIVE',
     '{"name":"彩盒打样询盘","stage":"lead","expected_amount":120000,"probability":0.10,"account_id":"a1111111-1111-1111-1111-111111111101","owner":"王川"}',
     '2026-08-18T09:00:00+08:00','2026-08-18T09:00:00+08:00')`);
  await query(`INSERT INTO crm.events (id, domain, type, payload, actor, created_at) VALUES
    ('e1111111-1111-1111-1111-111111111101','trace','note',
     '{"account_id":"a1111111-1111-1111-1111-111111111101","title":"首次拜访客户","type":"note"}',
     'system','2026-08-20T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

describe('S06 客户 360 受控渲染（真实数据）', () => {
  it('GET /api/page/account-360 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/account-360');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-metric-card');
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('pg-table');       // 最新动态表（替代原关联 subtable）
    expect(body.html).toContain('pg-result-card'); // AI 下一步建议卡
  });

  it('七维指标卡为按 title 派生的真实值（治理=缺失、决策历史=部分，其余=完整 → 不全相等）', async () => {
    const { body } = await getJson('/api/page/account-360');
    expect(body.html).toContain('缺失'); // 治理维缺 owner/rbac
    expect(body.html).toContain('部分'); // 决策历史仅有 last_interaction
    const vals = [...body.html.matchAll(/pg-value">([^<]*)</g)].map(m => m[1]);
    const metricVals = vals.filter(v => ['完整', '部分', '缺失'].includes(v));
    expect(metricVals.length).toBeGreaterThanOrEqual(7);
    expect(new Set(metricVals).size).toBeGreaterThan(1); // 至少两种取值 → 非七卡同值
  });

  it('属性字段注入真实值（客户名称/行业来自真实 account payload）', async () => {
    const { body } = await getJson('/api/page/account-360');
    expect(body.html).toContain('上海印通包装科技有限公司');
    expect(body.html).toContain('包装印刷');
  });

  it('AI 建议聚合真实商机/联系人数量，且不再内嵌 subtable（详细关联已移至洞察页）', async () => {
    const { body } = await getJson('/api/page/account-360');
    // 详细商机/联系人内嵌视图已迁移至 /accounts/:id/insight，摘要页仅聚合计数到 AI 建议
    expect(body.html).toContain('pg-result-card');
    expect(body.html).toContain('1 个商机');
    expect(body.html).toContain('1 个联系人');
    expect(body.html).not.toContain('pg-subtable');
  });

  it('静态页 /account-360.html 含画像注入锚点（profile-root）', async () => {
    const res = await app.fetch('/account-360.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="profile-root"');
  });

  it('S06 reasoning-trace 注入真状态（种子画像完整+七维完整+有关联任务 → 非写死回传，T4）', async () => {
    const { body } = await getJson('/api/page/account-360');
    const steps = body.data?.components?.['reasoning-trace']?.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s.label)).toEqual(['画像装配', '七维校验', '洞察建议']);
    // 种子：industry/region/rating 齐 → profileFilled=true；七维含「缺失」治理维 → sevenDimCovered=false；
    // beforeEach 已种 crm.events（account_id 命中）→ 真实活动信号 tasksNonEmpty=true
    //   （S06 死区修复：routes.js 改用 crm.events 替代恒空的 crm.tasks 探测，故「有活动→ok」非写死 idle）
    // 契约：画像 ok（有必填画像字段）、七维 warn（非全完整）、洞察 ok（有跟进活动）
    expect(steps[0].status).toBe('ok');
    expect(steps[1].status).toBe('warn');
    expect(steps[2].status).toBe('ok');
  });
});
