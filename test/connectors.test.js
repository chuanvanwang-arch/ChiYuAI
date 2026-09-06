// test/connectors.test.js — 外部连接器 P0（④ 外部自动采集的落地）
// 设计输入：12 文档 §7-4 + 总体设计 §4 安全红线（净化 + 参数化 + 禁删 + auto_weak 低置信需 review）
// 纯逻辑：Action 注册元信息断言（不触 DB）；handler 真实写走第 0 闸 autoDecision
import { describe, it, expect, beforeEach } from 'vitest';
import { getAction, resetRegistry } from '../src/action/registry.js';
import { seedConnectorActions } from '../src/connectors/connectorActions.js';

beforeEach(() => { resetRegistry(); });

describe('外部连接器 P0（④ 外部自动采集）', () => {
  it('conn-attio-enrich-account 已注册（写 + autoDecision 过第0闸 + connector 命名空间）', () => {
    seedConnectorActions();
    const a = getAction('conn-attio-enrich-account');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('connector');
  });

  it('conn-zhizao-verify-account 已注册（工商校验 enrichment）', () => {
    seedConnectorActions();
    const a = getAction('conn-zhizao-verify-account');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.autoDecision).toBe(true);
  });

  it('低置信外部数据 auto_weak 边（confirm 信号 + relation_confidence 落 meta）', () => {
    seedConnectorActions();
    const a = getAction('conn-attio-enrich-account');
    expect(a.owner).toBe('connector-attio');
    expect(a.confirm).toBeTruthy();   // 低置信 → 需人 review（confirm 信号）
    // handler 元信息声明 auto_weak 语义：外部源 → sourcedFrom 边，relation_confidence 落边 meta
    expect(a.autoWeakEdge).toBe(true);
    expect(a.weakPredicate).toBe('sourcedFrom');
  });
});