// 2026-09-18 D1 自愈链路回归锁：
// ① 迁移侧 —— particles.embedding 384→1024 必须是**幂等**迁移且已登记进 INCREMENTAL_SQL；
//    旧的一次性手工 SQL 必须已变为空操作壳（防 runbook 重跑清空全表向量）。
// ② 回填侧 —— 候选谓词必须能覆盖「非 NULL 的 hash 伪向量」这一缺陷子集（--force-hash），
//    且与 KMD 探针 D1 的指纹判据同源。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INCREMENTAL_SQL } from '../../db/migrate.js';
import {
  buildCandidateWhere,
  buildCandidateQuery,
  buildStaleCountQuery,
  parseVectorDim,
  parseTypes,
  HASH_FINGERPRINT_SQL,
  DEFAULT_BACKFILL_TYPES,
  REQUIRED_EMBED_DIM,
} from '../../scripts/lib/embedding-backfill-query.mjs';

const dbDir = fileURLToPath(new URL('../../db/', import.meta.url));
const NEW_MIGRATION = 'migration-2026-09-18-particles-embedding-1024.sql';
const OLD_MIGRATION = 'migration-2026-09-14-particles-embedding-1024.sql';

// 剥离 `--` 行注释后再做语义断言：否则注释里对旧实现的引用会污染正则判定
// （本用例首版即因此假红 —— 旧文件的 ALTER 已只存在于注释中）。
const stripComments = (sqlText) =>
  sqlText.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('particles.embedding 384→1024 迁移（D0 基线漂移自愈）', () => {
  it('幂等迁移已登记进 INCREMENTAL_SQL 且文件存在', () => {
    expect(INCREMENTAL_SQL, '须在清单内，否则旧库/生产库漏跑即永久停在 vector(384)').toContain(NEW_MIGRATION);
    expect(existsSync(dbDir + NEW_MIGRATION)).toBe(true);
  });

  it('迁移以「当前列类型」为闸，不含无条件 ALTER ... USING NULL（重复执行不得清空向量）', () => {
    const sql = stripComments(readFileSync(dbDir + NEW_MIGRATION, 'utf8'));
    // 必须有类型判定分支
    expect(sql).toMatch(/format_type\(a\.atttypid/);
    expect(sql).toMatch(/cur_type\s*=\s*'vector\(1024\)'/);
    // 必须有 DO 块（条件执行），而非裸语句
    expect(sql).toMatch(/DO \$\$/);
    // 负向：ALTER 必须落在 DO 块内部 —— 用「DO 块起始位置 < ALTER 位置」近似断言
    const doIdx = sql.indexOf('DO $$');
    const alterIdx = sql.search(/ALTER TABLE crm\.particles ALTER COLUMN embedding TYPE vector\(1024\)/);
    expect(alterIdx, '应含目标列维度迁移语句').toBeGreaterThan(-1);
    expect(alterIdx, 'ALTER 必须在 DO 块内（条件执行）').toBeGreaterThan(doIdx);
  });

  it('旧的一次性迁移已降级为空操作壳（不再执行 DDL）', () => {
    expect(existsSync(dbDir + OLD_MIGRATION), '保留外壳以防外部 runbook 引用文件名').toBe(true);
    const sql = stripComments(readFileSync(dbDir + OLD_MIGRATION, 'utf8'));
    expect(sql, '不得再含裸 ALTER（重跑会清空全表向量）').not.toMatch(
      /ALTER TABLE crm\.particles ALTER COLUMN embedding TYPE/,
    );
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP TABLE\b|\bTRUNCATE\b/i);
  });

  it('schema.sql 声明基线 = 迁移目标维度（两侧同源，防再次分叉）', () => {
    const schema = readFileSync(dbDir + 'schema.sql', 'utf8');
    expect(schema).toMatch(/embedding vector\(1024\)/);
    expect(REQUIRED_EMBED_DIM).toBe(1024);
  });
});

