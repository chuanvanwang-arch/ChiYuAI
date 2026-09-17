// test/channels/kinds.test.js — 通道 kind **单一事实源**守卫（防多处集合漂移）
// 判据：通道 kind 集合只应由 channels/kinds.js 定义；各消费方（工厂键 / 预设 / verifyScope / ingest 包装）
//       必须与之一致——否则会出现「某处认、某处不认」的静默不一致（本仓头号假绿形态）。
import { describe, it, expect } from 'vitest';
import {
  CHANNEL_KIND_LIST, CHANNEL_KINDS, KIND_PROBE, isChannelKind,
  CHANNEL_SHORT, ENRICHMENT_KEY, DEFAULT_ENRICHMENT_KEY, channelShortName, enrichmentKeyOf,
} from '../../src/channels/kinds.js';
import { SYNC_PROVIDER_FACTORY } from '../../src/sync/factory.js';
import { PRESET_FACTORIES } from '../../src/sync/presets/index.js';
import { CHANNEL_KINDS as WIRING_KINDS } from '../../src/channels/channelIngestWiring.js';
import { readFileSync } from 'node:fs';

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

  // ── 通道短名 / enrichment 落点键（设计 §3.0 与 §3.1–§3.4）──
  it('CHANNEL_SHORT 键集＝通道集合，且短名为 email/calendar/meeting/wechat', () => {
    expect(Object.keys(CHANNEL_SHORT).sort()).toEqual([...CHANNEL_KIND_LIST].sort());
    expect(Object.values(CHANNEL_SHORT).sort()).toEqual(['calendar', 'email', 'meeting', 'wechat']);
  });

  it('落点键**逐通道分键**（不得合并为单一 email_intent）', () => {
    expect(ENRICHMENT_KEY.email).toBe('email_intent');
    expect(ENRICHMENT_KEY.calendar).toBe('schedule');
    expect(ENRICHMENT_KEY.meeting).toBe('meeting_intents');
    expect(ENRICHMENT_KEY.wechat).toBe('wechat_intents');
    // 4 个通道 → 4 个互不相同的键（合并会导致「同一键两处解释权」）
    expect(new Set(Object.values(ENRICHMENT_KEY)).size).toBe(4);
    // 键集与通道短名一一对应（无缺项/无幽灵项）
    expect(Object.keys(ENRICHMENT_KEY).sort()).toEqual(Object.values(CHANNEL_SHORT).sort());
  });

  it('enrichmentKeyOf 同时接受短名与 provider kind；不可判定回落到邮件键', () => {
    for (const kind of CHANNEL_KIND_LIST) {
      const short = CHANNEL_SHORT[kind];
      expect(enrichmentKeyOf(kind)).toBe(ENRICHMENT_KEY[short]); // 传 kind
      expect(enrichmentKeyOf(short)).toBe(ENRICHMENT_KEY[short]); // 传短名
    }
    expect(enrichmentKeyOf(undefined)).toBe(DEFAULT_ENRICHMENT_KEY);
    expect(enrichmentKeyOf(null)).toBe(DEFAULT_ENRICHMENT_KEY);
    expect(enrichmentKeyOf('unknown-thing')).toBe(DEFAULT_ENRICHMENT_KEY);
    expect(channelShortName('generic-email')).toBe('email');
    expect(channelShortName('email')).toBe('email');
    expect(channelShortName('nope')).toBe(null);
  });

  it('channelProvider 不自建短名表（防与单一源漂移）', () => {
    const src = readFileSync(new URL('../../src/channels/channelProvider.js', import.meta.url), 'utf8');
    // 剥离注释后不得出现本地字面量表（"'generic-email': 'email'" 这类映射）
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/'generic-email'\s*:\s*'email'/);
    expect(code).toContain("from './kinds.js'");
  });
});
