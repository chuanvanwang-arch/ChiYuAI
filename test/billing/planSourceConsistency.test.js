// test/billing/planSourceConsistency.test.js — 套餐配置「三源一致性」常驻校验（2026-09-06 止血）
// 背景：db/seed-billing-config.sql（included_tokens 全 -1 / mode 全 none）与配置中心现网口径
//       （50000/block、200000/bill…）和测试 fixture（test/helpers/seedBillingPlans.js）三者漂移，
//       一次 `npm run seed` 重播即可把 Token 闸门整体关掉；测试间也因此互相踩踏。
// 本测试把「漂移」变成红灯：
//   1) seed SQL 与 test fixture 的关键字段必须逐档一致
//   2) 两者都必须通过 planSchema.validatePlans
//   3) 闸门语义护栏：不得出现 token_overage_mode='none'（= 关闸）；付费档必须有 hard_cap 或 -1 哨兵
//   4) 权益键必须全部登记在 planSchema 目录内（防止拼错/引入外部能力名）
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FULL_PLANS } from '../helpers/seedBillingPlans.js';
import { validatePlans, KNOWN_ENTITLEMENTS, ENTITLEMENT_LABELS, entitlementCatalog } from '../../src/billing/planSchema.js';

const SEED_SQL = path.resolve(process.cwd(), 'db/seed-billing-config.sql');

/** 从 seed SQL 中抽出 billing-plans 的 JSON 数组（第二个 INSERT 的 jsonb 字面量）。 */
function plansFromSeedSql() {
  const sql = fs.readFileSync(SEED_SQL, 'utf8');
  const m = sql.match(/'(\[[\s\S]*?\])'::jsonb/);
  if (!m) throw new Error('db/seed-billing-config.sql 中未找到 billing-plans 的 jsonb 字面量');
  return JSON.parse(m[1]);
}

// 参与一致性比对的字段（运营数值口径；quote/features 属展示口径，一并纳入防漂移）
const COMPARE_FIELDS = [
  'plan_id', 'name', 'quote', 'enabled', 'highlight',
  'included_seats', 'seat_unit_price', 'included_tokens',
  'token_overage_unit_price', 'token_overage_mode', 'token_hard_cap',
  'entitlements', 'features',
  // 卡片结构化展示字段（向后兼容：双方均允许 null/缺省）
  'original_price', 'tag_text',
];

// billing_intro 默认配置是 settings 兜底，需与前端 / 后端 BILLING_INTRO_DEFAULTS 同源
const BILLING_INTRO_EXPECTED_KEYS = ['headline', 'subtitle', 'legend'];

describe('套餐配置三源一致性', () => {
  const seedPlans = plansFromSeedSql();

  it('seed SQL 与 test fixture 档位集合一致（顺序 + plan_id）', () => {
    expect(seedPlans.map((p) => p.plan_id)).toEqual(FULL_PLANS.map((p) => p.plan_id));
  });

  it('seed SQL 与 test fixture 逐档关键字段一致', () => {
    for (const plan of FULL_PLANS) {
      const other = seedPlans.find((p) => p.plan_id === plan.plan_id);
      expect(other, `seed SQL 缺少档位 ${plan.plan_id}`).toBeTruthy();
      for (const f of COMPARE_FIELDS) {
        expect(JSON.stringify(other[f] ?? null), `${plan.plan_id}.${f} 与 seed 不一致`).toBe(JSON.stringify(plan[f] ?? null));
      }
    }
  });

  it('两份真相源都通过 planSchema 校验', () => {
    expect(validatePlans(seedPlans).errors).toEqual([]);
    expect(validatePlans(FULL_PLANS).errors).toEqual([]);
  });

  // 闸门语义护栏：'none' 在 quotaGate 中既不 block 也不 bill → 等同关闸，档位不得使用
  it('无任何档位使用 token_overage_mode=none（防「重播即关闸」回归）', () => {
    for (const p of FULL_PLANS) {
      expect(p.token_overage_mode, `${p.plan_id} 未配置超量模式`).toBeTruthy();
      expect(['block', 'bill']).toContain(p.token_overage_mode);
    }
  });

  it('block 档必须有正包含量；bill 档必须有 hard_cap 或 -1 哨兵', () => {
    for (const p of FULL_PLANS) {
      if (p.token_overage_mode === 'block') {
        expect(Number(p.included_tokens), `${p.plan_id} block 档需正包含量`).toBeGreaterThan(0);
      } else {
        const cap = p.token_hard_cap;
        const unlimited = Number(p.included_tokens) === -1;
        expect(unlimited || Number(cap) > 0, `${p.plan_id} bill 档需 hard_cap 或不限制`).toBe(true);
      }
    }
  });

  it('权益键全部已登记，且每个键都有中文标签', () => {
    const keys = new Set(FULL_PLANS.flatMap((p) => p.entitlements || []));
    for (const k of keys) {
      expect(KNOWN_ENTITLEMENTS, `权益键 ${k} 未登记`).toContain(k);
      expect(ENTITLEMENT_LABELS[k], `权益键 ${k} 缺中文标签`).toBeTruthy();
    }
    const missingLabel = entitlementCatalog().filter((c) => !c.label || c.label === c.key);
    expect(missingLabel.map((c) => c.key)).toEqual([]);
  });

  it('高档位权益必须包含低档位权益（免费→旗舰单调递增）', () => {
    const order = ['free', 'starter', 'pro', 'enterprise', 'local_flagship'];
    let prev = new Set();
    for (const id of order) {
      const cur = new Set(FULL_PLANS.find((p) => p.plan_id === id).entitlements || []);
      for (const k of prev) expect(cur.has(k), `${id} 应继承前一档权益 ${k}`).toBe(true);
      prev = cur;
    }
  });
});
