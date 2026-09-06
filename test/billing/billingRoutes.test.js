// test/billing/billingRoutes.test.js — 档位配置播种校验（T2）+ 套餐/设置 维护 CRUD（T4）
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readConfig } from '../../src/config/configStore.js';
import { queryWrite } from '../../src/db.js';
import { seedBillingPlans } from '../helpers/seedBillingPlans.js';
import { updateBillingPlans, updateBillingSettings } from '../../src/billing/billingService.js';

// 2026-09-06（污染根治）：
//   原实现在形态不符时直接重播 db/seed-billing-config.sql，而旧 seed 与现网口径漂移
//   （included_tokens=-1 / token_overage_mode='none' = 关闸），重播后 T4 的 afterAll 又把
//   「重播值」当作 original 恢复 → 全局配置被永久改成关闸版本 → 后跑的测试（tokenUsage 等）全红。
//   现改为：① 播种统一走 test/helpers/seedBillingPlans.js（与 db/seed 同源，由一致性测试常驻校验）；
//   ② 文件级「快照—恢复」：跑前记录、跑后还原，对全局配置净效果为 0（禁 DELETE 铁律下用 ON CONFLICT 覆盖）。
let originalPlans = [];
let originalSettings = {};

beforeAll(async () => {
  originalPlans = JSON.parse(JSON.stringify((await readConfig('billing-plans', { tenantId: 'system' }))?.value || []));
  originalSettings = JSON.parse(JSON.stringify((await readConfig('billing-settings', { tenantId: 'system' }))?.value || {}));
});

afterAll(async () => {
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value,updated_by)
    VALUES ('system','billing-plans',$1::jsonb,'restore') ON CONFLICT (tenant_id,key)
    DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(originalPlans)]);
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value,updated_by)
    VALUES ('system','billing-settings',$1::jsonb,'restore') ON CONFLICT (tenant_id,key)
    DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(originalSettings)]);
});

describe('billing config_store', () => {
  // 条件自愈：仅当缺失/档位不足/无报价时才播种（正常由 pretest 的 seed-test-config 保证基线）
  beforeAll(async () => {
    const cur = (await readConfig('billing-plans', { tenantId: 'system' }))?.value;
    const need = !Array.isArray(cur) || cur.length !== 5 || cur.some((p) => !p.quote);
    if (need) await seedBillingPlans('billingRoutes.selfHeal');
  });

  test('billing-plans 含 5 档且与 landing 报价口径对齐', async () => {
    const plans = (await readConfig('billing-plans', { tenantId: 'system' }))?.value;
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBe(5);
    const ids = plans.map((p) => p.plan_id);
    expect(ids).toEqual(['free', 'starter', 'pro', 'enterprise', 'local_flagship']);
    expect(plans.find((p) => p.plan_id === 'pro').entitlements).toContain('decision_autonomy');
    // 对外报价口径（2026-09-06 修正）：quote 是配置中心的运营数据，会随改价变化。
    //   测试锁死具体金额会与「配置驱动」铁律冲突（每次改价都要改测试）→ 只断言形态：
    //   付费档 quote 必须非空且含币种 ¥；旗舰版为面议（不标价）。
    const paid = ['starter', 'pro', 'enterprise'];
    for (const id of paid) {
      const quote = plans.find((p) => p.plan_id === id).quote;
      expect(quote, `${id}.quote 应配置对外报价`).toBeTruthy();
      expect(quote, `${id}.quote 应含币种 ¥（实际：${quote}）`).toContain('¥');
    }
    expect(plans.find((p) => p.plan_id === 'local_flagship').quote).toBeTruthy();
    // 权益键必须对应本平台真实能力（无 attio/Lightfield 外部功能名）
    const all = plans.flatMap((p) => p.entitlements || []);
    expect(all).not.toContain('data_export');
    expect(all).not.toContain('sso_rbac');
  });

  // 闸门语义护栏：档位不得使用 token_overage_mode='none'（quotaGate 对 none 不拦截 = 关闸）
  test('档位 Token 闸门均处于生效态（mode ∈ block|bill）', async () => {
    const plans = (await readConfig('billing-plans', { tenantId: 'system' }))?.value || [];
    for (const p of plans) {
      expect(['block', 'bill']).toContain(p.token_overage_mode || 'bill');
    }
  });

  test('billing-settings 含 default_plan', async () => {
    const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value;
    expect(s.default_plan).toBeTruthy();
  });
});

// —— T4：套餐档位 / 计费设置 维护（admin CRUD，禁 DELETE，ON CONFLICT 幂等重播，写走 queryWrite）——
// 铁律：测试对全局写入净效果为 0 —— 跑前快照 original，跑后由文件级 afterAll 恢复，不依赖 delete。
describe('billing admin CRUD (T4)', () => {
  test('updateBillingPlans 写入后 readConfig 读回新档位（含新增档位的 enabled 软停用语义）', async () => {
    const target = [
      ...JSON.parse(JSON.stringify((await readConfig('billing-plans', { tenantId: 'system' }))?.value || [])),
      { plan_id: 'pilot_probe', name: '试点档 · Pilot Probe', base_fee: 0, included_seats: 5, seat_unit_price: 99,
        included_tokens: 100000, token_overage_unit_price: 0.02, token_overage_mode: 'bill', token_hard_cap: 300000,
        currency: 'CNY', quote: '¥99 / 账号·月',
        features: ['测试试点（T4）'], entitlements: ['core_crm', 'ai_agents'], enabled: true },
    ];
    // 软停用语义：新档位即便 enabled=false 也应整体写库并读回（禁物理删——此处验证 enabled 标记随档位持久化）
    target[0].enabled = false;
    const r = await updateBillingPlans(target, 'svc_test');
    expect(r.ok).toBe(true);
    const planIds = target.map((p) => p.plan_id);
    expect(r.plans.map((p) => p.plan_id)).toEqual(planIds);
    const readback = (await readConfig('billing-plans', { tenantId: 'system' }))?.value;
    expect(Array.isArray(readback)).toBe(true);
    expect(readback.map((p) => p.plan_id)).toEqual(planIds);
    expect(readback.find((p) => p.plan_id === 'pilot_probe').quote).toBe('¥99 / 账号·月');
    expect(readback.find((p) => p.plan_id === 'free').enabled).toBe(false); // 软停用持久化
  });

  test('updateBillingSettings 写入后读回含 stripe 子对象（凭据持久化）', async () => {
    const next = {
      ...JSON.parse(JSON.stringify((await readConfig('billing-settings', { tenantId: 'system' }))?.value || {})),
      default_plan: 'pro', currency: 'CNY', cycle: 'monthly',
      stripe: { enabled: true, publishable_key: 'pk_test_xxx', secret_key: 'sk_test_xxx', webhook_secret: 'whsec_xxx' },
    };
    const r = await updateBillingSettings(next, 'svc_test');
    expect(r.ok).toBe(true);
    const readback = (await readConfig('billing-settings', { tenantId: 'system' }))?.value;
    expect(readback.default_plan).toBe('pro');
    expect(readback.stripe).toBeTruthy();
    expect(readback.stripe.enabled).toBe(true);
    expect(readback.stripe.publishable_key).toBe('pk_test_xxx');
    expect(readback.stripe.webhook_secret).toBe('whsec_xxx');
  });
});
