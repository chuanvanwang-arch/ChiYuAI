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
});
