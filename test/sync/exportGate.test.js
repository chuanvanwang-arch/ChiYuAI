// test/sync/exportGate.test.js — 运行时顺序闸门（全链集成 Q3-3，设计 §3.4）
// 零 DB：query / readConfig / detectFn 全部注入替身。
// 三判据（设计 §3.4）：① 窗口内存在 status='sent' 行 ② 渠道集合来自 config_store
//                      ③ 无「配置为 on 但零投递行」的渠道（复用 Q1-4 修正后的判据 A）
// 铁律：fail-closed —— 任一判据为假 **或判定过程抛错**，一律 not healthy（绝不返回 healthy）。
import { describe, it, expect } from 'vitest';
import { createExportGate, DEFAULT_WINDOW_HOURS } from '../../src/sync/exportGate.js';

const rc = (value) => async () => (value === null ? null : { value });
const CONFIGURED = { channels: { inbox: 'on', email: 'off' } };

// 替身 query：只认 signal_delivery 的 sent 计数
function q(sentCount) {
  return async () => ({ rows: [{ c: sentCount }] });
}
// 替身 detect：返回给定告警数组
const noAlert = async () => [];
const silentAlert = async () => [{ type: 'delivery_silent', channel: 'email', tenant_id: 't1' }];
const genSilentOnly = async () => [{ type: 'gen_silent', tenant_id: 't1', fired: 3 }];

function gate({ sent = 0, cfg = CONFIGURED, detect = noAlert } = {}) {
  return createExportGate({ query: q(sent), readConfig: rc(cfg), detectFn: detect });
}

describe('exportGate.isExportHealthy（三判据真值表）', () => {
  it('三判据全真 → healthy', async () => {
    const r = await gate({ sent: 2 }).isExportHealthy({ tenantId: 't1' });
    expect(r.healthy).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.checks).toEqual({ sent_exists: true, channels_from_config: true, no_silent_channel: true });
  });

  it('判据①假（窗口内零 sent 行）→ not healthy，reason 含 sent_exists', async () => {
    const r = await gate({ sent: 0 }).isExportHealthy({ tenantId: 't1' });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('sent_exists');
  });

  it('判据②假（配置缺失）→ not healthy，reason 含 channels_from_config', async () => {
    const r = await gate({ sent: 3, cfg: null }).isExportHealthy({ tenantId: 't1' });
    expect(r.healthy).toBe(false);
    expect(r.checks.channels_from_config).toBe(false);
    expect(r.reason).toContain('channels_from_config');
  });

  it('判据②假（配置存在但全部 off → 无启用渠道）→ not healthy', async () => {
    const r = await gate({ sent: 3, cfg: { channels: { inbox: 'off', email: 'off' } } }).isExportHealthy({ tenantId: 't1' });
    expect(r.checks.channels_from_config).toBe(false);
    expect(r.healthy).toBe(false);
  });

  it('判据③假（某启用渠道零投递行）→ not healthy，reason 含 no_silent_channel', async () => {
    const r = await gate({ sent: 3, detect: silentAlert }).isExportHealthy({ tenantId: 't1' });
    expect(r.checks.no_silent_channel).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('no_silent_channel');
  });

  it('判据③的输入只取 delivery_silent：gen_silent 不得关闸（出口健康 ≠ 生成侧健康）', async () => {
    const r = await gate({ sent: 3, detect: genSilentOnly }).isExportHealthy({ tenantId: 't1' });
    expect(r.checks.no_silent_channel).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it('窗口由 windowHours 派生（默认 24h），并回传 tenant_id', async () => {
    const r = await gate({ sent: 1 }).isExportHealthy({ tenantId: 't-system' });
    expect(r.tenant_id).toBe('t-system');
    expect(r.window_hours).toBe(DEFAULT_WINDOW_HOURS);
    expect(DEFAULT_WINDOW_HOURS).toBe(24);
  });
});

describe('exportGate.guard（fail-closed 包装 + trace 留痕）', () => {
  it('healthy → allowed:true', async () => {
    const r = await gate({ sent: 1 }).guard({ tenantId: 't1', action: 'sync-writeback-fields' });
    expect(r.allowed).toBe(true);
  });

  it('不健康 → allowed:false + error=blocked_by_export_gate + emit trace', async () => {
    const traces = [];
    const r = await gate({ sent: 0 }).guard({
      tenantId: 't1', action: 'sync-writeback-fields', emit: (k, name, p) => traces.push({ name, p }),
    });
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
    expect(traces.find((x) => x.name === 'export-gate-blocked')?.p).toMatchObject({
      tenant_id: 't1', action: 'sync-writeback-fields',
    });
  });

  it('判定抛错 → allowed:false（**绝不**因异常而放行）且 trace 留痕', async () => {
    const traces = [];
    const g = createExportGate({
      query: async () => { throw new Error('db down'); },
      readConfig: rc(CONFIGURED),
      detectFn: noAlert,
    });
    const r = await g.guard({ tenantId: 't1', action: 'sync-writeback-fields', emit: (k, name, p) => traces.push({ name, p }) });
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
    expect(r.reason).toContain('gate_error');
    expect(traces.find((x) => x.name === 'export-gate-error')).toBeTruthy();
  });

  it('readConfig 抛错 → 判据②为假 → 阻断（读取失败 ≠ 配置开启）', async () => {
    const g = createExportGate({
      query: q(5),
      readConfig: async () => { throw new Error('cfg down'); },
      detectFn: noAlert,
    });
    const r = await g.guard({ tenantId: 't1', action: 'x' });
    expect(r.allowed).toBe(false);
  });
});
