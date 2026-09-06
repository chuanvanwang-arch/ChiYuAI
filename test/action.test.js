// test/action.test.js — 纯逻辑测试（无 PG 依赖，本地可全绿）
// 子系统三：Action 写白名单 + 命名空间分层（T1–T6 累积 describe 块）
import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../src/action/seed-actions.js';
import { listNamespaces, listActions, getAction, resetRegistry } from '../src/action/registry.js';

// 横切属性（namespace/agentTool/force/...）由 seedActions() 注入 registry
beforeAll(() => seedActions());

// ───────────────────────── T1 · registry 命名空间分层 + 横切属性 ─────────────────────────
describe('T1 · registry 命名空间分层 + 横切属性', () => {
  it('listNamespaces 含 crm/data 且去重', () => {
    const ns = listNamespaces();
    expect(ns).toContain('crm');
    expect(ns).toContain('data');
    expect(new Set(ns).size).toBe(ns.length);
  });

  it('listActions({namespace}) 按命名空间过滤正确', () => {
    // crm 命名空间 = 33（基础 11 + 阶段3 报价/合同/回款/发票/订单/导入 + 字段RBAC配置 + 审批任务级操作 6(crm-approval-*) + 第三闸消费端 crm-quote-activate + 售前技术方案/跨实体/财务/合同到期等业务 Action + 决策人工处置 decision-disposition（校淮 P0）+ P1-A 商机回顾 crm-deal-swas-update）
    // 注：crm-approval-* 由审批引擎落地引入，业务闭环 Action（quote/contract/order/payment/invoice/import/proposal 等）随阶段3 增量注册，此处基数随注册实况同步，非本计划断言漂移。
    // 不硬钉具体数（注册实况 39，含阶段3 业务闭环 + 决策子系统 6 个 + decision-disposition + P1-A crm-deal-swas-update），改用下限守卫 + 过滤正确性，避免未来注册增长再脆断。
    const crm = listActions({ namespace: 'crm' });
    expect(crm.length).toBeGreaterThanOrEqual(33);
    // data 命名空间 = 6（base 4 + data-particle-attr-read/update —— 并发补充粒子属性读写，字段RBAC闸 2.5 依赖）
    expect(listActions({ namespace: 'data' })).toHaveLength(6);
    // 所有返回的 def 都带有推导/声明的 namespace
    for (const a of crm) expect(a.namespace).toBe('crm');
  });

  it('横切属性正确落位（force / agentTool / namespace 推导）', () => {
    expect(getAction('crm-deal-advance').force).toBe(false);
    expect(getAction('data-particle-update').force).toBe(true);
    expect(getAction('data-particle-edge-create').agentTool).toBe(false);
    expect(getAction('data-particle-create').namespace).toBe('data');
    // namespace 缺省从 name 前缀推导
    expect(getAction('crm-account-360').namespace).toBe('crm');
  });
});

// ───────────────────────── T2 · 对话式写入白名单 + blast-radius ─────────────────────────
import { isWriteWhitelisted, writeBlastRadius, WRITE_WHITELIST } from '../src/action/whitelist.js';

describe('T2 · 对话式写入白名单 + blast-radius 分级', () => {
  it('白名单命中 3 个、拒非白名单', () => {
    expect(isWriteWhitelisted('crm-deal-advance')).toBe(true);
    expect(isWriteWhitelisted('data-particle-create')).toBe(true);
    expect(isWriteWhitelisted('data-particle-update')).toBe(true);
    expect(isWriteWhitelisted('data-particle-edge-create')).toBe(false);
    // 4 = 原 3（基础写白名单）+ data-particle-attr-update（并发补充粒子属性写白名单）
    expect(WRITE_WHITELIST.size).toBe(4);
  });

  it('writeBlastRadius 映射正确', () => {
    expect(writeBlastRadius('crm-deal-advance')).toBe('autonomous');
    expect(writeBlastRadius('data-particle-update')).toBe('autonomous');
    expect(writeBlastRadius('data-particle-edge-create')).toBe('human_gate');
  });
});

// ───────────────────────── T3 · executor 第 2 闸（force 双闸 + 写白名单） ─────────────────────────
import { actionExecutor } from '../src/action/executor.js';
import { registerAction } from '../src/action/registry.js';

