// test/channels/kinds.test.js — 通道 kind **单一事实源**守卫（防多处集合漂移）
// 判据：通道 kind 集合只应由 channels/kinds.js 定义；各消费方（工厂键 / 预设 / verifyScope / ingest 包装）
//       必须与之一致——否则会出现「某处认、某处不认」的静默不一致（本仓头号假绿形态）。
import { describe, it, expect } from 'vitest';
import { CHANNEL_KIND_LIST, CHANNEL_KINDS, KIND_PROBE, isChannelKind } from '../../src/channels/kinds.js';
import { SYNC_PROVIDER_FACTORY } from '../../src/sync/factory.js';
import { PRESET_FACTORIES } from '../../src/sync/presets/index.js';
import { CHANNEL_KINDS as WIRING_KINDS } from '../../src/channels/channelIngestWiring.js';

describe('通道 kind 单一事实源', () => {
  it('isChannelKind 只认 4 通道；generic-rest/mcp/cli 不是通道', () => {
    for (const k of CHANNEL_KIND_LIST) expect(isChannelKind(k)).toBe(true);
    for (const k of ['generic-rest', 'generic-mcp', 'generic-cli', 'neocrm', '', null, undefined]) {
      expect(isChannelKind(k)).toBe(false);
    }
  });

  it('KIND_PROBE 键集与通道集合严格相等（无缺项/无幽灵项）', () => {
    expect(Object.keys(KIND_PROBE).sort()).toEqual([...CHANNEL_KIND_LIST].sort());
  });

  it('sync 工厂键与预设含全部通道 kind（可构造，非零接线）', () => {
    for (const k of CHANNEL_KIND_LIST) {
      expect(SYNC_PROVIDER_FACTORY[k]).toBeTypeOf('function');
      expect(PRESET_FACTORIES[k]).toBeTypeOf('function');
    }
  });

  it('ingest 包装的通道集合与单一源一致（无自建集合漂移）', () => {
    expect([...WIRING_KINDS].sort()).toEqual([...CHANNEL_KINDS].sort());
  });
});
