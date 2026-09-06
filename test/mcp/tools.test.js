// 回归测试：jsonSchemaToZod 必须正确处理「扁平 seed schema」（值=类型名字符串），
// 而非把所有字段降级为 z.string()。修复前 number/object/array 字段被 SDK 剥离，
// 导致 MCP 侧 payload/rows 校验错位（2026-09-03）。
import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZod, buildMcpTools } from '../../src/mcp/tools.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { listActions } from '../../src/action/registry.js';

// 复刻 buildMcpTools 的调用形态：扁平 map 包成 {type:'object', properties}
function fromFlat(flatSchema) {
  return z.object(jsonSchemaToZod({ type: 'object', properties: flatSchema }));
}

describe('jsonSchemaToZod — 扁平 seed schema 类型推断（回归）', () => {
  it('扁平 map 的 number/integer/boolean/object/array 正确推断，而非全 string', () => {
    const s = fromFlat({
      customer_id: 'string',
      amount: 'number',
      qty: 'integer',
      active: 'boolean',
      payload: 'object',
      rows: 'array',
    });

    // string 字段：数字应被拒、字符串应通过
    expect(s.safeParse({ customer_id: 123 }).success).toBe(false);
    expect(s.safeParse({ customer_id: 'abc' }).success).toBe(true);

    // number 字段（修复前被降级为 z.string()）
    expect(s.safeParse({ amount: 5 }).success).toBe(true);
    expect(s.safeParse({ amount: '5' }).success).toBe(false);

    // integer 字段
    expect(s.safeParse({ qty: 2 }).success).toBe(true);
    expect(s.safeParse({ qty: '2' }).success).toBe(false);

    // boolean 字段
    expect(s.safeParse({ active: true }).success).toBe(true);
    expect(s.safeParse({ active: 'yes' }).success).toBe(false);

    // object 字段（修复前被降级为 z.string()）
    expect(s.safeParse({ payload: { a: 1 } }).success).toBe(true);
    expect(s.safeParse({ payload: 'notobj' }).success).toBe(false);

    // array 字段（修复前被降级为 z.string()）
    expect(s.safeParse({ rows: [1, 2] }).success).toBe(true);
    expect(s.safeParse({ rows: 'notarr' }).success).toBe(false);
  });

  it('仍兼容标准 {type,properties} 对象形态', () => {
    const s = fromFlat({
      name: { type: 'string', description: 'x' },
      n: { type: 'number' },
    });
    expect(s.safeParse({ name: 'a', n: 1 }).success).toBe(true);
    expect(s.safeParse({ name: 1, n: 1 }).success).toBe(false); // name 拒数字
    expect(s.safeParse({ name: 'a', n: 'x' }).success).toBe(false); // n 拒字符串
  });

  it('空/缺省 schema 不抛错且返回空 shape', () => {
    expect(() => jsonSchemaToZod()).not.toThrow();
    const empty = jsonSchemaToZod({});
    expect(Object.keys(empty)).toHaveLength(0);
  });
});

// 2026-09-03 方案 A（用户拍板）：MCP 暴露面按 lifecycle 收敛——隐藏 reserved 死表面
describe('buildMcpTools — 暴露面按 lifecycle 过滤（方案 A）', () => {
  it('lifecycle=reserved 的死表面不暴露给 MCP（注册表仍保留）', async () => {
    await seedActions();
    const { tools } = buildMcpTools({ seed: false });
    const exposed = new Set(tools.map((t) => t.name));
    const reserved = listActions().filter((a) => a.lifecycle === 'reserved').map((a) => a.name);
    expect(reserved.length).toBeGreaterThan(0); // 防御：确保确有 reserved 被过滤
    for (const r of reserved) {
      expect(exposed.has(r), `${r} 不应暴露给 MCP`).toBe(false);
    }
  });

  it('active 与 engine 仍暴露（含 P1 业务 action 与引擎型）', async () => {
    await seedActions();
    const { tools } = buildMcpTools({ seed: false });
    const exposed = new Set(tools.map((t) => t.name));
    for (const n of ['crm-deal-advance', 'crm-account-360', 'crm-approval-start', 'crm_decision_trace', 'agent-dispatch']) {
      expect(exposed.has(n), `${n} 应暴露`).toBe(true);
    }
  });

  it('暴露数明显少于全量注册（reserved 已被收敛）', async () => {
    await seedActions();
    const { tools } = buildMcpTools({ seed: false });
    const total = listActions().length;
    // 仅断言：暴露数 < 注册总数（方案 A 隐藏约 30 个 reserved）
    expect(tools.length, `暴露 ${tools.length} 应 < 注册 ${total}`).toBeLessThan(total);
  });
});