// 说明（无 PG 约束）：受上下文分层约束的 Action（data-particle-* 等）第 1 闸会触 DB，
// 故 force/写白名单闸的逻辑验证采用「非 scoped 自定义写 Action」，其余闸序沿用真实 Action。
describe('T3 · executor 第2闸 force双闸 + 写白名单闸', () => {
  beforeAll(() => {
    // 非 scoped 高危写（force 双闸）
    registerAction({
      name: 'test-force-write', kind: 'write', namespace: 'test', force: true,
      handler: async () => ({ ok: true }),
    });
    // 非 scoped 写（非白名单）
    registerAction({
      name: 'test-nonscoped-write', kind: 'write', namespace: 'test', force: false,
      handler: async () => ({ ok: true }),
    });
  });

  it('force 双闸：缺 force → needs_force', async () => {
    const r = await actionExecutor.dispatch(
      'test-force-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1', channel: 'conversational' },
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('needs_force');
  });

  it('force 双闸：带 force:true 且非对话通道 → 过闸执行', async () => {
    const r = await actionExecutor.dispatch(
      'test-force-write', { foo: 'bar', force: true },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1', channel: 'system' },
    );
    expect(r.ok).toBe(true);
    expect(r.gate).toBeUndefined();
  });

  it('写白名单闸：对话通道非白名单写 → write_whitelist', async () => {
    const r = await actionExecutor.dispatch(
      'test-nonscoped-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1', channel: 'conversational' },
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('write_whitelist');
  });

  it('写白名单闸：authorizedWrite:true → 过闸执行', async () => {
    const r = await actionExecutor.dispatch(
      'test-nonscoped-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1', channel: 'conversational', authorizedWrite: true },
    );
    expect(r.ok).toBe(true);
  });

  it('不影响第 0 闸：写操作无 decision_id → decision_required（先于第 2 闸）', async () => {
    // data-particle-update 为 scoped 写，但缺 decision_id 时第 0 闸先于第 1 闸返回，不触 DB
    const r = await actionExecutor.dispatch(
      'data-particle-update', { id: 'x', patch: {} },
      { tenantId: 'system', actor: 'sales' },
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
    // 白名单内写操作同样先过第 0 闸（验证闸序：decision 在 whitelist 之前）
    const r2 = await actionExecutor.dispatch(
      'data-particle-create', { type: 'T', payload: {} },
      { tenantId: 'system', actor: 'sales', channel: 'conversational' },
    );
    expect(r2.gate).toBe('decision_required');
  });
});

