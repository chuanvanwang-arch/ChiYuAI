// test/decision/edgeSource.test.js — T0(BG-04) 边来源口径隔离单测
// 覆盖：来源判定 / 双口径拆分计数 / listTypedEdges runtimeOnly 口径接线。
import { describe, it, expect } from 'vitest';
import {
  DEMO_EDGE_SOURCES,
  isDemoEdgeSource,
  isRuntimeEdgeSource,
  splitEdgesByCaliber,
  edgeCaliberCount,
  runtimeEdgesOnly,
} from '../../src/decision/edgeSource.js';
import { listTypedEdges } from '../../src/decision/relation.js';

const mkEdge = (rel_type, source) => ({ rel_id: rel_type, from_id: 'a', to_id: 'b', rel_type, source });

describe('T0 边来源判定', () => {
  it('DEMO_EDGE_SOURCES 含 seed-script', () => {
    expect(DEMO_EDGE_SOURCES).toContain('seed-script');
  });
  it('isDemoEdgeSource / isRuntimeEdgeSource 互补', () => {
    expect(isDemoEdgeSource('seed-script')).toBe(true);
    expect(isRuntimeEdgeSource('seed-script')).toBe(false);
    expect(isDemoEdgeSource('engine')).toBe(false);
    expect(isRuntimeEdgeSource('engine')).toBe(true);
    expect(isRuntimeEdgeSource(undefined)).toBe(false); // NULL 来源不计入运行时
    expect(isRuntimeEdgeSource(null)).toBe(false);
  });
});

describe('T0 双口径拆分与计数', () => {
  const edges = [
    mkEdge('DECIDED_ON', 'engine'),
    mkEdge('REFERENCED_PRECEDENT', 'seed-script'),
    mkEdge('CAUSED', 'mcp'),
    mkEdge('OVERRIDES', null), // NULL 来源归演示口径
  ];
  it('splitEdgesByCaliber 正确分堆', () => {
    const { runtime, demo } = splitEdgesByCaliber(edges);
    expect(runtime.map((e) => e.rel_type)).toEqual(['DECIDED_ON', 'CAUSED']);
    expect(demo.map((e) => e.rel_type)).toEqual(['REFERENCED_PRECEDENT', 'OVERRIDES']);
  });
  it('edgeCaliberCount 给双口径 N/M', () => {
    expect(edgeCaliberCount(edges)).toEqual({ runtime: 2, demo: 2 });
  });
  it('runtimeEdgesOnly 仅运行时', () => {
    expect(runtimeEdgesOnly(edges).map((e) => e.rel_type)).toEqual(['DECIDED_ON', 'CAUSED']);
  });
  it('空数组安全', () => {
    expect(edgeCaliberCount([])).toEqual({ runtime: 0, demo: 0 });
    expect(splitEdgesByCaliber().runtime).toEqual([]);
  });
});

describe('T0 listTypedEdges runtimeOnly 口径接线', () => {
  it('runtimeOnly=false 返回全量（含演示边）', async () => {
    const captured = {};
    const fakeQuery = async (sql, params) => { captured.sql = sql; captured.params = params; return { rows: [mkEdge('DECIDED_ON', 'engine'), mkEdge('REFERENCED_PRECEDENT', 'seed-script')] }; };
    const rows = await listTypedEdges('d1', { direction: 'both', runtimeOnly: false, query: fakeQuery });
    expect(rows).toHaveLength(2);
    expect(captured.sql).not.toContain('seed-script');
  });

  it('runtimeOnly=true 在 SQL 注入演示来源排除（<> ALL），且调用方据此过滤演示边', async () => {
    const captured = {};
    const fakeQuery = async (sql, params) => {
      captured.sql = sql; captured.params = params;
      // 模拟 PG：返回已按 runtimeOnly 过滤后的运行时边（演示边不入结果）
      return { rows: [mkEdge('DECIDED_ON', 'engine')] };
    };
    const rows = await listTypedEdges('d1', { direction: 'both', runtimeOnly: true, query: fakeQuery });
    // 字面值 'seed-script' 以参数形式传入（<> ALL($2::text[])），SQL 本身不含字面量
    expect(captured.sql).toContain('<> ALL');
    expect(captured.sql).toContain('source IS NOT NULL');
    expect(captured.params).toContainEqual(['seed-script']);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('engine');
  });

  it('runtimeOnly=true 对空 entityId 直接返回 []', async () => {
    const fakeQuery = async () => { throw new Error('不应被调用'); };
    expect(await listTypedEdges(null, { runtimeOnly: true, query: fakeQuery })).toEqual([]);
  });
});
