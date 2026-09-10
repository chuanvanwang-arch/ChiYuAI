// test/memory/memory-writeback.test.js — 客户记忆写回（C1/C2/C4/C7）验收
// 全部纯函数用例（无 PG 依赖）：租户寻址 / 锚点解析 / 投影 / 捕获白名单。
// 背景见 docs/2026-09-10-customer-memory-writeback-design.md 与
//       docs/2026-09-10-memory-system-governance-design.md
import { describe, test, expect, afterEach } from 'vitest';
import {
  resolveTenantId, resolveEntityAnchor, mapEntityType,
  projectDecisionMemory, stripCredentials,
} from '../../src/memory/memoryLog.js';
import { isCapturable, setCaptureDomains, getCaptureDomains } from '../../src/memory/capture.js';
import { diffFields, shouldPrecipitate, DEFAULT_RULES } from '../../src/memory/precipitate.js';

describe('C1 记忆写入租户寻址', () => {
  test('① 显式租户优先', () => {
    expect(resolveTenantId({ tenantId: 'acme-auto', payload: { tenant_id: 'acme-chem' } }))
      .toEqual({ tenant_id: 'acme-auto', source: 'explicit' });
  });
  test('② payload.tenant_id 兜底（零成本救回存量告警记忆）', () => {
    expect(resolveTenantId({ payload: { tenant_id: 'acme-training' } }))
      .toEqual({ tenant_id: 'acme-training', source: 'payload' });
  });
  test('③ 通配 * 与缺失同：回退 system 且标 fallback（供 emit trace 观测）', () => {
    expect(resolveTenantId({ tenantId: '*' }).source).toBe('fallback');
    expect(resolveTenantId({}).tenant_id).toBe('system');
  });
});

describe('C2 客户锚点解析（客户优先）', () => {
  test('① 显式锚点最高优先级', () => {
    expect(resolveEntityAnchor({ entityId: 'ACC-1', entityType: 'ACCOUNT', payload: { account_id: 'ACC-2' } }))
      .toMatchObject({ entity_id: 'ACC-1', entity_type: 'ACCOUNT', source: 'explicit' });
  });
  test('② CRM_DEAL 上溯 account_id（跨商机累积价值，不锚商机）', () => {
    expect(resolveEntityAnchor({ payload: { account_id: 'ACC-9', deal_id: 'DL-1' }, type: 'CRM_DEAL' }))
      .toMatchObject({ entity_id: 'ACC-9', entity_type: 'ACCOUNT' });
  });
  test('③ 无客户归属时退锚商机', () => {
    expect(resolveEntityAnchor({ payload: { deal_id: 'DL-1' } }))
      .toMatchObject({ entity_id: 'DL-1', entity_type: 'DEAL' });
  });
  test('④ 无归属信息诚实留 NULL（禁臆造锚点）', () => {
    expect(resolveEntityAnchor({ payload: { foo: 1 } }))
      .toEqual({ entity_id: null, entity_type: null, source: 'none' });
  });
  test('⑤ 粒子类型归一化', () => {
    expect(mapEntityType('CRM_ACCOUNT')).toBe('ACCOUNT');
    expect(mapEntityType('CRM_DEAL')).toBe('DEAL');
    expect(mapEntityType('CRM_CONTACT')).toBe('CONTACT');
    expect(mapEntityType(null)).toBe(null);
  });
});

describe('C7 决策记忆四段式投影', () => {
  const base = {
    decision_id: 'D-1', scenario_id: 'DEAL_STAGE_ADVANCE', disposition: 'ESCALATE',
    business_tier: 'HIGH', decider_type: 'HUMAN',
    rationale: '升级人工：置信度 0.300<阈值 0.450，参考先例 0 条',
    trigger_context: { query: '客户要求 8 折后再降 10%', amount: 800000, stage: 'S4' },
    involved_entities: [{ type: 'CRM_DEAL', id: 'DL-1', name: 'XX制造产线' }],
    conditions_evaluated: [{ key: 'budget', met: true }, { key: 'authority', met: false }],
  };

  test('① summary 承载业务主语（不再是无语义的引擎模板句）', () => {
    const p = projectDecisionMemory(base);
    expect(p.summary).toContain('客户要求 8 折后再降 10%');
    expect(p.summary).toContain('DEAL_STAGE_ADVANCE');
  });
  test('② 锚点取客户（involved_entities 含 CRM_DEAL 时仍上溯 ACCOUNT 语义）', () => {
    const p = projectDecisionMemory({ ...base, entity_id: 'ACC-1', entity_type: 'ACCOUNT' });
    expect(p.entity_id).toBe('ACC-1');
    expect(p.entities[0]).toMatchObject({ type: 'DEAL', id: 'DL-1' });
  });
  test('③ evidence / gaps 从条件与触发上下文派生', () => {
    const p = projectDecisionMemory(base);
    expect(p.evidence.join('|')).toContain('budget');
    expect(p.gaps.join('|')).toContain('authority');
    expect(p.evidence.join('|')).toContain('amount=800000');
  });
  test('④ 只加字段不删字段：既有 5 字段消费方零回归', () => {
    const p = projectDecisionMemory(base);
    expect(p.scenario_id).toBe('DEAL_STAGE_ADVANCE');
    expect(p.disposition).toBe('ESCALATE');
    expect(p.decider_type).toBe('HUMAN');
    expect(p.business_tier).toBe('HIGH');
    expect(p.rationale).toBe(base.rationale);
  });
  test('⑤ 无业务摘要时不臆造（退回 rationale，再无则显式标注）', () => {
    const p = projectDecisionMemory({ ...base, trigger_context: {} });
    expect(p.summary).toContain('升级人工');
    const p2 = projectDecisionMemory({ ...base, trigger_context: {}, rationale: '' });
    expect(p2.summary).toContain('（无业务摘要）');
  });
  test('⑥ 超 4 KB 截断并标记 truncated', () => {
    const huge = {
      ...base,
      involved_entities: Array.from({ length: 10 }, (_, i) => ({ type: 'CRM_DEAL', id: `DL-${i}`, name: 'X'.repeat(500) })),
    };
    const p = projectDecisionMemory(huge);
    expect(p.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(p), 'utf8')).toBeLessThan(4096 + 512);
  });
  test('⑦ 凭证类键脱敏（记忆表绝不落明文凭据）', () => {
    const red = stripCredentials({ api_key: 'sk-xxx', nested: { password: 'p', keep: 1 }, list: [{ token: 't' }] });
    expect(red.api_key).toBe('[redacted]');
    expect(red.nested.password).toBe('[redacted]');
    expect(red.nested.keep).toBe(1);
    expect(red.list[0].token).toBe('[redacted]');
  });
  test('⑧ injector.memoryText 契约：必须含 summary 键（否则读到也吐空串）', () => {
    // src/context/injector.js#memoryText 只认 payload.text|summary|note|content
    const p = projectDecisionMemory(base);
    expect(typeof p.summary).toBe('string');
    expect(p.summary.length).toBeGreaterThan(0);
  });
});

