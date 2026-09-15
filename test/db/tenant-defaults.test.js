// test/db/tenant-defaults.test.js — T10 通用播种器（联测，需测试库）
// 计划：docs/superpowers/plans/2026-09-03-config-tenant-isolation-implementation.md §2-T10-4
// 扩展：2026-09-05 播种器 8 键（G6）——docs/2026-09-05-tenant-config-full-isolation-design.md §A-2
// 幂等：ON CONFLICT DO NOTHING 登记注册表；writeConfig upsert（禁 DELETE 铁律；写 decisionId=null 种子豁免）。
// 残留态：t-verify-t10* 标记租户留在测试库（幂等写 + 无 DELETE 铁律下不污染业务断言，对齐 shared-db-test-hygiene）。
import { describe, it, expect } from 'vitest';
import { seedTenantDefaults, DEFAULT_TENANT_SEED_KEYS } from '../../db/seed/tenantDefaults.js';
import { readConfig } from '../../src/config/configStore.js';

// 2026-09-05 用户裁决：8 键含 context-routing（仅复制模板到租户行，不改 system 行——红线保持）
// 2026-09-11（线索发现引擎 T1）：新增第 9 键 `discovery-rules`（租户级 discovery 差异化起点）；
//   `db/seed/tenantDefaults.js:18-36` 与 `KEY_FLAG_MAP` 已同步，此处断言随实现更新（原 8 键断言已过时）。
const SEED_9KEYS = [
  'sales-thresholds', 'named-account-targets', 'approval-config',
  'behavior-standard', 'finance-receivables', 'decision-retro',
  'agent-event-trigger', 'context-routing', 'discovery-rules',
];

describe('T10 seedTenantDefaults', () => {
  it('幂等：重复播种同租户不抛、不重复写', async () => {
    const r1 = await seedTenantDefaults('t-verify-t10', { salesThresholds: true });
    const r2 = await seedTenantDefaults('t-verify-t10', { salesThresholds: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // 播种后该租户 own sales-thresholds 行存在（readConfig 直查租户行）
    const cfg = await readConfig('sales-thresholds', { tenantId: 't-verify-t10' });
    expect(cfg).not.toBeNull();
  });

  it('默认空 opts：播种器不主动播种任何键（只登记注册表）', async () => {
    const r = await seedTenantDefaults('t-verify-t10-named', {});
    expect(r.ok).toBe(true);
    expect(r.seededKeys).toEqual([]); // 默认只登记注册表
    expect(r.skippedKeys).toEqual([]); // 空 opts 不筛选任何键 → 无跳过（区别于 all/显式键）
    // 播种器自身不写租户行（autoSeed 是 configStore 读侧兜底，非播种器行为）
    const { query } = await import('../../src/db.js');
    const rs = await query(
      `SELECT 1 FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
      ['t-verify-t10-named', 'named-account-targets']
    );
    expect(rs.rows.length).toBe(0);
  });

  it('DEFAULT_TENANT_SEED_KEYS 契约：8 个租户级差异化键（G6 扩展）', () => {
    expect(DEFAULT_TENANT_SEED_KEYS).toEqual(SEED_9KEYS);
  });

  it('all=true 播全量 9 键（各键均落租户行，值=system 模板）', async () => {
    const r = await seedTenantDefaults('t-verify-t10-all', { all: true });
    expect(r.ok).toBe(true);
    expect(r.seededKeys).toEqual(SEED_9KEYS);
    // 直接查库确认租户行真实存在（区分「播种产物」与「autoSeed 读兜底」）
    const { query } = await import('../../src/db.js');
    for (const k of SEED_9KEYS) {
      const rs = await query(
        `SELECT 1 FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
        ['t-verify-t10-all', k]
      );
      expect(rs.rows.length, `键 ${k} 应由播种器落租户行`).toBe(1);
    }
    // 播种值来自 system 模板（复制起点一致）
    const sys = await readConfig('sales-thresholds', { tenantId: 'system' });
    const own = await readConfig('sales-thresholds', { tenantId: 't-verify-t10-all' });
    expect(own.value).toMatchObject(sys.value);
  });
});
