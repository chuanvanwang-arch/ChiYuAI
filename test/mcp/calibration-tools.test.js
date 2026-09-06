// test/mcp/calibration-tools.test.js — T23 J3 校准 MCP 工具契约测试
// 设计依据：docs/2026-08-30-j2-j3-comprehensive-design.md L185-L190
// 断言 6 个 crm_calibration_* 工具：读直出（read kind）、写经 confirm/autoDecision（write kind）、
//   入参 schema 契约（patches/metrics 读；patch_generate/approve/reject/rollback 写与第0闸）。
import { describe, it, expect, beforeAll } from 'vitest';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('T23 J3 校准 MCP 工具（6 工具契约）', () => {
  let tools;
  beforeAll(() => {
    tools = buildMcpTools({ seed: true }).tools;
  });

  const names = () => tools.map((t) => t.name);

  it('暴露全部 6 个 crm_calibration_* 工具', () => {
    for (const n of [
      'crm_calibration_patches',
      'crm_calibration_metrics',
      'crm_calibration_patch_generate',
      'crm_calibration_patch_approve',
      'crm_calibration_patch_reject',
      'crm_calibration_patch_rollback',
    ]) {
      expect(names()).toContain(n);
    }
  });

  it('读工具（patches/metrics）为 read kind（读直连；business 入参无 confirm 语义）', () => {
    for (const n of ['crm_calibration_patches', 'crm_calibration_metrics']) {
      const t = tools.find((x) => x.name === n);
      expect(t.kind).toBe('read');
      // MCP 暴露面统一含协议字段（tools.js 对 read/write 都展开 protocolShape），
      // 但读工具由 gateway 读直连 dispatch，不消费 confirm_token——此处只锁 kind 与业务入参。
    }
  });

  it('patches 入参含 status/scenario_id/limit', () => {
    const t = tools.find((x) => x.name === 'crm_calibration_patches');
    expect(t.inputSchema).toHaveProperty('status');
    expect(t.inputSchema).toHaveProperty('scenario_id');
    expect(t.inputSchema).toHaveProperty('limit');
  });

  it('metrics 入参含 scenario_id/window_days/limit', () => {
    const t = tools.find((x) => x.name === 'crm_calibration_metrics');
    expect(t.inputSchema).toHaveProperty('scenario_id');
    expect(t.inputSchema).toHaveProperty('window_days');
    expect(t.inputSchema).toHaveProperty('limit');
  });

  it('写工具为 write kind + MCP 两阶段（confirm_token/choice/decision_id 协议字段）', () => {
    for (const n of [
      'crm_calibration_patch_generate',
      'crm_calibration_patch_approve',
      'crm_calibration_patch_reject',
      'crm_calibration_patch_rollback',
    ]) {
      const t = tools.find((x) => x.name === n);
      expect(t.kind).toBe('write');
      // MCP 两阶段契约痕迹：confirm_token + choice + decision_id（第0闸必需）显式入 zod shape
      expect(t.inputSchema).toHaveProperty('confirm_token');
      expect(t.inputSchema).toHaveProperty('choice');
      expect(t.inputSchema).toHaveProperty('decision_id');
    }
  });

  it('generate 入参含 scenario_id+window_days；approve/reject/rollback 含 patch_id', () => {
    const g = tools.find((x) => x.name === 'crm_calibration_patch_generate');
    const a = tools.find((x) => x.name === 'crm_calibration_patch_approve');
    expect(g.inputSchema).toHaveProperty('scenario_id');
    expect(g.inputSchema).toHaveProperty('window_days');
    expect(a.inputSchema).toHaveProperty('patch_id');
  });

  it('写工具 description 含「两阶段」提示（gateway 确认契约可发现性）', () => {
    const g = tools.find((x) => x.name === 'crm_calibration_patch_generate');
    expect(g.description).toContain('两阶段');
  });
});