describe('C4 捕获白名单（切断 trace 自激）', () => {
  afterEach(() => { setCaptureDomains(getCaptureDomains()); });

  test('① 系统域恒拒：trace / metering / decision / memory', () => {
    for (const d of ['trace', 'metering', 'decision', 'memory']) {
      expect(isCapturable(d), `${d} 应被拒`).toBe(false);
    }
  });
  test('② 业务域放行：crm / approval / task / particle / alert', () => {
    for (const d of ['crm', 'approval', 'task', 'particle', 'alert']) {
      expect(isCapturable(d), `${d} 应放行`).toBe(true);
    }
  });
  test('③ 缺省域 event 不在白名单 → 拒（原 on("*") 会把无名域全收）', () => {
    expect(isCapturable(undefined)).toBe(false);
    expect(isCapturable('event')).toBe(false);
  });
  test('④ 配置覆盖不得绕过硬闸', () => {
    setCaptureDomains(['trace', 'decision', 'crm']);
    expect(isCapturable('trace')).toBe(false);
    expect(isCapturable('decision')).toBe(false);
    expect(isCapturable('crm')).toBe(true);
  });
});

describe('C3 粒子写入自动沉淀（防雪崩）', () => {
  test('① 同值提交 0 条变更（防雪崩·字段闸）', () => {
    expect(diffFields({ stage: 'S3' }, { stage: 'S3' }, ['stage'])).toEqual([]);
  });
  test('② 清空不沉淀（删值非事实推进）', () => {
    expect(diffFields({ stage: 'S3' }, { stage: null }, ['stage'])).toEqual([]);
  });
  test('③ 真变更产出 from/to', () => {
    expect(diffFields({ stage: 'S3', amount: 100 }, { stage: 'S4', amount: 100 }, ['stage', 'amount']))
      .toEqual([{ field: 'stage', from: 'S3', to: 'S4' }]);
  });
  test('④ 未配置类型不沉淀（禁硬编码业务字段）', () => {
    const r = shouldPrecipitate({ type: 'CRM_UNKNOWN', before: { x: 1 }, after: { x: 2 }, config: DEFAULT_RULES });
    expect(r.ok).toBe(false); expect(r.reason).toBe('no-rule');
  });
  test('⑤ 命中规则且真变 → 带 topic 与 ttlDays', () => {
    const r = shouldPrecipitate({ type: 'CRM_DEAL', before: { stage: 'S3' }, after: { stage: 'S4' }, config: DEFAULT_RULES });
    expect(r.ok).toBe(true);
    expect(r.topic).toBe('deal:field-change');
    expect(r.ttlDays).toBe(180);
    expect(r.changes[0]).toMatchObject({ field: 'stage', from: 'S3', to: 'S4' });
  });
  test('⑥ 规则可由 config_store 覆盖（出厂缺省不是硬编码天花板）', () => {
    const cfg = { dedupeHours: 1, rules: [{ type: 'CRM_QUOTATION', fields: ['total'], topic: 'quote:field-change', ttlDays: 90 }] };
    const r = shouldPrecipitate({ type: 'CRM_QUOTATION', before: { total: 1 }, after: { total: 2 }, config: cfg });
    expect(r.ok).toBe(true); expect(r.topic).toBe('quote:field-change'); expect(r.ttlDays).toBe(90);
    // 覆盖后出厂缺省规则不再生效（配置即事实源）
    expect(shouldPrecipitate({ type: 'CRM_DEAL', before: { stage: 'S3' }, after: { stage: 'S4' }, config: cfg }).ok).toBe(false);
  });
  test('⑦ 空字段清单视为未配置（防"配了类型却全字段生效"的雪崩）', () => {
    const cfg = { rules: [{ type: 'CRM_DEAL', fields: [], topic: 'x' }] };
    expect(shouldPrecipitate({ type: 'CRM_DEAL', before: { a: 1 }, after: { a: 2 }, config: cfg }).reason).toBe('no-fields');
  });
});
