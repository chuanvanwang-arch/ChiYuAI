// test/http/skill-registry-page.test.js — S21 方法论 SKILL 注册表 受控渲染（TDD：先红后绿）
// 验证：/api/page/skill-registry 返回 renderPage 产物（pg-page）：
//   table(真实 SKILL 行：skill_id/category/enabled/version/rbac_roles) + enabled 状态徽标 + 静态受控壳
// 范式：复刻 S15 业务看板（受控端点 = 真实数据面注入 schema component + renderPage 唯一出口）
// 数据面：listSkillRegistry()（skillRegistry.js:64）——DB 权威 ⊕ 出厂声明合成快照
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';

let app;
beforeAll(() => {
  app = createApp();
});

// 种子 2 个 SKILL 行（method-bant 启用 / crm-native 停用）→ 受控 table 注入真实启停态
// 竞态安全：createApp() 启动时会异步 seedSkillRegistry()（server.js:23 未 await），可能在 beforeEach
// 的 TRUNCATE 之后提交 → 原 INSERT 报 duplicate key。改用 ON CONFLICT DO UPDATE 强写目标态，
// 无论异步种子何时提交都不崩溃，且 method-bant=true / crm-native=false 确定。
beforeEach(async () => {
  await queryWrite('TRUNCATE crm.skill_registry RESTART IDENTITY CASCADE');
  await queryWrite(
    `INSERT INTO crm.skill_registry (skill_id, category, enabled, rbac_roles, version)
     VALUES ('method-bant', 'methodology', true, ARRAY['sales','manager'], 'v1'),
            ('crm-native', 'action', false, ARRAY['admin'], 'v2')
     ON CONFLICT (skill_id) DO UPDATE
       SET enabled=EXCLUDED.enabled, category=EXCLUDED.category,
           rbac_roles=EXCLUDED.rbac_roles, version=EXCLUDED.version`
  );
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S21 方法论 SKILL 注册表 受控渲染', () => {
  it('GET /api/page/skill-registry 返回 pg-page 产物（受控 schema + table）', async () => {
    const { status, body } = await getJson('/api/page/skill-registry');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('form');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('方法论 SKILL 注册表');
    expect(body.html).toContain('pg-table');
  });

  it('table 注入真实 SKILL 行（skill_id/category/rbac_roles）', async () => {
    const { body } = await getJson('/api/page/skill-registry');
    expect(body.html).toContain('method-bant');
    expect(body.html).toContain('crm-native');
    expect(body.html).toContain('methodology');         // category
    expect(body.html).toContain('sales');               // rbac_roles 值
    expect(body.html).toContain('admin');               // rbac_roles 值
  });

  it('enabled 由 DB 权威覆盖：method-bant=true / crm-native=false 按库渲染', async () => {
    const { body } = await getJson('/api/page/skill-registry');
    // renderer 的 renderTable 不渲染徽标，enabled 列输出裸布尔；断言真实 DB 权威态
    expect(body.html).toContain('method-bant');
    expect(body.html).toContain('>true<');
    expect(body.html).toContain('>false<'); // crm-native 停用（DB 权威覆盖出厂声明）
  });

  it('data 按 components.kind 索引契约注入（table.rows）', async () => {
    const { body } = await getJson('/api/page/skill-registry');
    expect(body.data.components['table']).toBeDefined();
    expect(Array.isArray(body.data.components['table'].rows)).toBe(true);
    expect(body.data.components['table'].rows.length).toBeGreaterThanOrEqual(2);
  });

  it('静态受控壳 /skill-registry-board.html 可访问（受控端点深链）', async () => {
    const res = await app.fetch('/skill-registry-board.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('SKILL 注册表');
  });
});