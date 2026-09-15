// test/sales/poolTypes.test.js — 三类池（new/nurture/lost）解析 + 租户隔离
// 设计：docs/2026-09-11-lead-public-pool-tenant-design.md §3
// 分层：① 纯函数（零 DB，恒跑）② config_store per-tenant（需 DB，不可达时显式 skip 而非假绿）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { query } from '../../src/db.js';
import {
  DEFAULT_POOL_TEMPLATE, POOL_CONFIG_KEY, normalizePoolConfig, resolvePoolId,
  poolOf, legacyToPools, readPoolConfig, writePoolConfig, readLegacyPoolConfig,
} from '../../src/sales/pool.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('① 三类池解析（纯函数，零 DB）', () => {
  it('默认模板含 new/nurture/lost 三池且有序', () => {
    const t = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(t.pools.map((p) => p.type)).toEqual(['new', 'nurture', 'lost']);
  });

  it('resolvePoolId：显式 pool_id 优先，其次 pool_type，最后 default_pool', () => {
    const cfg = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(resolvePoolId(cfg, { pool_id: 'pool-lost' })).toBe('pool-lost');
    expect(resolvePoolId(cfg, { pool_type: 'nurture' })).toBe('pool-nurture');
    expect(resolvePoolId(cfg, {})).toBe('pool-new');
  });

  it('resolvePoolId 拒绝 org-hq 硬编码回潮（未知 id 回落默认池）', () => {
    const cfg = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(resolvePoolId(cfg, { pool_id: 'org-hq' })).toBe('pool-new');
  });

  it('poolOf 返回池对象；未知 id 回落首池（不返回 undefined 造成后续 crash）', () => {
    const cfg = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(poolOf(cfg, 'pool-nurture').pick_rule.daily_limit).toBe(5);
    expect(poolOf(cfg, 'nope').id).toBe('pool-new');
  });

  it('normalizePoolConfig 补齐缺键（手改配置只写了一个键时其他键仍有值）', () => {
    const t = normalizePoolConfig({ pools: [{ id: 'pool-new', type: 'new', pick_rule: { daily_limit: 3 } }] });
    expect(t.pools[0].pick_rule.daily_limit).toBe(3);
    expect(t.pools[0].pick_rule.pick_interval_hours).toBe(24); // 来自模板补默认
    expect(t.pools[0].recycle_rule.recycle_days).toBe(30);
  });

  it('旧组织粒子配置兼容读为单池 pool-new，且保留原阈值', () => {
    const p = legacyToPools({ pick_rule: { daily_limit: 3 }, recycle_rule: { recycle_days: 7 } });
    expect(p.pools).toHaveLength(1);
    expect(p.pools[0].type).toBe('new');
    expect(p.pools[0].pick_rule.daily_limit).toBe(3);
    expect(p.pools[0].recycle_rule.recycle_days).toBe(7);
  });

  it('POOL_CONFIG_KEY 固定为 lead-pool-config（配置中心/迁移脚本同键）', () => {
    expect(POOL_CONFIG_KEY).toBe('lead-pool-config');
  });
});

describe('② config_store per-tenant 隔离（需 DB）', () => {
  it('租户写不污染 system 与另一租户；缺键 autoSeed 打 _seeded', async (ctx) => {
    let dbOk = true;
    try {
      await query('SELECT 1');
    } catch {
      dbOk = false;
    }
    if (!dbOk) return ctx.skip('PostgreSQL 未启动（localhost:5433 ECONNREFUSED）——本用例需真库，跳过而非降绿');

    const a = await readPoolConfig({ tenantId: 'e2e-pool-t-a' });
    expect(a.pools.map((p) => p.type)).toEqual(['new', 'nurture', 'lost']);
    // D2（派发前复查）：标题声称「autoSeed 打 _seeded」，原稿零断言 → 假绿。
    //   该断言同时是 D1（播种渠道脱钩）的唯一鉴别器：system 模板行缺失时 readConfig 返回 null，
    //   autoSeed 空转 → 无 _seeded 标记 → 用例必须红。
    expect(a._seeded).toBe('system-template');

    const patched = a.pools.map((p) => (p.id === 'pool-new'
      ? { ...p, pick_rule: { ...p.pick_rule, daily_limit: 99 } }
      : p));
    const wrote = await writePoolConfig({ tenantId: 'e2e-pool-t-a', patch: { pools: patched }, updatedBy: 'e2e' });
    expect(poolOf(wrote, 'pool-new').pick_rule.daily_limit).toBe(99);

    const sys = await readPoolConfig({ tenantId: 'system' });
    expect(poolOf(sys, 'pool-new').pick_rule.daily_limit).not.toBe(99);

    const b = await readPoolConfig({ tenantId: 'e2e-pool-t-b' });
    expect(poolOf(b, 'pool-new').pick_rule.daily_limit).not.toBe(99);
  });
});

