// test/http/controlled-config-pages.test.js — 受控配置页工厂（S17/S19/S23/S24）
// 验证：通用工厂把「schema + SQL + 列映射」声明转成 /api/page/<id> 受控端点，
//       每面均返回 renderPage 产物（pg-page）+ table 契约结构 + 真实 DB 行（既有种子）。
// 范式：复刻 S21（data.components.table 索引契约 + renderPage 唯一出口），差异仅在工厂声明表。
//
// ⚠️⚠️ 隔离纪律（本套件踩过两次坑，改测试前必读）⚠️⚠️
//  1. **禁止 TRUNCATE**：crm.decision_scenario 是 crm.decision 的外键父表，清表会连锁击穿
//     decision-graph / p4-new-deal / http.test.js（实测 9 例失败）。
//  2. **禁止 INSERT/DELETE 种子**：本套件与上述套件并行共享同一 PG 库，任何写操作都会与
//     并发套件产生竞态（实测插入 CPG_ 行 + afterEach 精确删除，仍导致 2 例 flaky）。
//  3. **正确姿势 = 纯只读**：受控端点是只读视图，测试只断言端点契约 + 既有稳定种子值，零写库。
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';

let app;
beforeAll(() => {
  app = createApp();
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

// 参数化：每面 = 端点 id + schema.type + 可选 probe（既有稳定种子值；不确定的面只断结构）
const CASES = [
  // 批1（表驱动，已验证）
  { id: 'users', type: 'form', probe: 'alice' },              // crm_users 必有 alice（登录基线）
  { id: 'decision-scenarios', type: 'form', probe: 'LEAD_FOLLOW_UP' }, // 决策场景（P4 依赖，稳定）
  { id: 'business-tier', type: 'form', probe: null },
  { id: 'meta-attr', type: 'form', probe: null },
  // 批2（表驱动 6 面）
  { id: 'llm', type: 'form', probe: null },                   // config_store 可能未配置（PUT 后才有）
  { id: 'rbac', type: 'form', probe: null },
  { id: 'seven-dim', type: 'form', probe: null },
  { id: 'approval-flows', type: 'form', probe: null },
  { id: 'alert-rules', type: 'form', probe: null },
  { id: 'mcp-identities', type: 'form', probe: null },
  // 批3（函数/内存驱动 5 面）
  { id: 'pool-config', type: 'form', probe: null, form: true }, // S25 表单型（无 table，注入 attr-field）
  { id: 'vocabulary', type: 'form', probe: null },
  { id: 'agent-config', type: 'form', probe: null },           // agentSpecs 内存定义，必有行
  { id: 'portal-pages', type: 'form', probe: null },
  { id: 'decision-quality', type: 'dashboard', probe: null },  // S30 schema type='dashboard'（非 form）
  // S01 系统状态墙：多源聚合页（3×metric-card 按 title 索引 value + 最新粒子 table.rows），type='dashboard'
  { id: 'system-status', type: 'dashboard', probe: null, multi: true },
];

describe('受控配置页工厂（S17/S19/S23/S24）', () => {
  for (const c of CASES) {
    it(`GET /api/page/${c.id} 返回 pg-page 产物 + table 契约结构`, async () => {
      const { status, body } = await getJson(`/api/page/${c.id}`);
      expect(status).toBe(200);
      expect(body.schema.type).toBe(c.type);
      expect(body.html).toContain('pg-page');
      if (c.form) {
        // 表单型页（如 S25 池配置）：schema 无 table 组件，注入目标是 attr-field
        expect(body.html).toContain('pg-attr-field');
        expect(body.data.components['attr-field']).toBeDefined();
      } else if (c.multi) {
        // 多源聚合页（如 S01 系统状态墙）：含多 metric-card（按 title 索引）+ table
        expect(body.html).toContain('pg-metric-card');
        const mc = body.data.components['metric-card'];
        expect(mc).toBeDefined();
        expect(mc['装配校验']).toBeDefined();
        expect(mc['看板任务']).toBeDefined();
        expect(mc['审批待处理']).toBeDefined();
        expect(Array.isArray(body.data.components.table.rows)).toBe(true);
      } else {
        // 空表降级：renderer 对零行 table 渲染 <div class="pg-state" data-state="empty">暂无数据</div>，
        // 不输出 pg-table —— 两种形态都是正确受控产物（business-tier/meta-attr 库内可能为空）
        const hasTable = body.html.includes('pg-table');
        const hasEmptyState = body.html.includes('pg-state');
        expect(hasTable || hasEmptyState).toBe(true);
        expect(Array.isArray(body.data.components.table.rows)).toBe(true);
      }
      if (c.probe) expect(body.html).toContain(c.probe); // 真实 DB 行注入（非出厂占位）
    });
  }

  it('端点健壮性：repeat 请求稳定 200（不因空行/并发崩页）', async () => {
    for (const c of CASES) {
      const a = await getJson(`/api/page/${c.id}`);
      const b = await getJson(`/api/page/${c.id}`);
      expect(a.status, `${c.id} 首次`).toBe(200);
      expect(b.status, `${c.id} 重复`).toBe(200);
      expect(a.body.html).toContain('pg-page');
    }
  });

  // T7（死信息活体化）：S30 决策市场 reasoning-trace 注入真状态（工厂可控决策页，data.components 含注入 steps）
  it('S30 decision-quality reasoning-trace 注入 steps（工厂注入，非 schema 写死回传）', async () => {
    const { status, body } = await getJson('/api/page/decision-quality');
    expect(status).toBe(200);
    // 工厂注入契约（controlledConfigPages.js:272）：data.components['reasoning-trace'].steps = buildReasoningSteps(S30 schema steps, traceFacts)
    const steps = body.data?.components?.['reasoning-trace']?.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s.label)).toEqual(['覆盖度加载', '先例匹配', '偏差分析']);
    // 注入态渲染（html 消费 steps — 非 schema 写死回传）
    expect(body.html).toContain('data-trace-step=');
  });
});
