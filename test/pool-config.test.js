// test/pool-config.test.js — T3-12 池配置读写 + 门户组件扩展（A4/H29）
// 验收：① 池配置可读写（不重启生效，落地 CRM_ORGANIZATION.pool_config）② 子表格/选择器渲染可用（renderer 扩展）
import { describe, it, expect } from 'vitest';
import { DEFAULT_POOL_CONFIG, getPoolConfig, setPoolConfig, checkPickRule, checkRecycleRule } from '../src/sales/pool.js';
import { renderPage } from '../src/page/renderer.js';
import { COMPONENT_KINDS } from '../src/page/schema.js';

// —— 池配置读写（验收①：不重启生效；B6 池=组织治理配置；query 注入 stub，不依赖真实 PG）——
const makeStubDb = (initial = {}) => {
  const store = new Map(Object.entries(initial)); // slug -> payload
  const records = [];
  return {
    store,
    records, // 记录每次 UPDATE（审计断言用）
    async query(sql, params) {
      // SELECT
      if (/^SELECT/.test(sql)) {
        const slug = params[0];
        const rec = store.get(slug);
        if (!rec) return { rows: [] };
        return { rows: [{ payload: rec }] };
      }
      // UPDATE
      if (/^UPDATE/.test(sql)) {
        const [json, slug] = params;
        const cur = store.get(slug) || {};
        const merged = { ...cur, ...JSON.parse(json) };
        store.set(slug, merged);
        records.push({ slug, patch: JSON.parse(json), merged });
        return { rows: [{ payload: merged }] };
      }
      throw new Error(`stub 未支持的 SQL: ${sql}`);
    },
  };
};

describe('T3-12 · 池配置读写', () => {
  it('getPoolConfig 幂等补齐默认值（存量 org-hq 空占位 → 默认规则）', async () => {
    const db = makeStubDb(); // 空库：org-hq 不存在
    const cfg = await getPoolConfig('org-hq-missing', { query: db.query });
    expect(cfg.pick_rule.daily_limit).toBe(DEFAULT_POOL_CONFIG.pick_rule.daily_limit);
    expect(cfg.recycle_rule.recycle_days).toBe(DEFAULT_POOL_CONFIG.recycle_rule.recycle_days);
  });

  it('setPoolConfig 合并写（默认 + 补丁）且回读生效（不重启）', async () => {
    const db = makeStubDb({ 'org-hq': {} }); // 存量 org-hq 空池配置（seed 占位）
    const after = await setPoolConfig('org-hq', { pick_rule: { daily_limit: 5 } }, { query: db.query });
    expect(after.pick_rule.daily_limit).toBe(5);      // 补丁覆盖
    expect(after.recycle_rule.recycle_days).toBe(30); // 未改保持默认
    // UPDATE 审计：payload || 合并（不覆盖其他字段）
    expect(db.records).toHaveLength(1);
    expect(db.records[0].merged.pool_config.pick_rule.daily_limit).toBe(5);
  });

  it('setPoolConfig 目标组织不存在 → 拒绝', async () => {
    const db = makeStubDb(); // 空库
    await expect(setPoolConfig('nope', { pick_rule: {} }, { query: db.query })).rejects.toThrow('组织不存在');
  });

  it('领取/回收规则判定仍可用（纯逻辑，未回归）', () => {
    expect(checkPickRule({ daily_limit: 2, pick_interval_hours: 24 }, { today_picked_count: 2 }).ok).toBe(false);
    expect(checkRecycleRule({ recycle_days: 30 }, { last_follow_up_at: new Date(Date.now() - 31 * 86400000).toISOString() }).ok).toBe(true);
  });
});

// —— 门户组件扩展（验收②：子表格/选择器渲染可用）——
describe('T3-12 · renderer 子表格/选择器扩展', () => {
  it('COMPONENT_KINDS 值域已含 subtable/select', () => {
    expect(COMPONENT_KINDS).toContain('subtable');
    expect(COMPONENT_KINDS).toContain('select');
  });

  it('subtable 子表格渲染（合同详情 → 回款计划子明细）', () => {
    const { html, warnings } = renderPage({
      type: 'table', title: '合同回款明细', navigation: { to: '/deals' },
      components: [{
        kind: 'subtable', title: '回款计划',
        dataBinding: { source: 'particle', particleType: 'CRM_PAYMENT_PLAN' },
        mainColumn: 'contract_no', subRows: 'plans', subColumns: ['seq', 'amount', 'status'],
        actions: [],
      }],
    }, { components: { subtable: { rows: [{ contract_no: 'HT-001', plans: [{ seq: 1, amount: 50000, status: 'pending' }, { seq: 2, amount: 50000, status: 'done' }] }] } } });
    expect(warnings).toHaveLength(0);
    expect(html).toContain('pg-subtable');
    expect(html).toContain('HT-001');
    expect(html).toContain('50000');
  });

  it('select 选择器渲染（目标池/人员选择；离职禁用仍展示）', () => {
    const { html, warnings } = renderPage({
      type: 'form', title: '线索移入池', navigation: { to: '/workspace' },
      components: [{
        kind: 'select', title: '目标池', name: 'pool_id', action: 'crm-lead-move',
        dataBinding: { source: 'particle', particleType: 'CRM_ORGANIZATION', options: ['pool-a'] },
        label: '移入目标池',
      }],
    }, { components: { select: { options: [{ value: 'pool-a', label: '华东池' }, { value: 'pool-b', label: '华南池' }], value: 'pool-b' } } });
    expect(warnings).toHaveLength(0);
    expect(html).toContain('pg-select');
    expect(html).toContain('pool-a');
    expect(html).toContain('selected'); // pool-b 默认选中
    expect(html).toContain('disabled'); // pool-a 禁用（离职/禁用仍展示）
  });
});