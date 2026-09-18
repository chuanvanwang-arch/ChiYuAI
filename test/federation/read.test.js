// test/federation/read.test.js — 联邦感知读（tenant_id = ANY 作用域；越权租户 0 行）
import { describe, it, expect } from 'vitest';
import { listFederatedParticles } from '../../src/federation/read.js';

// 模拟 DB：只返回 tenant_id ∈ params[0] 的行（复刻 tenant_id = ANY($1) 语义）
const FIXTURE = [
  { tenant_id: 'acme-mfg', type: 'CRM_OFFER_POLICY', id: 'v1' },
  { tenant_id: 'acme-mfg-dl-01', type: 'MFG_PROJECT', id: 'd1' },
  { tenant_id: 'acme-mfg-dl-02', type: 'MFG_PROJECT', id: 'd2' },
  { tenant_id: 'acme-mfg-dl-03', type: 'MFG_ORDER', id: 'd3' }, // 不在授权集合 → 必须被排除
];

function fakeQuery(rows) {
  return async (sql, params) => {
    const allowed = params[0]; // tenantIds（恒为首个参数）
    // read.js 仅在 type 存在时才把 type 推到 tenantIds 之后、limit 之前：
    //   type 存在 → params=[tenantIds, type, limit]（len 3）；否则 → params=[tenantIds, limit]（len 2）
    const typeFilter = params.length >= 3 ? params[1] : null;
    const out = rows.filter((r) => allowed.includes(r.tenant_id) && (!typeFilter || r.type === typeFilter));
    return { rows: out };
  };
}

describe('listFederatedParticles · 作用域', () => {
  it('仅返回授权集合内的租户数据；越权租户 0 行（cross_tenant_read_denied）', async () => {
    const rows = await listFederatedParticles({
      tenantIds: ['acme-mfg', 'acme-mfg-dl-01'],
      query: fakeQuery(FIXTURE),
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('v1');
    expect(ids).toContain('d1');
    expect(ids).not.toContain('d2'); // 未授权经销商
    expect(ids).not.toContain('d3'); // 越权经销商
  });

  it('type 过滤生效', async () => {
    const rows = await listFederatedParticles({ tenantIds: ['acme-mfg-dl-01', 'acme-mfg-dl-02'], type: 'MFG_PROJECT', query: fakeQuery(FIXTURE) });
    expect(rows.map((r) => r.id).sort()).toEqual(['d1', 'd2']);
  });

  it('空 tenantIds → 空结果（不泄漏任何租户）', async () => {
    const rows = await listFederatedParticles({ tenantIds: [], query: fakeQuery(FIXTURE) });
    expect(rows).toEqual([]);
  });
});
