// test/approval/approvalConfigTenant.test.js — G2 approval-config 消费链租户化验证
// 2026-09-05 详细设计 docs/superpowers/plans/2026-09-05-tenant-config-full-isolation.md Task 7 Step 1 落地
// 验证：① 租户读 approval-config → 该租户定制生效（不污染 system）；② system 读 → 出厂基线；
//       ③ 缺键自动落租户行（autoSeed，_seeded 标记）。禁 DELETE 铁律：清理走 UPDATE 归位 + 保留行。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readApprovalConfig, DEFAULT_APPROVAL_CONFIG } from '../../src/approval/approvalConfig.js';
import { readConfig, writeConfig } from '../../src/config/configStore.js';
import { queryWrite } from '../../src/db.js';

const T = 'e2e-tenant-appr'; // 测试租户（与详细设计一致）
const KEY = 'approval-config';

beforeAll(async () => {
  // 幂等补齐 system 模板（autoSeed 依赖：测试库可能缺 system 的 approval-config 模板行）
  const { queryWrite } = await import('../../src/db.js');
  await queryWrite(
    `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
     VALUES ('system', $1, $2::jsonb, 'system', now())
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [KEY, JSON.stringify({ tierThresholds: { t2: 1000000, t3: 5000000 } })]
  ).catch(() => {});
  // 幂等写测试租户定制（覆盖残留）
  await writeConfig(KEY, { tierThresholds: { t2: 999999 } }, { tenantId: T, decisionId: null });
});

afterAll(async () => {
  // 禁 DELETE 铁律：将测试租户行归位为出厂基线（autoSeed 语义同源），不删行
  await queryWrite(
    `UPDATE crm.config_store SET value='{}'::jsonb, _seeded='e2e-reset' WHERE tenant_id=$1 AND key=$2`,
    [T, KEY]
  ).catch(() => {});
});

describe('approval-config 租户化（G2）', () => {
  it('租户读 approval-config → 该租户定制生效', async () => {
    const cfg = await readApprovalConfig(T);
    expect(cfg.tierThresholds.t2).toBe(999999);
  });

  it('system 读 → 出厂基线（不被租户污染）', async () => {
    const cfg = await readApprovalConfig('system');
    expect(cfg.tierThresholds.t2).toBe(DEFAULT_APPROVAL_CONFIG.tierThresholds.t2);
    expect(cfg.tierThresholds.t2).not.toBe(999999);
  });

  it('缺键租户读 → autoSeed 落租户行（_seeded 标记）', async () => {
    // 用全新租户触发 autoSeed（T 已被 beforeAll 写过定制行，无 autoSeed 机会）
    const v = await readConfig(KEY, { tenantId: 'e2e-appr-fresh' });
    expect(v?.value?._seeded).toBe('system-template');
  });
});
