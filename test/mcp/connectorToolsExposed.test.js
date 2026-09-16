// test/mcp/connectorToolsExposed.test.js — P0-4：MCP 工具面必须包含 connector 族
// 背景（F4 第三次复发）：buildMcpTools 只 seedActions+seedDiscoveryActions，
//   而 seedConnectorActions 仅在 app 进程 routes.js:616 调用 → 独立 MCP 进程（3001 / 生产 /mcp）
//   工具面无 sync-writeback-fields → 「办公智能体经 MCP 交互后写回」链路断。
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRegistry, listActions } from '../../src/action/registry.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('MCP 工具面含 connector 族（P0-4）', () => {
  beforeEach(() => { resetRegistry(); });

  it('buildMcpTools(seed:true) 暴露 sync-writeback-fields', () => {
    const { tools, writeTools } = buildMcpTools({ seed: true });
    const names = new Set(tools.map((t) => t.name));
    expect(listActions().some((a) => a.name === 'sync-writeback-fields')).toBe(true);
    expect(names.has('sync-writeback-fields'), 'sync-writeback-fields 应进 MCP 写面').toBe(true);
    expect(writeTools.some((t) => t.name === 'sync-writeback-fields')).toBe(true);
  });

  it('connector 族其余写 Action 同样进入工具面', () => {
    const { tools } = buildMcpTools({ seed: true });
    const names = new Set(tools.map((t) => t.name));
    for (const n of ['conn-attio-enrich-account', 'conn-zhizao-verify-account', 'conn-tender-push', 'conn-signal-lead-gen']) {
      expect(names.has(n), `${n} 应暴露`).toBe(true);
    }
  });

  it('seed:false 不注册（既有语义零回归）', () => {
    buildMcpTools({ seed: false });
    expect(listActions().some((a) => a.name === 'sync-writeback-fields')).toBe(false);
  });
});
