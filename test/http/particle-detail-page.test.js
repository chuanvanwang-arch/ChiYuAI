// test/http/particle-detail-page.test.js — S13 粒子详情 受控渲染（TDD：先红后绿）
// 验证：/api/page/particle-detail 返回 buildParticleDetailSchema(动态组装) + renderPage 产物：
//   attr-field(真实 payload 注入 + 四查徽标) + subtable(出边关联) + 无 id 默认取首粒子 + 静态页兼容
// 范式：复刻 S12 发票详情（routes 端点 + renderPage 唯一出口 + 统一壳静态页）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => {
  app = createApp();
});

// 建 1 个 CRM_DEAL 粒子（带 payload 四字段 + 1 条出边 → 动态 schema 组装 attr-field + subtable）
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(
    `INSERT INTO crm.particles (id, type, slug, title, state, tenant_id, payload)
     VALUES ('11111111-1111-1111-1111-111111111111', 'CRM_DEAL', 'deal-food-gift', '食品礼盒-商机', 'QUALIFIED',
             'system', $1::jsonb)`,
    [JSON.stringify({ name: '食品礼盒-商机', amount: 1500000, stage: 'qualification', owner: 'alice' })]
  );
  await query(
    `INSERT INTO crm.edges (tenant_id, source_id, source_type, target_id, target_type, edge_type, meta)
     VALUES ('system', '11111111-1111-1111-1111-111111111111', 'CRM_DEAL',
             '22222222-2222-2222-2222-222222222222', 'CRM_ACCOUNT', 'belongs_to', '{}')`
  );
  await query(
    `INSERT INTO crm.particles (id, type, slug, title, state, tenant_id, payload)
     VALUES ('22222222-2222-2222-2222-222222222222', 'CRM_ACCOUNT', 'acct-food-group', '食品集团', 'ACTIVE', 'system', '{}'::jsonb)`
  );
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S13 粒子详情 受控渲染', () => {
  it('GET /api/page/particle-detail 返回 pg-page 产物（动态 schema + attr-field + 来源徽标）', async () => {
    const { status, body } = await getJson('/api/page/particle-detail?id=11111111-1111-1111-1111-111111111111');
    console.log('[S13-probe] status=', status, 'error=', body?.error);
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('CRM_DEAL 详情');      // 动态标题（schema 组装）
    expect(body.html).toContain('pg-source-badge');     // 四查徽标（particleDetailRouter attr 带 data_origin）
  });

  it('attr-field 注入真实 payload 字段（name/amount/stage/owner）', async () => {
    const { status, body } = await getJson('/api/page/particle-detail?id=11111111-1111-1111-1111-111111111111');
    console.log('[S13-probe-2] status=', status, 'error=', body?.error, 'hasHtml=', !!body?.html);
    expect(body.html).toContain('食品礼盒-商机');
    expect(body.html).toContain('1500000');
    expect(body.html).toContain('alice');
    expect(body.html).toContain('qualification');        // stage 值
  });

  it('subtable 注入出边关联（belongs_to → CRM_ACCOUNT）', async () => {
    const { body } = await getJson('/api/page/particle-detail?id=11111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('pg-subtable');
    expect(body.html).toContain('belongs_to');           // mainColumn=edgeType
    expect(body.html).toContain('CRM_ACCOUNT');          // subColumn=targetType
  });

  it('无 id 时默认取首粒子（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/particle-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('CRM_DEAL 详情');
  });

  it('静态受控页 /particle-detail-board.html 可访问（粒子详情标题）', async () => {
    const res = await app.fetch('/particle-detail-board.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('粒子详情');
  });
});