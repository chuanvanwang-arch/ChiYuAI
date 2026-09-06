// test/tender-connector.test.js — T3-11 标讯连接器 + 外部事件源（E16：大单网订阅/推送 → 线索挖掘）
// 验收：① 订阅条件可配置（关键词/区域） ② 匹配标讯自动生成线索（事件驱动） ③ 外部事件进总线（审计）
import { describe, it, expect, beforeEach } from 'vitest';
import { matchTender, filterTenders, pushTenderMatches } from '../src/connectors/tenderConnector.js';

// —— 标讯匹配纯逻辑（无 PG）——
describe('T3-11 · 标讯匹配纯逻辑', () => {
  it('关键词命中（大小写不敏感）+ 区域匹配 → ok', () => {
    const m = matchTender(
      { keywords: ['mes'], region: '江苏' },
      { id: 't1', title: 'XXX 区域 MES 系统建设项目', region: '江苏常州' }
    );
    expect(m.ok).toBe(true);
    expect(m.matched_keyword).toBe('mes');
  });

  it('关键词未命中 / 区域不匹配 → 拒绝', () => {
    expect(matchTender({ keywords: ['crm'], region: '' }, { id: 't1', title: 'ERP项目', region: '北京' }).ok).toBe(false);
    expect(matchTender({ keywords: ['mes'], region: '广东' }, { id: 't2', title: 'MES项目', region: '江苏' }).ok).toBe(false);
  });

  it('无关键词 = 不限（仅区域匹配）；缺标题 → 拒绝', () => {
    expect(matchTender({ keywords: [], region: '浙江' }, { id: 't3', title: '某项目', region: '浙江杭州' }).ok).toBe(true);
    expect(matchTender({ keywords: ['mes'], region: '' }, { id: 't4', region: '北京' }).ok).toBe(false);
  });

  it('批量筛选：订阅 vs 标讯流 → 命中列表', () => {
    const hits = filterTenders({ keywords: ['mes'], region: '' }, [
      { id: 't1', title: 'MES项目', region: '北京' },
      { id: 't2', title: 'ERP项目', region: '上海' },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe('t1');
  });
});

// —— 外部事件进总线（验收③）——
describe('T3-11 · tender_push 事件源', () => {
  it('命中 → TENDER_PUSHED 事件进总线（trace 域，含审计载荷）', () => {
    const emitted = [];
    const hits = pushTenderMatches(
      { keywords: ['mes'], region: '江苏', tenantId: 't1' },
      [{ id: 'b1', title: 'MES招标', region: '江苏' }, { id: 'b2', title: 'ERP招标', region: '北京' }],
      { emitFn: (...a) => emitted.push(a) }
    );
    expect(hits).toHaveLength(1);
    expect(emitted[0][0]).toBe('trace');
    expect(emitted[0][1]).toBe('TENDER_PUSHED');
    expect(emitted[0][2].tender_id).toBe('b1');
    expect(emitted[0][2].matched_keyword).toBe('mes');
    expect(emitted[0][2].tenant_id).toBe('t1');
  });

  it('无命中 → 无事件（不产生噪声）', () => {
    const emitted = [];
    const hits = pushTenderMatches({ keywords: ['xxx'], region: '' }, [{ id: 'b1', title: 'MES招标', region: '江苏' }], {
      emitFn: (...a) => emitted.push(a),
    });
    expect(hits).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });
});

// —— Action 接线（验收②：匹配标讯自动生成线索事件驱动；conn-tender-push 已注册）——
import { seedConnectorActions } from '../src/connectors/connectorActions.js';
import { resetRegistry, getAction, detectCrudExplosion } from '../src/action/registry.js';

describe('T3-11 · conn-tender-push Action 接线', () => {
  beforeEach(() => {
    resetRegistry();
    seedConnectorActions();
  });

  it('conn-tender-push 已注册（connector 命名空间 + autoDecision 第 0 闸 + sourcedFrom 边）', () => {
    const a = getAction('conn-tender-push');
    expect(a).not.toBeNull();
    expect(a.namespace).toBe('connector');
    expect(a.autoDecision).toBe(true);
    expect(a.autoWeakEdge).toBe(true);
    expect(a.weakPredicate).toBe('sourcedFrom');
  });

  it('反爆炸护栏：conn-tender-push 属连接器单意图域 Action（非 CRUD 爆炸）', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('conn-tender-push');
  });
});