// ③④ 为零 DB 常跑守卫：不依赖 PostgreSQL，避免「DB 不可用 → 整组 skip → 缺陷静默通过」。
describe('③ 播种渠道守卫（零 DB；防「建了 SQL 却无执行者」）', () => {
  it('db/migrate.js 在启动链路播种 lead-pool-config（且晚于 migrateTenant，复合 PK 已就绪）', () => {
    const src = readFileSync(join(ROOT, 'db', 'migrate.js'), 'utf8');
    expect(src).toContain("key='lead-pool-config'");
    expect(src).toContain("'./migration-lead-pool-config.sql'");
    expect(src.indexOf('migrateTenant()')).toBeLessThan(src.indexOf('migration-lead-pool-config.sql'));
  });

  it('pretest 前置脚本接入 lead-pool-config（测试库可验证 autoSeed/_seeded）', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'seed-test-config.mjs'), 'utf8');
    expect(src).toContain('ensureLeadPoolConfig');
    expect(src).toContain("['线索池三池模板（lead-pool-config）', ensureLeadPoolConfig]");
  });

  it('迁移 SQL 与代码 DEFAULT_POOL_TEMPLATE 结构性一致（单一 JSON 事实源，防双源漂移）', () => {
    const sql = readFileSync(join(ROOT, 'db', 'migration-lead-pool-config.sql'), 'utf8');
    const m = sql.match(/'(\{[\s\S]*\})'::jsonb/);
    expect(m, '迁移 SQL 应内联 JSON 模板').toBeTruthy();
    const parsed = JSON.parse(m[1]);
    const tpl = DEFAULT_POOL_TEMPLATE;
    expect(parsed.default_pool).toBe(tpl.default_pool);
    expect(parsed.pools.map((p) => p.type)).toEqual(tpl.pools.map((p) => p.type));
    expect(parsed.pools.map((p) => p.label)).toEqual(tpl.pools.map((p) => p.label));
    expect(parsed.pools.map((p) => p.pick_rule.daily_limit)).toEqual(tpl.pools.map((p) => p.pick_rule.daily_limit));
  });
});

describe('④ 旧组织粒子配置精确探测（零 DB；注入 stub query）', () => {
  it('查无组织粒子 → null（不回落默认值，否则三池模板成死代码）', async () => {
    const stub = async () => ({ rows: [] });
    expect(await readLegacyPoolConfig('org-hq', { query: stub, tenantId: 't' })).toBe(null);
  });

  it('组织粒子存在但无 pool_config → null', async () => {
    const stub = async () => ({ rows: [{ payload: {} }] });
    expect(await readLegacyPoolConfig('org-hq', { query: stub, tenantId: 't' })).toBe(null);
  });

  it('组织粒子带 pool_config → 返回旧配置（存量兼容读不丢失）', async () => {
    const stub = async () => ({ rows: [{ payload: { pool_config: { pick_rule: { daily_limit: 3 } } } }] });
    const r = await readLegacyPoolConfig('org-hq', { query: stub, tenantId: 't' });
    expect(r.pick_rule.daily_limit).toBe(3);
  });
});

// ⑤ readPoolConfig 优先级接线（零 DB，注入 stub；T3 变异 M6 曾因该组缺失而漏网）
describe('⑤ readPoolConfig 三级优先级接线（零 DB；注入 stub readConfig/query）', () => {
  it('config_store 无行 + 无旧粒子 → 三池模板（D4：不退化单池）', async () => {
    const cfg = await readPoolConfig({
      tenantId: 't-nodb', readConfig: async () => null, query: async () => ({ rows: [] }),
    });
    expect(cfg.pools.map((p) => p.type)).toEqual(['new', 'nurture', 'lost']);
  });

  it('config_store 无行 + 旧粒子有配置 → 单池兼容读（保留旧阈值）', async () => {
    const cfg = await readPoolConfig({
      tenantId: 't-nodb', readConfig: async () => null,
      query: async () => ({ rows: [{ payload: { pool_config: { pick_rule: { daily_limit: 3 } } } }] }),
    });
    expect(cfg.pools).toHaveLength(1);
    expect(poolOf(cfg, 'pool-new').pick_rule.daily_limit).toBe(3);
  });

  it('config_store 有行 → 最高优先（不探测旧粒子）', async () => {
    const cfg = await readPoolConfig({
      tenantId: 't-nodb',
      readConfig: async () => ({ value: { pools: [{ id: 'pool-x', type: 'new', label: 'X' }], default_pool: 'pool-x' } }),
      query: async () => { throw new Error('不应探测旧粒子（config_store 已命中）'); },
    });
    expect(cfg.pools[0].id).toBe('pool-x');
  });
});
