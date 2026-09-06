// test/billing/seatPolicy.test.js
import { expect, test, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { seedBillingPlans, FULL_PLANS } from '../helpers/seedBillingPlans.js';
import { readConfig } from '../../src/config/configStore.js';
import { checkSeatLimit } from '../../src/billing/seatPolicy.js';

// 每轮运行用唯一租户，避免 DELETE 清理（项目铁律：绝对禁止 DELETE）；残留测试租户以 __seat_t_ 命名空间隔离
const T = '__seat_t_' + process.pid + '_' + Date.now();
let snapshot = null;

beforeAll(async () => {
  await seedBillingPlans(); // 幂等播种完整 5 档，保证套餐档位存在
  snapshot = JSON.parse(JSON.stringify((await readConfig('billing-plans', { tenantId: 'system' }))?.value || []));
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'seat','active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  for (let i = 0; i < 3; i++) await queryWrite(`INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id, enabled) VALUES ($1,'x','sales',$1,$2,true)`, [`__su${T}_${i}`, T]);
});

afterAll(async () => {
  if (!snapshot) return;
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value,updated_by)
    VALUES ('system','billing-plans',$1::jsonb,'restore') ON CONFLICT (tenant_id,key)
    DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(snapshot)]);
});

// 2026-09-06（现网口径修正）：此前断言「免费档第 4 用户被拒」依赖旧 fixture（free.seat_unit_price=0）。
//   现网 free 档 seat_unit_price=¥99（quote「原价 ¥99/账号，前三月免费」）→ 按席位**计费**、不封顶，
//   即 seatPolicy 的 block 分支在现网 5 档下不可达（included_seats 只表示「含 N 席」，超出按单价计费）。
//   这是运营策略而非缺陷，故本用例改为守住现网语义，另用临时探测档位守住 block 分支不回归。
test('免费档按席位计费不封顶（现网口径 seat_unit_price>0 → bill）', async () => {
  const r = await checkSeatLimit(T);
  expect(r.ok).toBe(true);
  expect(r.mode).toBe('bill');
  const plan = (await readConfig('billing-plans', { tenantId: 'system' }))?.value?.find((p) => p.plan_id === 'free');
  expect(Number(plan.seat_unit_price)).toBeGreaterThan(0);
});

test('block 分支仍可用：席位满且单价为 0 → 拒（临时探测档位，跑后恢复）', async () => {
  const probe = { ...FULL_PLANS.find((p) => p.plan_id === 'free'), plan_id: '__seat_block_probe', included_seats: 3, seat_unit_price: 0 };
  const plans = JSON.parse(JSON.stringify(FULL_PLANS));
  plans.push(probe);
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value,updated_by)
    VALUES ('system','billing-plans',$1::jsonb,'seatPolicy.probe') ON CONFLICT (tenant_id,key)
    DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(plans)]);
  await queryWrite(`UPDATE crm.tenants SET plan='__seat_block_probe' WHERE tenant_id=$1`, [T]);
  const r = await checkSeatLimit(T);
  expect(r.ok).toBe(false);
  expect(r.mode).toBe('block');
  expect(r.used).toBeGreaterThanOrEqual(r.included);
  await queryWrite(`UPDATE crm.tenants SET plan='free' WHERE tenant_id=$1`, [T]);
});

test('付费档（seat_unit_price>0）不封顶', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='pro' WHERE tenant_id=$1`, [T]);
  const r = await checkSeatLimit(T);
  expect(r.ok).toBe(true);
  expect(r.mode).toBe('bill');
});

test('unlimited（-1）不限制', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='local_flagship' WHERE tenant_id=$1`, [T]);
  const r = await checkSeatLimit(T);
  expect(r.mode).toBe('unlimited');
  expect(r.ok).toBe(true);
});

test('system 平台租户恒豁免席位封顶', async () => {
  const r = await checkSeatLimit('system');
  expect(r.ok).toBe(true);
  expect(r.mode).toBe('unlimited');
  expect(r.exempt).toBe(true);
  // 即便 system 实际用户已超免费 3 席（如生产 4/3），也不应被 block
  expect(r.mode).not.toBe('block');
});

test('席位按租户隔离：A 租户用户数不计入 B 租户', async () => {
  const other = T + '_b';
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'seat-b','active','__seat_block_probe') ON CONFLICT (tenant_id) DO UPDATE SET plan='__seat_block_probe'`, [other]);
  const r = await checkSeatLimit(other);
  expect(r.used).toBe(0);          // B 租户无用户，不应被 A 的 3 席拖累
  expect(r.ok).toBe(true);
  void query;
});
