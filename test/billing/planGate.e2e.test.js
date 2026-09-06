// test/billing/planGate.e2e.test.js — 套餐体系端到端闸门验证（2026-09-06 立）
// 目标：回答「平台套餐是否真的启用了」——不是测某个函数，而是从**配置 → 权益 → 闸门 → 计量 → 菜单 → 对外 API/页面**
//       全链路逐段取证：改一档配置，功能可达性、Token 封顶、计量归属、菜单可见项是否随之改变。
// 覆盖：
//   A. 权益解析分档差异（free/starter/pro/enterprise/local_flagship + system 豁免 + 单调递增）
//   B. Action 第 1.7 闸：低档拦截 / 高档放行 / 缺 tenantId fail-closed
//   C. Token 闸三模式：block 封顶、bill 至 hard_cap 封顶、-1 不限；system 豁免
//   D. 计量：落库 + onUsage 回传 + 租户隔离 + 缺租户记 system（方案 B，不阻断）
//   E. 菜单权益门禁（menuFor）
//   F. 对外 API：/api/billing/plans 下发 5 档 + entitlement_catalog（真实 express + 真实库，非 mock）
//   G. 页面零硬编码护栏：landing.html / billing.html 不得写死档位名与价格
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { query, queryWrite } from '../../src/db.js';
import { seedBillingPlans, FULL_PLANS } from '../helpers/seedBillingPlans.js';
import { resolveEntitlements } from '../../src/billing/entitlements.js';
import { enforceTokenQuota, TokenQuotaError } from '../../src/billing/quotaGate.js';
import { recordUsage, meteringTenantId, enforceQuotaFor } from '../../src/billing/metering.js';
import { checkSeatLimit } from '../../src/billing/seatPolicy.js';
import { menuFor } from '../../src/portal/layoutMenu.js';
import { createBillingRouter } from '../../src/http/billingRoutes.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { actionExecutor } from '../../src/action/executor.js';
import { listActions } from '../../src/action/registry.js';

const PERIOD = new Date().toISOString().slice(0, 7);
const NS = '__gate_t_' + process.pid + '_' + Date.now();
const T_FREE = NS + '_free';
const T_PRO = NS + '_pro';
// 需要 decision_autonomy 的只读 Action（read 类不依赖第 0 闸 decision_id，便于纯闸门对照）
const GUARDED_ACTION = 'crm-stage-progression-evaluate';

async function mkTenant(id, plan) {
  await queryWrite(
    `INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,$1,'active',$2)
     ON CONFLICT (tenant_id) DO UPDATE SET plan=EXCLUDED.plan`,
    [id, plan]
  );
}
async function mkUsage(tenantId, tin, tout, action = 'e2e') {
  await queryWrite(
    `INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, tenant_id, created_at)
     VALUES ('e2e','${action}',${Number(tin)},${Number(tout)},'llm',$1,now())`,
    [tenantId]
  );
}
const usedOf = async (tid) => (await query(
  `SELECT COALESCE(SUM(tokens_in)+SUM(tokens_out),0)::int AS n FROM crm.token_accounting
   WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2`, [tid, PERIOD])).rows[0].n;

let server = null;
let baseUrl = '';

