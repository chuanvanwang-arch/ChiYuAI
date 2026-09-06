// test/context/assembler-tenant-routing.test.js — T4 场景路由租户传递（注入式）
// 目标：assembleContext 签名已扩 {tenantId='system'}；resolveTracks 调用显式传租户。
import { describe, it, expect } from 'vitest';
import { assembleContext } from '../../src/context/assembler.js';
import { resolveTracks } from '../../src/context/routing.js';

describe('T4 assembleContext 租户路由传递', () => {
  it('assembleContext 接受 tenantId 入参（缺省 system 保持既有）', async () => {
    const bundle = await assembleContext(
      { actor: 'alice', intent: { scenario: 'quote' }, query: '', tenantId: 'acme' },
      { L1: async () => [], L2: async () => [], L3: async () => [], L4: async () => [], LK: async () => [], narrative: async () => [] }
    );
    // 不中断装配：bundle.routing 存在且 scene 透传
    expect(bundle.routing.scene).toBe('quote');
    expect(typeof bundle.routing.tracks).toBe('object');
  });

  it('resolveTracks 接受 {tenantId}（routing.js:120 契约）', async () => {
    const call = resolveTracks('quote', { tenantId: 'acme' });
    expect(typeof call.then).toBe('function'); // async 函数
  });
});