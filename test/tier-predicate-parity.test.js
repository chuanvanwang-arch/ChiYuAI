// test/tier-predicate-parity.test.js
// A4（2026-09-16）一致性守卫：业务分级"是否生效"的判定谓词出现在多个读取点，
//   它们分属 decision / context 两层（一处是导出常量、一处是内联 SQL），
//   又分属两种语言（SQL 字符串 vs JS 派生函数），因此**无法共享实现，只能守卫**。
//
// 为什么必须守卫：漏改一处的后果**不是报错，而是静默分歧**——
//   典型是 L4 上下文仍把已撤回的分级注入给模型（"该项目是 LEAD 低风险"），
//   而 computeBusinessTier 已按"无此规则"回退 scenario.default_tier（可能 HIGH）。
//   于是模型基于作废依据给理由、系统按新依据拦截，事后无人能解释这次决策。
//   （范式同 test/browserLoadable.test.js：源码级断言，零运行成本，改漏立刻红。）
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// 判定面谓词（两种表述视为等价：SQL 谓词片段 / 其标准写法）
const ACTIVE_PREDICATE = /revoked_at IS NULL AND \(expires_at IS NULL OR expires_at > now\(\)\)/;

test('判定面谓词在 decisionRepo（判定）与 assembler（L4 上下文）两处同时存在', () => {
  expect(read('../src/decision/decisionRepo.js'), 'decisionRepo 的 ACTIVE_TIER_WHERE 缺失').toMatch(ACTIVE_PREDICATE);
  expect(read('../src/context/assembler.js'), 'assembler 的 L4 分级读取缺少同一谓词').toMatch(ACTIVE_PREDICATE);
});

test('配置面刻意不过滤撤回行（审计证据必须可见），但必须带出状态', () => {
  const txt = read('../src/http/controlledConfigPages.js');
  // 必须带出状态：否则页面把已撤回的规则照旧显示成分级 = 配置面与执行面不一致（E1 类假绿）
  expect(txt, 'business-tier 受控页未带出 tier_status').toContain('tier_status');
  // 且**不得**过滤：撤回行从配置面消失会让"撤回"变成不可核查的操作
  expect(txt, '受控页不应过滤撤回行（那是审计证据，过滤掉就查不到了）').not.toMatch(ACTIVE_PREDICATE);
});

test('渲染层状态派生与 SQL 谓词语义一致（revoked 优先于 expired）', async () => {
  const { tierStatus } = await import('../src/portal/businessTierRender.js');
  const past = '2020-01-01T00:00:00Z';
  // SQL 谓词放行的行（revoked_at IS NULL 且未过期）↔ tierStatus 必须为 active
  expect(tierStatus({})).toBe('active');
  expect(tierStatus({ expires_at: '2099-01-01T00:00:00Z' })).toBe('active');
  // SQL 谓词拦下的两种情形 ↔ tierStatus 必须为 revoked / expired
  expect(tierStatus({ revoked_at: '2026-09-01T00:00:00Z' })).toBe('revoked');
  expect(tierStatus({ expires_at: past })).toBe('expired');
});