beforeAll(async () => {
  await seedBillingPlans('planGate.e2e');
  await seedActions();
  await mkTenant(T_FREE, 'free');
  await mkTenant(T_PRO, 'pro');

  // 真实 HTTP 端点（公开只读档位接口），不 mock：验证线上前端拿到的数据形态
  const app = express();
  app.use(createBillingRouter());
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

describe('A. 权益解析：分档差异与豁免', () => {
  it('免费档不含高档权益；pro 含决策自治；enterprise 含行业配置与高级 RBAC', async () => {
    const free = await resolveEntitlements(T_FREE);
    const pro = await resolveEntitlements(T_PRO);
    expect(free.has('core_crm')).toBe(true);
    expect(free.has('decision_autonomy')).toBe(false);
    expect(free.has('industry_config')).toBe(false);
    expect(pro.has('decision_autonomy')).toBe(true);
    await mkTenant(T_PRO, 'enterprise');
    const ent = await resolveEntitlements(T_PRO);
    expect(ent.has('industry_config')).toBe(true);
    expect(ent.has('rbac_advanced')).toBe(true);
    await mkTenant(T_PRO, 'pro');
  });

  it('未配置 plan 的租户回落 default_plan（配置驱动，非崩溃）', async () => {
    const t = NS + '_null';
    await mkTenant(t, null);
    const e = await resolveEntitlements(t);
    const def = (await query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key='billing-settings'`)).rows[0]?.value?.default_plan;
    const expectSet = new Set(FULL_PLANS.find((p) => p.plan_id === def)?.entitlements || []);
    expect([...e].sort()).toEqual([...expectSet].sort());
  });

  it('system 租户恒全权益（内部 Agent 不被门禁阻断）', async () => {
    const e = await resolveEntitlements('system');
    for (const k of FULL_PLANS.flatMap((p) => p.entitlements || [])) expect(e.has(k)).toBe(true);
  });
});

describe('B. Action 第 1.7 闸：套餐功能门槛', () => {
  it('门禁覆盖面 ≥ 50 个 Action（改造前仅 14）', () => {
    const guarded = listActions().filter((a) => Array.isArray(a.requiresEntitlement) && a.requiresEntitlement.length);
    expect(guarded.length).toBeGreaterThanOrEqual(50);
  });

  it('低档租户被拦（free 缺 decision_autonomy），高档租户放行（pro）', async () => {
    const def = listActions().find((a) => a.name === GUARDED_ACTION);
    expect(def, `门禁 Action ${GUARDED_ACTION} 应已注册`).toBeTruthy();
    const blocked = await actionExecutor.dispatch(GUARDED_ACTION, {}, { tenantId: T_FREE, actor: 'e2e' });
    expect(blocked.gate).toBe('plan_entitlement');
    expect(blocked.error).toMatch(/升级套餐/);
    const allowed = await actionExecutor.dispatch(GUARDED_ACTION, {}, { tenantId: T_PRO, actor: 'e2e' });
    expect(allowed.gate).not.toBe('plan_entitlement');
  });

  it('缺 tenantId → fail-closed（不再静默获得全权益）', async () => {
    const r = await actionExecutor.dispatch(GUARDED_ACTION, {}, { actor: 'e2e' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('plan_entitlement_missing_tenant');
  });

  it('system 租户豁免权益闸', async () => {
    const r = await actionExecutor.dispatch(GUARDED_ACTION, {}, { tenantId: 'system', actor: 'e2e' });
    expect(r.gate).not.toBe('plan_entitlement');
  });
});

describe('C. Token 闸：block / bill / 不限三模式', () => {
  it('block 档（free）用量超包含量 → 抛 TokenQuotaError', async () => {
    await mkUsage(T_FREE, 30000, 30000); // 累计 60000 > 50000
    await expect(enforceTokenQuota(T_FREE, PERIOD)).rejects.toBeInstanceOf(TokenQuotaError);
  });

  it('bill 档（pro）未达 hard_cap → 放行；超 hard_cap → 拦截', async () => {
    await mkUsage(T_PRO, 1000, 1000);
    const ok = await enforceTokenQuota(T_PRO, PERIOD);
    expect(ok.ok).toBe(true);
    expect(ok.mode).toBe('bill');
    const cap = Number(FULL_PLANS.find((p) => p.plan_id === 'pro').token_hard_cap);
    await mkUsage(T_PRO, cap / 2, cap / 2);
    await expect(enforceTokenQuota(T_PRO, PERIOD)).rejects.toBeInstanceOf(TokenQuotaError);
  });

  it('不限档（included_tokens=-1）恒放行，system 恒豁免', async () => {
    const t = NS + '_unl';
    await mkTenant(t, 'local_flagship');
    const r = await enforceTokenQuota(t, PERIOD);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('unlimited');
    const s = await enforceTokenQuota('system', PERIOD);
    expect(s.exempt).toBe(true);
  });

  it('配额错误经 metering.enforceQuotaFor 向上传播（不静默吞掉）', async () => {
    await expect(enforceQuotaFor({ tenantId: T_FREE }, 'llm')).rejects.toMatchObject({ isQuota: true });
  });
});

describe('D. 计量：落库 / 回传 / 租户隔离', () => {
  it('带租户计量落库，且用量归属正确租户（不串到别家）', async () => {
    const t = NS + '_m1';
    await mkTenant(t, 'pro');
    const before = await usedOf(t);
    const beforeOther = await usedOf(T_PRO);
    await recordUsage({ metering: { tenantId: t, actor: 'e2e', action: 'e2e-meter' }, source: 'llm', usage: { prompt_tokens: 111, completion_tokens: 222 } });
    expect(await usedOf(t)).toBe(before + 333);
    expect(await usedOf(T_PRO)).toBe(beforeOther);
  });

  it('onUsage 回传真实用量（Action 层用量回填通道）', async () => {
    let back = null;
    await recordUsage({ metering: { tenantId: T_PRO, actor: 'e2e' }, source: 'llm', usage: { prompt_tokens: 40, completion_tokens: 60 }, onUsage: (u) => { back = u; } });
    expect(back).toMatchObject({ tokensIn: 40, tokensOut: 60 });
  });

  it('缺 tenantId → 记 system 且不阻断（方案 B）', async () => {
    const before = await usedOf('system');
    const r = await recordUsage({ metering: null, source: 'llm', action: 'e2e-no-tenant', usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(r.tenantId).toBe('system');
    expect(await usedOf('system')).toBe(before + 10);
    expect(meteringTenantId(undefined, 'llm')).toBe('system');
  });
});

describe('E. 席位闸与菜单门禁', () => {
  it('席位按租户隔离：新租户 0 用户不受他租户用量影响', async () => {
    const t = NS + '_seat';
    await mkTenant(t, 'pro');
    const r = await checkSeatLimit(t);
    expect(r.used).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('菜单按权益过滤：免费档看不到「报告」，pro 档可见；未传权益集则不过滤', async () => {
    const freeEnts = await resolveEntitlements(T_FREE);
    const proEnts = await resolveEntitlements(T_PRO);
    const asFree = menuFor('admin', freeEnts).map((m) => m.label);
    const asPro = menuFor('admin', proEnts).map((m) => m.label);
    expect(asFree).not.toContain('报告');           // 需 decision_autonomy
    expect(asPro).toContain('报告');
    expect(menuFor('admin', null).length).toBeGreaterThanOrEqual(asPro.length);
  });
});

describe('F. 对外 API 与页面动态化', () => {
  it('GET /api/billing/plans 下发 5 档 + 权益目录（前端零硬编码的基础）', async () => {
    const res = await fetch(`${baseUrl}/api/billing/plans`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(Array.isArray(j.plans)).toBe(true);
    expect(j.plans.length).toBe(5);
    expect(j.settings.default_plan).toBeTruthy();
    expect(Array.isArray(j.entitlement_catalog)).toBe(true);
    expect(j.entitlement_catalog.length).toBeGreaterThanOrEqual(13);
    for (const c of j.entitlement_catalog) expect(typeof c.label).toBe('string');
    // 停用档（enabled=false）不应对外下发/展示——由前端过滤，此处仅保证标记可达
    for (const p of j.plans) expect(p.plan_id).toBeTruthy();
  });

  it('landing.html / billing.html 不硬编码档位名与价格（配置驱动护栏）', () => {
    const web = path.resolve(process.cwd(), 'src/web');
    for (const f of ['landing.html', 'billing.html']) {
      const html = fs.readFileSync(path.join(web, f), 'utf8');
      for (const p of FULL_PLANS) {
        expect(html.includes(p.quote), `${f} 写死了报价 ${p.quote}`).toBe(false);
        expect(html.includes(p.name), `${f} 写死了档位名 ${p.name}`).toBe(false);
      }
      expect(html.includes('¥2980'), `${f} 写死了价格 ¥2980`).toBe(false);
    }
  });

  // 卡片分层渲染护栏：主价（seat_unit_price）+ 副标题/划线价/角标（quote|original_price|tag_text）。
  // 解决「改了不生效」现象：UI 后端各字段语义清晰、单字段变化即可见。
  it('landing.html 卡片分层渲染：主价=seat_unit_price，副标题=quote，角标=tag_text，划线=original_price', () => {
    const fs2 = require('node:fs');
    const web = path.resolve(process.cwd(), 'src/web');
    const html = fs2.readFileSync(path.join(web, 'landing.html'), 'utf8');
    // ①主价渲染走 seat_unit_price（避免硬编码 quote）
    expect(html).toMatch(/seatPriceText|seat_unit_price/);
    // ②有 original_price 划线渲染分支
    expect(html).toMatch(/class="was"/);
    // ③有 tag_text 角标渲染分支
    expect(html).toMatch(/class="badge"/);
    // ④quote 字段渲染为副标题 .sub 区块（不与主价混排）
    expect(html).toMatch(/class="sub"/);
    // ⑤主价脚手架「售前联系」兜底不在 FULL_PLANS quote 字段值中（避免护栏误报）
    expect(html).toMatch(/售前联系/);
  });

  // billing_intro 配置驱动：landing 标题/段落/定价说明全部接 settings.billing_intro
  it('GET /api/billing/plans 自动补 settings.billing_intro（landing 标题/段落全配置驱动）', async () => {
    const res = await fetch(`${baseUrl}/api/billing/plans`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.settings.billing_intro, 'settings.billing_intro 必须下发').toBeTruthy();
    expect(typeof j.settings.billing_intro.headline).toBe('string');
    expect(typeof j.settings.billing_intro.subtitle).toBe('string');
    expect(Array.isArray(j.settings.billing_intro.legend)).toBe(true);
    expect(j.settings.billing_intro.legend.length).toBeGreaterThanOrEqual(3);
  });

  it('landing.html 不硬编码"SaaS 档位制 / 本地旗舰 / 按账号(席位) / 私有化部署档位 / AI 加价税"等业务断言字', () => {
    const fs2 = require('node:fs');
    const html = fs2.readFileSync(path.resolve(process.cwd(), 'src/web/landing.html'), 'utf8');
    // 配置驱动护栏：landing 标题、段落、定价说明属业务断言，必须消除业务断言字面
    expect(html).not.toMatch(/SaaS\s*档位制/);    // 业务断言：套餐名应跟随配置
    expect(html).not.toMatch(/按账号.{0,8}席位.{0,8}计费/); // 业务断言：副标题应可后台编辑
    expect(html).not.toMatch(/价格随账号规模/);    // 业务断言：产品叙事文案
    expect(html).not.toMatch(/私有化部署档位/);    // 业务断言：legend 行从 settings 渲染
    expect(html).not.toMatch(/AI\s*加价税/);       // 业务断言：产品立场
  });

  it('admin-billing-console.html 编辑套餐表单含 plan 结构化字段：original_price / tag_text + 实时预览', () => {
    const fs2 = require('node:fs');
    const html = fs2.readFileSync(path.resolve(process.cwd(), 'src/web/admin-billing-console.html'), 'utf8');
    expect(html).toMatch(/id="pf-orig-price"/);
    expect(html).toMatch(/id="pf-tag-text"/);
    expect(html).toMatch(/id="pf-preview"/);
    expect(html).toMatch(/updatePlanPreview/);
  });
});
