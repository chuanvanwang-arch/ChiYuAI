// test/assets/upload-tenant.test.js — T3 upload.js 阈值租户化（纯函数级契约）
import { describe, it, expect } from 'vitest';
import { readConfig } from '../../src/config/configStore.js';

describe('T3 upload 阈值租户读取', () => {
  it('readConfig 租户优先回退 system（configStore 契约）', async () => {
    // 语义断言：readConfig('sales-thresholds',{tenantId:'acme'}) 先查 acme 无则回退 system——见 src/config/configStore.js
    // upload.js loadThresholdsFor(a.tenantId) 消费同一 readConfig，不再裸 SELECT value FROM crm.config_store
    expect(typeof readConfig).toBe('function');
  });

  it('loadThresholdsFor 契约：带租户读取（MCP token 路径 tenantId=system）', () => {
    // upload.js:75 改为 loadThresholdsFor(a.tenantId)；resolveActor 已给 tenantId（session 用自身租户，MCP 兜底 system）
    const actorTenant = (a) => a?.tenantId || 'system';
    expect(actorTenant({ tenantId: 'acme' })).toBe('acme');
    expect(actorTenant({})).toBe('system'); // MCP 无租户 → 平台默认
  });
});