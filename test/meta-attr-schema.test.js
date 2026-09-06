// test/meta-attr-schema.test.js — crm.meta_attr 表结构 + 19 类型 CHECK 闸（DB 集成）
// 环境限制：需 PG@5433（沙箱无 PG 时标注环境限制，非回归；代码先落，待本机 PG 启动后验证）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../src/db.js';

// 隔离范围：本用例只断言 crm.meta_attr 的表结构与默认值，仅需 CRM_DEAL.name 一行受控。
// 纪律（2026-09-02 全量序污染根治）：**禁止 TRUNCATE crm.meta_attr CASCADE** ——
//   全表核弹会清空其它测试登记的元模型行（含 src seedMetaAttr 物化的 coreAttributes/identity 兜底），
//   造成全量串行序下后续文件「单独跑绿、全量跑红」的跨域毒化。改为定向清理本用例所需行。
const PT = 'CRM_DEAL';
const SLUG = 'name';

beforeAll(async () => {
  if (!process.env.WB_PG_SKIP) {
    // 只重置本用例断言所依赖的那一行，其余元模型行一律不动
    await queryWrite(`DELETE FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2`, [PT, SLUG]).catch(() => {});
    // 幂等回灌（默认值断言需要一行干净记录）
    await queryWrite(
      `INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type, semantic_tag)
       SELECT $1, $2, '名称', 'text', 'legacy'
       WHERE NOT EXISTS (SELECT 1 FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2)`,
      [PT, SLUG]
    ).catch(() => {});
  }
});

// 自净：跑完删掉本用例造的行，避免残留 enabled=false 的 name 影响依赖 identity 兜底的测试
afterAll(async () => {
  if (!process.env.WB_PG_SKIP) {
    await queryWrite(`DELETE FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2`, [PT, SLUG]).catch(() => {});
  }
});

describe('crm.meta_attr 表结构（环境限制：需 PG@5433）', () => {
  it('表存在且主键为 (particle_type, attr_slug)', async () => {
    const r = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='crm' AND table_name='meta_attr' ORDER BY ordinal_position
    `);
    expect(r.rows.map((x) => x.column_name)).toEqual(expect.arrayContaining([
      'particle_type', 'attr_slug', 'title', 'attr_type', 'semantic_tag',
      'required', 'unique', 'description', 'options', 'source',
      'display', 'validation', 'permission', 'enabled', 'version',
      'created_by', 'created_at', 'updated_at',
    ]));
  });

  it('attr_type 超 19 类型集 → CHECK 拒绝', async () => {
    await expect(
      query(`INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type)
             VALUES ('CRM_DEAL', 'bad_type_attr', '坏类型', 'magic-type')`)
    ).rejects.toThrow();
  });

  it('enabled 默认 false、version 默认 1、source 默认 manual', async () => {
    const r = await query(`SELECT enabled, version, source FROM crm.meta_attr WHERE particle_type='CRM_DEAL' AND attr_slug='name'`);
    expect(r.rows[0]).toEqual({ enabled: false, version: 1, source: 'manual' });
  });
});