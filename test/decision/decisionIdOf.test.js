// test/decision/decisionIdOf.test.js
// 目的：把「决策凭证读取」钉在**唯一**路径上（`autonomyEngine.decisionIdOf`），防 2026-09-16 发现的
//   系统性缺陷复发。该缺陷的真实形状：库内曾有 **11 处**调用方按**顶层** `result.decision_id` 读取，
//   而引擎返回的形状是 `{ mode, decision, confidence, … }` —— 凭证在 **`result.decision.decision_id`**。
//   于是恒得 `undefined`，造成两类后果：
//     ① 配置写 `decision_id` 恒 NULL —— 决策确实铸了却与配置行断链（第 0 闸「有决策、无留痕」）；
//     ② L2/L3 同步写路径被判「无决策」→ **结构性 fail-closed**（且被 `.catch(() => null)` 掩盖成"没配置"）。
//   唯一正确读法此前只存在于 `src/action/executor.js:70`。
// 三层断言：① 形状（纯、零 IO）② 真引擎（真库，锁定引擎真实形状）③ 收敛守卫（静态，防新调用点再犯）。
// 溯源：Q3 计划遗留 P-4 的姊妹发现；现场由 `scripts/seed-integration-sim.mjs` 实跑暴露
//   （`crm.decision` 已新增行，但 `sync_cursor.decision_id` 仍为 null → 写路径报 decision_required）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { requireDecision, decisionIdOf } from '../../src/decision/autonomyEngine.js';

describe('decisionIdOf · 凭证读取唯一入口（形状）', () => {
  it('规范形状（嵌套 decision）→ 返回 id', () => {
    expect(decisionIdOf({ mode: 'autonomous', decision: { decision_id: 'd-1' } })).toBe('d-1');
    expect(decisionIdOf({ mode: 'escalated', decision: { decision_id: 'd-2' }, tier: 'HIGH' })).toBe('d-2');
  });

  it('顶层同义键**不入账**（锁定「不得引入同义双键」这一取舍）', () => {
    // 若有人为了"顺手兼容"在引擎里补一个顶层 decision_id 别名，本断言会连同上面的实现注释一起失效——
    //   这正是刻意留下的绊线：同义双键会让"哪个是事实源"重新变得含糊。
    expect(decisionIdOf({ decision_id: 'd-1' })).toBe(null);
  });

  it('空值 / 缺字段 → null（不抛、不返回半成品）', () => {
    expect(decisionIdOf(null)).toBe(null);
    expect(decisionIdOf(undefined)).toBe(null);
    expect(decisionIdOf({})).toBe(null);
    expect(decisionIdOf({ decision: {} })).toBe(null);
    expect(decisionIdOf({ decision: { decision_id: null } })).toBe(null);
  });
});

describe('decisionIdOf · 真引擎形状（真库）', () => {
  it('真 requireDecision 的凭证只在 decision.decision_id，且 decisionIdOf 取得到', async () => {
    const r = await requireDecision('PARTICLE_UPDATE', { action: 'data-particle-update' }, [], { actor_id: 'alice' });
    // ⚠ 本断言若变红 = 引擎改了返回形状 → 全部调用点须同步复核（这是"形状变更的哨兵"）
    expect(r.decision_id, '引擎顶层不应有 decision_id（否则 11 处旧读法会被"修好"，掩盖收敛缺失）').toBeUndefined();
    expect(decisionIdOf(r), 'PARTICLE_UPDATE 场景必须能 mint 出 decision_id').toBeTruthy();
  });
});

describe('收敛守卫 · 生产调用点须走 decisionIdOf', () => {
  // 2026-09-16 修复覆盖的全部调用点（2 个 router + 1 个 llm router + 1 个命名账号 router + 6 个 portal 模块 + 集成轮询）
  const SITES = [
    'src/http/configRouter.js',
    'src/http/connectorRouter.js',
    'src/http/llmConfigRouter.js',
    'src/http/namedAccountAssignRouter.js',
    'src/portal/alertRuleConfig.js',
    'src/portal/approvalFlow.js',
    'src/portal/businessTier.js',
    'src/portal/mcpIdentity.js',
    'src/portal/rbacMatrix.js',
    'src/portal/skillRegistry.js',
    'src/scheduler/timers.js',
  ];
  const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

  it('全部调用点均已接入 decisionIdOf', () => {
    const missing = SITES.filter((f) => !read(f).includes('decisionIdOf'));
    expect(missing, `未接入 decisionIdOf 的调用点：${missing.join(', ')}`).toEqual([]);
  });

  it('不存在「把结果对象当凭证读顶层」的写法（含正向对照，防恒真）', () => {
    const BAD = /return\s*\{[^}]*:\s*r\??\.decision_id/;
    const hits = SITES.filter((f) => BAD.test(read(f)));
    expect(hits, `仍按顶层读取的调用点：${hits.join(', ')}`).toEqual([]);
    // 正向对照：该正则必须能命中"修复前的真实写法"，否则本守卫是恒真的（无鉴别力）
    expect(BAD.test('      return { decisionId: r.decision_id || null, ok: !!r.decision_id };')).toBe(true);
    expect(BAD.test('          return { decisionId: r?.decision_id || null };')).toBe(true);
  });
});
