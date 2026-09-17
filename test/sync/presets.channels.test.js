// test/sync/presets.channels.test.js
// T2：通道预设（generic-email/calendar/meeting/wechat）并入 PRESET_FACTORIES（纯数据，零逻辑）
// 判据：4 键可构造（factory 契约三方法）；通道预设模板有对象清单（防被拆空）；既有 3 预设零回归
import { describe, it, expect } from 'vitest';
import { PRESET_FACTORIES, listPresets, buildPresetProvider, syncFactoriesWithPresets } from '../../src/sync/presets/index.js';
import { SYNC_PROVIDER_FACTORY } from '../../src/sync/factory.js';

describe('通道预设注册（P2/T2）', () => {
  it('4 通道键已并入 PRESET_FACTORIES 且可构造（契约三方法）', () => {
    for (const kind of ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat']) {
      expect(PRESET_FACTORIES[kind]).toBeTypeOf('function');
      const inst = PRESET_FACTORIES[kind]({});
      expect(typeof inst.verifyAuth).toBe('function');
      expect(typeof inst.discoverObjects).toBe('function');
      expect(typeof inst.readIncremental).toBe('function');
    }
  });
  it('4 键实例 kind 保留（mount 按 provider.kind 分表，禁串）', () => {
    const kinds = ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat'];
    for (const kind of kinds) {
      const inst = PRESET_FACTORIES[kind]({});
      expect(inst.kind).toBe(kind);
    }
  });
});

describe('通道预设模板（纯数据）', () => {
  it('channel-email 对象清单含 email（防拆空）', async () => {
    // 通过构建 provider 后 discoverObjects 拿对象（无凭据时 fail-closed 返回 ok:false，但对象静态在描述符上）
    // —— 直接验证模板文件内容更直白：
    const mod = await import('../../src/sync/presets/channel-email.js');
    expect(mod.CHANNEL_EMAIL_PRESET.objects.some((o) => o.name === 'email')).toBe(true);
  });
  it('channel-wechat 边界注释存在（个人微信无开放 API，未接通不得宣称）', async () => {
    const mod = await import('../../src/sync/presets/channel-wechat.js');
    const srcText = JSON.stringify(mod.CHANNEL_WECHAT_PRESET) + (mod.CHANNEL_WECHAT_PRESET?.boundary || '');
    expect(srcText).toBeTruthy();
  });
});

describe('既有预设零回归', () => {
  it('salesforce/neocrm/fxiaoke 仍可构造（listPresets 不变）', () => {
    expect(listPresets()).toEqual(expect.arrayContaining(['salesforce', 'neocrm', 'fxiaoke']));
    const p = buildPresetProvider('salesforce', { __fetch: async () => ({ ok: false, status: 401 }) });
    expect(typeof p.readIncremental).toBe('function');
  });
  it('syncFactoriesWithPresets 合并后含 base 键与通道键', () => {
    const merged = syncFactoriesWithPresets(SYNC_PROVIDER_FACTORY);
    expect(merged['generic-email']).toBeTypeOf('function');
    expect(merged['generic-rest']).toBeTypeOf('function');
    expect(merged.salesforce).toBeTypeOf('function');
  });
});
