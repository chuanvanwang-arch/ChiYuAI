import { test, expect } from 'vitest';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const TARGET_IDS = [35, 39, 44, 36];
const byId = Object.fromEntries(CONFIG_ITEMS.map((i) => [i.id, i]));

// 方案 α（2026-09-06 拍板）：approval_flow 无 tenant_id（db/migrate-config.sql:48 全局 PK）→ 数据实为平台级共享。
// 标签由 scope:'tenant' 校正为 'platform'（与事实一致）；level:'tenant' 保持（ten_admin 可配置本租户流，权限层级不变）。
test('id17 审批流配置标签平台级化（scope=platform, resolve=system-only, level=tenant）', () => {
  const it = byId[17];
  expect(it, 'config id 17 应存在').toBeDefined();
  expect(it.scope, 'id17 scope 应为 platform（数据平台级共享）').toBe('platform');
  expect(it.resolve, 'id17 resolve 应为 system-only').toBe('system-only');
  expect(it.level, 'id17 level 保持 tenant（租户级可达，权限层级不变）').toBe('tenant');
});

test('id35/39/44/36 标签修正为平台级（scope=platform, resolve=system-only）', () => {
  for (const id of TARGET_IDS) {
    const it = byId[id];
    expect(it, `config id ${id} 应存在`).toBeDefined();
    expect(it.scope, `id ${id} scope 应为 platform`).toBe('platform');
    expect(it.resolve, `id ${id} resolve 应为 system-only`).toBe('system-only');
    // 与 level 一致（平台级配置）
    expect(it.level).toBe('system');
  }
});
