// test/page/permissionComposer.test.js — Task 5: 角色权限预解析（composeAttrFields）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 5 + fieldPermission.js#modeFor
// 纯函数核心：modeFor(rec, roleTag) 同步判定；permissionComposer 支持注入 rec 源（测试内联，无 DB）
import { describe, it, expect } from 'vitest';
import { composeAttrFields } from '../../src/page/permissionComposer.js';

// 内联 rec 源（代替 DB getMetaAttr）——权限仅由 rec.permission.roles[roleTag] 决定
const REC_SRC = {
  'CRM_DEAL.amount': { permission: { roles: { sales: 'readonly' } } },
  'CRM_DEAL.secret_field': { permission: { roles: { sales: 'hidden' } } },
  'CRM_DEAL.name': { permission: { roles: { sales: 'editable' } } },
};

describe('composeAttrFields 角色权限预解析', () => {
  it('sales 角色：amount→readonly、secret_field→hidden、name→editable', async () => {
    const out = await composeAttrFields('CRM_DEAL', 'sales',
      [{ slug: 'name' }, { slug: 'amount' }, { slug: 'secret_field' }],
      { recSource: (t, s) => REC_SRC[`${t}.${s}`] || null });
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.mode)).toEqual(['editable', 'readonly', 'hidden']);
  });

  it('未配置角色权限 → 默认 editable', async () => {
    const out = await composeAttrFields('CRM_DEAL', 'manager',
      [{ slug: 'name' }], { recSource: () => null });
    expect(out[0].mode).toBe('editable');
  });
});