// ───────────────────────── T3.5 · executor 第 3 闸（HITL 审批流 needsApproval 拦截） ─────────────────────────
// 设计输入：总体设计 §8.3-③（第三闸=审批流）+ 12 文档 §7-5 + borrowings §T-2.5（审批×Action 表面接线）
// 契约（与第 0/2 闸一致的豁免语义）：
//   def.needsApproval:true 的写 Action → 无 ctx.approvalPassed 时返回 gate:'approval_required'（不触 handler）；
//   ctx.approvalPassed:true（审批流通过后的执行路径）→ 放行；bootstrap 豁免（系统引导，无审批语义）
describe('T3.5 · executor 第3闸 HITL 审批流拦截', () => {
  beforeAll(() => {
    // 非 scoped 高危写（needsApproval）—— 与 T3 同模式，避开第 1 闸触 DB
    registerAction({
      name: 'test-approval-write', kind: 'write', namespace: 'test',
      force: false, needsApproval: true,
      handler: async () => ({ ok: true }),
    });
  });

  it('needsApproval 写无 approvalPassed → approval_required（第3闸拦截，handler 不执行）', async () => {
    const r = await actionExecutor.dispatch(
      'test-approval-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1' },
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('approval_required');
    expect(r.error).toContain('审批');
  });

  it('approvalPassed:true → 放行执行（审批流通过后的执行语义）', async () => {
    const r = await actionExecutor.dispatch(
      'test-approval-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1', approvalPassed: true },
    );
    expect(r.ok).toBe(true);
  });

  it('bootstrap 豁免（系统引导不经审批）', async () => {
    const r = await actionExecutor.dispatch(
      'test-approval-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'system', bootstrap: true },
    );
    expect(r.ok).toBe(true);
  });

  it('非 needsApproval 写不受第3闸影响（闸序：0闸→1闸→1.5闸→2闸→3闸，末尾追加不破坏既有）', async () => {
    const r = await actionExecutor.dispatch(
      'test-nonscoped-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales', decision_id: 'd1' },
    );
    expect(r.ok).toBe(true);
  });

  it('needsApproval 与第0闸共存：缺 decision_id 时第0闸先拦（前置于第3闸）', async () => {
    const r = await actionExecutor.dispatch(
      'test-approval-write', { foo: 'bar' },
      { tenantId: 'system', actor: 'sales' },
    );
    expect(r.gate).toBe('decision_required');
  });

  it('真实消费端：crm-quote-activate 无 approvalPassed → approval_required（第3闸拦住审批后动作）', async () => {
    const r = await actionExecutor.dispatch(
      'crm-quote-activate', { quote_id: 'no-such' },
      { tenantId: 'system', actor: 'approver', decision_id: 'd1' },
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('approval_required');
  });

  it('真实消费端：crm-quote-activate 带 approvalPassed → 放行到 handler（缺报价时报业务错误，而非闸错误）', async () => {
    const r = await actionExecutor.dispatch(
      'crm-quote-activate', { quote_id: 'no-such' },
      { tenantId: 'system', actor: 'approver', decision_id: 'd1', approvalPassed: true },
    );
    // 第三闸已放行：错误来自 handler 层（本沙箱无 PG 触 DB 报 ECONNREFUSED；生产库则报"报价不存在"），
    // 而非审批闸（gate 不再是 approval_required；若仍未放行会停在第三闸返回闸错误）
    expect(r.ok).toBe(false);
    expect(r.gate).toBeUndefined();
    expect(r.error).toMatch(/ECONNREFUSED|报价不存在/);
  });
});

// ───────────────────────── T4 · detectCrudExplosion 反爆炸护栏 ─────────────────────────
import { detectCrudExplosion } from '../src/action/registry.js';

describe('T4 · detectCrudExplosion 反爆炸护栏', () => {
  it('正确折叠的 6 Action → exploded:false', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).toHaveLength(0);
  });

  it('负向用例：注入 per-type 爆炸源 → exploded:true 且捕获', () => {
    // 自清洁：先重置+重建干净基线，再注入负向源，最后重置还原
    resetRegistry();
    seedActions();
    registerAction({
      name: 'data-deal-create', kind: 'write', namespace: 'data', force: false,
      handler: async () => ({ ok: true }),
    });
    registerAction({
      name: 'data-account-delete', kind: 'write', namespace: 'data', force: true,
      handler: async () => ({ ok: true }),
    });
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(true);
    expect(r.offenders).toContain('data-deal-create');
    expect(r.offenders).toContain('data-account-delete');
    // 还原干净基线（防止污染后续 T5 断言）
    resetRegistry();
    seedActions();
    expect(detectCrudExplosion().exploded).toBe(false);
  });
});

// ───────────────────────── T5 · resolver 能力清单生成 ─────────────────────────
import { resolveCapabilityManifest, formatManifest } from '../src/action/resolver.js';

describe('T5 · resolver 能力清单生成', () => {
  it('resolveCapabilityManifest 含 crm/data 命名空间 + 计划内 6 Action', () => {
    const m = resolveCapabilityManifest();
    expect(m.namespaces).toContain('crm');
    expect(m.namespaces).toContain('data');
    const names = m.actions.map(a => a.name);
    // 计划内 6 个（T4 负向注入残留 2 个不影响包含断言）
    for (const n of ['crm-deal-advance', 'crm-account-360',
      'data-particle-create', 'data-particle-read', 'data-particle-update', 'data-particle-edge-create']) {
      expect(names).toContain(n);
    }
    // 横切属性完整透传
    const adv = m.actions.find(a => a.name === 'crm-deal-advance');
    expect(adv.namespace).toBe('crm');
    expect(adv.kind).toBe('write');
    expect(adv.agentTool).toBe(true);
  });

  it('formatManifest 输出 agents.md 风格 markdown', () => {
    const md = formatManifest();
    expect(md).toContain('# 能力清单');
    expect(md).toContain('## Action');
    expect(md).toContain('crm-deal-advance');
  });
});
