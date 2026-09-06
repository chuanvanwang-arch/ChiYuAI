// test/stage-config.test.js — DEAL 阶段-赢率配置 + 回退特权（B5）
// 命名纪律：业务阶段 P1-P6 → S1-S6（2026-08-26 术语重命名；S7/S8=lost/disqualified 保留）
//  S1=lead S2=opportunity S3=quoted S4=contracted S5=ordered S6=paid S7=lost S8=disqualified
// 纯逻辑本地可跑（无 PG 依赖）；crm-deal-rollback 的 RBAC 闸由 executor 第 1.5 闸拦截（admin 白名单）
import { describe, it, expect } from 'vitest';
import { DEFAULT_STAGE_CONFIG, winRate, canRollback, checkRollback } from '../src/sales/stageConfig.js';

describe('阶段赢率 winRate（B5：每阶段可配赢率预测量）', () => {
  it('默认表：S1(lead) 10% → S6(paid) 100%', () => {
    expect(winRate('S1')).toBe(0.10);
    expect(winRate('S2')).toBe(0.40);
    expect(winRate('S3')).toBe(0.60);
    expect(winRate('S4')).toBe(0.85);
    expect(winRate('S5')).toBe(0.95);
    expect(winRate('S6')).toBe(1.00);
  });
  it('S7(lost)/S8(disqualified) 赢率 0', () => {
    expect(winRate('S7')).toBe(0);
    expect(winRate('S8')).toBe(0);
  });
  it('阶段配置覆盖：payload.stage_config 优先', () => {
    const custom = [{ stage: 'S2', win_rate: 0.55, allow_back: false }];
    expect(winRate('S2', custom)).toBe(0.55);
  });
  it('未命中阶段 → null', () => {
    expect(winRate('unknown_stage')).toBeNull();
  });
});

describe('回退权限 canRollback（B5：allow_back 配置判定）', () => {
  it('默认全阶段不允许回退（防作弊）', () => {
    for (const s of DEFAULT_STAGE_CONFIG) expect(canRollback(s.stage)).toBe(false);
  });
  it('allow_back=true 允许回退', () => {
    const custom = [{ stage: 'S2', win_rate: 0.4, allow_back: true }];
    expect(canRollback('S2', custom)).toBe(true);
  });
});

describe('回退合法性 checkRollback（特权语义）', () => {
  it('目标不在前阶段 → 拒绝', () => {
    expect(checkRollback('S2', 'S3').ok).toBe(false); // S3 是后续阶段
  });
  it('配置不允许回退 → 拒绝（即使目标为前阶段）', () => {
    expect(checkRollback('S2', 'S1').ok).toBe(false); // 默认 allow_back=false
  });
  it('显式 allowBack（特权绕行）→ 允许', () => {
    expect(checkRollback('S2', 'S1', { allowBack: true }).ok).toBe(true);
  });
  it('配置 allow_back=true → 允许', () => {
    expect(checkRollback('S2', 'S1', { stageConfig: [{ stage: 'S2', win_rate: 0.4, allow_back: true }] }).ok).toBe(true);
  });
  it('未知阶段 → 拒绝并载明', () => {
    const r = checkRollback('nope', 'S1', { allowBack: true });
    expect(r.ok).toBe(false);
  });
});