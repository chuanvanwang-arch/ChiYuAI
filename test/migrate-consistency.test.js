// 2026-09-03 schema drift 治理回归锁：
// 断言 db/migrate.js 的 INCREMENTAL_SQL 清单包含 decision.display_name 迁移，
// 且清单引用的 .sql 文件均存在且幂等（防「仅跑 migrate.js 的环境缺列」的环境一致性缺陷）。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INCREMENTAL_SQL } from '../db/migrate.js';

const dbDir = fileURLToPath(new URL('../db/', import.meta.url));

describe('migrate.js INCREMENTAL_SQL 环境一致性', () => {
  it('包含 decision.display_name 迁移（防仅跑 migrate 的环境缺列）', () => {
    expect(INCREMENTAL_SQL).toContain('migration-decision-display-name.sql');
  });

  it('清单引用的 .sql 迁移文件均存在且可读（防重命名/缺失导致 migrate 跑崩）', () => {
    // 注：幂等性由 migrate.js 主循环 catch 容忍重复执行（42P01/42703）保障，
    // 不在此强制 IF NOT EXISTS；本锁的核心是「清单完整 + 文件可达」，防环境 drift。
    for (const f of INCREMENTAL_SQL) {
      if (!f.endsWith('.sql')) continue; // .js 迁移（migrate-tenant.js）单独处理
      const p = dbDir + f;
      expect(existsSync(p), `${f} 应存在于 db/`).toBe(true);
      expect(() => readFileSync(p, 'utf8'), `${f} 应可读`).not.toThrow();
    }
  });

  // ── 2026-09-16 新增：crm.signal 血缘三列的「两路径一致性 + 顺序性」锁 ──────────────
  // 背景（本缺陷的根因）：crm.signal 有两条建库路径——
  //   ① db/schema.sql 尾部（新库直建，已含血缘三列）
  //   ② db/migration-signal-tables.sql（旧库幂等叠加，建表时**不含**三列）
  // 二者差异恰好是 decision_id / action_ref / closed_reason，靠
  // db/migration-signal-adoption-trail.sql 幂等 ADD COLUMN 兜底。
  // ⇒ 若「补列迁移」被排到「建表迁移」之前，补列时表尚不存在 → migrate.js 主循环
  //    catch(42P01) **静默容忍** → 表永久缺三列 → 采纳血缘丢失且无任何报错。
  //    这正是本项目反复出现的「假绿」形态（静默容忍把顺序缺陷转为无声数据缺陷）。
  const signalCols = (src) => {
    const m = src.match(/CREATE TABLE IF NOT EXISTS crm\.signal \(([\s\S]*?)\n\);/);
    if (!m) return null;
    return new Set(
      m[1].split('\n')
        .map((l) => (l.match(/^\s{2}([a-z_]+)\s+/) || [])[1])
        .filter(Boolean),
    );
  };

  it('血缘补列迁移必须排在 signal 建表迁移之后（顺序颠倒 → 42P01 被静默容忍 → 表永久缺列）', () => {
    const iBuild = INCREMENTAL_SQL.indexOf('migration-signal-tables.sql');
    const iTrail = INCREMENTAL_SQL.indexOf('migration-signal-adoption-trail.sql');
    expect(iBuild, 'signal 建表迁移应在清单内').toBeGreaterThanOrEqual(0);
    expect(iTrail, 'signal 血缘补列迁移应在清单内').toBeGreaterThanOrEqual(0);
    expect(iTrail, '补列迁移必须晚于建表迁移').toBeGreaterThan(iBuild);
  });

  it('两条建库路径的 crm.signal 列集合差异恰好 = 血缘三列（差异变化即提醒三处同步）', () => {
    const incr = signalCols(readFileSync(dbDir + 'migration-signal-tables.sql', 'utf8'));
    const schema = signalCols(readFileSync(dbDir + 'schema.sql', 'utf8'));
    expect(incr, 'migration-signal-tables.sql 应有 crm.signal 建表块').toBeTruthy();
    expect(schema, 'schema.sql 应有 crm.signal 建表块').toBeTruthy();

    // 正向：schema.sql 比增量迁移多的列 —— 应恰好是血缘三列
    expect([...schema].filter((c) => !incr.has(c)).sort())
      .toEqual(['action_ref', 'closed_reason', 'decision_id']);
    // 反向：增量迁移不得含 schema.sql 未声明的列（防影子 DDL 单侧加列）
    expect([...incr].filter((c) => !schema.has(c))).toEqual([]);
  });

  it('血缘补列迁移确实是 ADD COLUMN IF NOT EXISTS 三列（幂等，可重复执行）', () => {
    const sql = readFileSync(dbDir + 'migration-signal-adoption-trail.sql', 'utf8');
    for (const c of ['decision_id', 'action_ref', 'closed_reason']) {
      expect(sql, `应含 ${c} 的幂等加列`).toMatch(
        new RegExp(`ALTER TABLE crm\\.signal ADD COLUMN IF NOT EXISTS ${c}\\b`),
      );
    }
    // 负向对照：本迁移不得含任何破坏性语句
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });
});
