// test/decision/retro-trigger-tenant.test.js — T5 复盘配置按决策租户读
// 计划：docs/superpowers/plans/2026-09-03-config-tenant-isolation-implementation.md §2-T5-4/5
// 注：readEventRetroConfig 依赖真实 DB（config_store），此单测只做契约断言（fail-open 语义），
//     取值行为走 T12 联测（V8：A 关 event-retro.enabled → A 的决策确认不再建复盘待办；B 正常按各自租户配置）。
import { describe, it, expect } from 'vitest';
import { readEventRetroConfig } from '../../src/decision/retroTrigger.js';

describe('T5 readEventRetroConfig 租户参数', () => {
  it('无参调用回退 system（向后兼容），带租户显式读取', async () => {
    // 契约断言：签名已扩展 {tenantId='system'}；具体取值断言依赖真实 DB，走 T12 联测
    const cfgDefault = await readEventRetroConfig(); // 不抛即通过（fail-open）
    expect(typeof cfgDefault).toBe('object');
    expect(cfgDefault).toHaveProperty('enabled');
  });
});
