// test/signal/derivationTenantEnumeration.test.js — T18 派生器「租户枚举源」回归守卫
//
// 为什么需要（2026-09-17 实测发现的第 2 起结构性永零命中，与 payload.updated_at 同族）：
//   原实现用 `SELECT DISTINCT tenant_id FROM crm.config_store WHERE key='internal-signal-derivation'`
//   枚举租户。但 configStore 的 autoSeed 是**只读触发**的懒克隆（configStore.js:12），
//   而唯一会去读该键的消费方**正是本扫描器自己** ⇒ 循环依赖：
//     租户要先有该键才会被扫 ↔ 键又要靠被扫（读配置）才 autoSeed 出来
//   ⇒ **新租户永远不会被扫描**，`contact_change` / `relation_cooling` 对它结构性永零。
//   设计文档 §验收明写：「count(*)=1（system 模板，经 readConfig autoSeed 覆盖租户）」——
//   即设计意图是「扫全活跃租户 → 读配置时 autoSeed 落键」，不是「键先存在才扫」。
//   修法＝与兄弟扫描器 T15 `signal-schedule-scan`（timers.js 用 tenantRepo.listActiveTenants()）同源。
//
// 守卫要点：① 行为（注入 N 个租户必须扫 N 个，旧实现得 0）；② 源码不得退回该 SQL；
//           ③ 空注入不得把租户全丢（fail-safe 回退 system）；④ 枚举来源必须上返回值（不静默）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createActivityDerivation } from '../../src/signal/activityDerivation.js';

const SRC = readFileSync('src/signal/activityDerivation.js', 'utf8');
const CFG = {
  value: {
    enabled: true,
    rules: [{
      id: 'contact-change', kind: 'contact_change', entity_type: 'CRM_CONTACT',
      window_days: 14, severity: 'low', bucket: 'day',
    }],
  },
};

function build() {
  const created = [];
  const query = async (sql) => {
    // 关键替身形状：对 **config_store 枚举 SQL 一律回空行**。
    //   旧实现（按键枚举租户）在此形状下 tenants=0 → 零产出；
    //   新实现不依赖该 SQL → 仍扫全部注入租户。这正是本缺陷的判别式。
    if (/config_store/i.test(sql)) return { rows: [] };
    return { rows: [{ id: 'p1', tenant_id: null, payload: {}, updated_at: new Date().toISOString() }] };
  };
  const derivation = createActivityDerivation({
    query,
    signalStore: { create: async (r) => { created.push(r); return { ok: true, deduped: false }; } },
    readConfig: async () => CFG,
  });
  return { derivation, created };
}

describe('[回归] T18 租户枚举源＝活跃租户表，不是 config_store 键行', () => {
  it('① 注入 2 个租户 → 两个都被扫描派生（旧实现会得 0，＝结构性永零命中）', async () => {
    const { derivation, created } = build();
    const r = await derivation.deriveAllTenants({ tenants: [{ tenant_id: 't-a' }, { tenant_id: 't-b' }] });
    expect(r.tenants).toBe(2);
    expect(r.tenant_source).toBe('injected');
    expect([...new Set(created.map((c) => c.tenant_id))].sort()).toEqual(['t-a', 't-b']);
    expect(created.length).toBe(2);
    expect(r.signals).toBe(2);
  });

  it('② 源码不得再用「config_store 按键枚举租户」（防退回循环依赖缺陷）', () => {
    // ⚠ 必须**剥离注释**后再断言（判据③ 注释≠实现）：本文件头注为了解释缺陷，
    //   逐字引用了那条旧 SQL —— 若直接对原文断言，注释会把它"永远钉在"源码里 ⇒ 假红。
    //   反之修复说明也不该靠注释保留 SQL 原文，故两边都按剥离后的实现体判定。
    const CODE = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')            // 块注释
      .replace(/(^|[^:])\/\/.*$/gm, '$1');         // 行注释（[^:] 避免误伤 http://）
    expect(CODE).not.toMatch(/DISTINCT\s+tenant_id\s+FROM\s+crm\.config_store/i);
    expect(CODE).not.toMatch(/FROM\s+crm\.config_store[\s\S]{0,120}key\s*=/i);
    expect(CODE).toContain('listActiveTenants');   // 与 T15 signal-schedule-scan 同源
    expect(CODE).toContain('tenant_source');       // 枚举来源必须可观测
  });

  it('③ 空注入 → 回退活跃租户表/system，不得把租户全丢', async () => {
    const { derivation } = build();
    const r = await derivation.deriveAllTenants({ tenants: [] });
    expect(['active_tenants', 'fallback_system']).toContain(r.tenant_source);
    expect(r.tenants).toBeGreaterThanOrEqual(1);
  });

  it('④ 非静默：返回值暴露枚举来源（能区分「扫了没人」与「根本没扫到人」）', async () => {
    const { derivation } = build();
    const r = await derivation.deriveAllTenants({ tenants: ['t-a'] });
    expect(r).toHaveProperty('tenant_source');
    expect(r.tenant_source).toBe('injected');
  });

  it('⑤ timers 日志带 tenant_source（生产可诊断）', () => {
    const timers = readFileSync('src/scheduler/timers.js', 'utf8');
    expect(timers).toContain('tenant_source: r.tenant_source');
  });
});