describe('回填候选谓词（防「存量假向量永不自愈」）', () => {
  it('默认模式只收 NULL 行（等价原行为，不误伤已嵌真向量）', () => {
    const w = buildCandidateWhere();
    expect(w).toBe('p.embedding IS NULL');
  });

  it('--force-hash 模式同时收纳 hash 伪向量，且判据与探针 D1 同源', () => {
    const w = buildCandidateWhere({ forceHash: true });
    expect(w).toContain('p.embedding IS NULL');
    expect(w).toContain(HASH_FINGERPRINT_SQL);
    // 指纹两要件：分量全非负 + 非零维 ≤ 32（与 kmd-closure-probe.mjs D1 一致）
    expect(w).toMatch(/minv, 0\) >= 0/);
    expect(w).toMatch(/nz, 0\) <= 32/);
    // 必须带 IS NOT NULL 前置，避免把 NULL 行当作 hash 伪向量重复计入
    expect(w).toMatch(/p\.embedding IS NOT NULL/);
  });

  it('候选查询：租户参数化绑定、LIMIT 为纯数字、无破坏性语句', () => {
    const a = buildCandidateQuery({ limit: 50, tenant: 'acme-auto', forceHash: true });
    expect(a.text).toContain('p.type = ANY($1::text[])');   // 类型先行占位
    expect(a.text).toContain('p.tenant_id = $2');
    expect(a.params).toEqual([DEFAULT_BACKFILL_TYPES, 'acme-auto']);
    expect(a.text).toMatch(/LIMIT 50\b/);
    const b = buildCandidateQuery({ limit: 7 });
    expect(b.params).toEqual([DEFAULT_BACKFILL_TYPES]);
    expect(b.text).toMatch(/LIMIT 7\b/);
    for (const q of [a.text, b.text, buildStaleCountQuery().text]) {
      expect(q).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|\bUPDATE\b/i);
    }
  });

  it('--types=all 时不再设类型条件（恢复全类型检索池），显式类型走数组绑定', () => {
    const all = buildCandidateQuery({ types: 'all' });
    expect(all.text).not.toMatch(/p\.type = ANY/);
    expect(all.params).toEqual([]);
    const some = buildCandidateQuery({ types: ['CRM_ACCOUNT', 'CRM_DEAL'] });
    expect(some.params).toEqual([['CRM_ACCOUNT', 'CRM_DEAL']]);
    // 缺省不得放宽范围（保持「只补知识」的既有语义，防静默全量重嵌）
    expect(buildCandidateQuery().text).toContain('p.type = ANY(');
    expect(DEFAULT_BACKFILL_TYPES).toEqual(['CRM_KNOWLEDGE']);
  });

  it('parseTypes：缺省/显式列表/all 三态解析正确', () => {
    expect(parseTypes(undefined)).toEqual(['CRM_KNOWLEDGE']);
    expect(parseTypes('')).toEqual(['CRM_KNOWLEDGE']);
    expect(parseTypes('all')).toBe('all');
    expect(parseTypes(' CRM_ACCOUNT , CRM_DEAL ')).toEqual(['CRM_ACCOUNT', 'CRM_DEAL']);
  });

  it('陈旧度统计与开关无关（候选=0 时仍须可见 hash_stale）', () => {
    const q = buildStaleCountQuery();
    expect(q.text).toContain(HASH_FINGERPRINT_SQL);
    expect(q.text).toMatch(/count\(\*\) AS stale/);
  });

  it('维度解析：仅接受 vector(<n>) 形态，异常值返回 null（触发显式失败路径）', () => {
    expect(parseVectorDim('vector(1024)')).toBe(1024);
    expect(parseVectorDim('vector(384)')).toBe(384);
    expect(parseVectorDim('')).toBeNull();
    expect(parseVectorDim(null)).toBeNull();
    expect(parseVectorDim('double precision[]')).toBeNull();
  });
});
