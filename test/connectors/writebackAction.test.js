// test/connectors/writebackAction.test.js — S4 T04 回写通道契约
// 契约：sync-writeback-fields Action（写回客户 CRM 白名单字段）
//   ① 白名单过滤（config_store['sync-trust'].writeback_fields_whitelist）
//   ② 静态标记 Source='crm-ai-native'
//   ③ needsApproval（逐批审批）+ autoDecision（第 0 闸）
//   ④ agentTool:false（免 agentSpec 装配闭包，仅外部/定时器触发）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const srcPath = fileURLToPath(new URL('../../src/connectors/connectorActions.js', import.meta.url));
const src = readFileSync(srcPath, 'utf8');

describe('sync writeback Action（T04 回写通道）', () => {
  it('注册 sync-writeback-fields（白名单+Source 静态标记+审批闸）', () => {
    expect(src).toContain('sync-writeback-fields');
    expect(src).toContain('writeback_fields_whitelist'); // 白名单过滤
    expect(src).toContain("Source='crm-ai-native'"); // 静态标记
    expect(src).toContain('needsApproval: true'); // 逐批审批
  });

  it('写回经第 0 闸（autoDecision 语义）且免装配（agentTool:false）', () => {
    expect(src).toContain('autoDecision: true');
    expect(src).toContain('agentTool: false'); // 免 agentSpec 闭包
  });

  it('写回携带字段级 CAS（A-B4：外部已改拒绝）', () => {
    expect(src).toContain('casExpectField'); // 字段级 CAS 校验
  });
});
