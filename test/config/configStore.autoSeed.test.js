// test/config/configStore.autoSeed.test.js — configStore autoSeed（G1：完全独立不共享）
// 语义：租户缺键 → 读时自动从 system 模板落默认到该租户（_seeded 标记），不再运行时回退。
// 铁律：测试只清理测试租户 T 的键（DELETE 精确到 (tenant_id)），绝不触碰 system 基线。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/config/configStore.js';
import { queryWrite } from '../../src/db.js';

const T = 'e2e-tenant-autoseed';
const KEY = 'sales-thresholds';
const SYS = 'system';

async function cleanup() {
  // 只清测试租户 T + 通配 '*' 伪租户的键（其余租户/system 不动）——禁删铁律限代码运行时，测试隔离清键是既有范式
  await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id IN ($1, '*')`, [T]).catch(() => {});
}

describe('configStore autoSeed', () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it('租户缺键 → autoSeed 从 system 模板落租户并返回', async () => {
    const sys = await readConfig(KEY, { tenantId: SYS });
    expect(sys).toBeTruthy();

    // 清掉租户键（确保缺键状态）
    await cleanup();

    const t = await readConfig(KEY, { tenantId: T });
    expect(t).toBeTruthy();
    expect(t.value).toMatchObject({ bantcc: sys.value.bantcc }); // 模板内容对齐
    expect(t.value._seeded).toBe('system-template');             // 审计标记
    // 已落库：再次读直接命中租户行
    const again = await readConfig(KEY, { tenantId: T });
    expect(again.value._seeded).toBe('system-template');
  });

  it('已存在的租户键不被 autoSeed 覆盖', async () => {
    await writeConfig(KEY, { bantcc: { pass: 0.99 } }, { tenantId: T, decisionId: null });
    const t = await readConfig(KEY, { tenantId: T });
    expect(t.value.bantcc.pass).toBe(0.99); // 定制保留
    expect(t.value._seeded).toBeUndefined(); // 无 _seeded 标记（非模板来源）
  });

  it('system 直读不触发 autoSeed（自身就是源）', async () => {
    const s = await readConfig(KEY, { tenantId: SYS });
    expect(s.value._seeded).toBeUndefined(); // system 模板不带标记
  });

  it("'*' 通配视界读 → 返回 system 模板但不 autoSeed 写（防 '*' 伪租户污染）", async () => {
    // admin/sysadmin 经 scopeTenant → '*'；读语义=看平台默认，绝不为 '*' 落行
    const w = await readConfig(KEY, { tenantId: '*' });
    expect(w).toBeTruthy();
    expect(w.value).toMatchObject({ bantcc: (await readConfig(KEY, { tenantId: SYS })).value.bantcc });
    // 不落 '*' 行
    const { query } = await import('../../src/db.js');
    const rs = await query(`SELECT 1 FROM crm.config_store WHERE tenant_id='*' AND key=$1`, [KEY]);
    expect(rs.rows.length).toBe(0);
  });
});
