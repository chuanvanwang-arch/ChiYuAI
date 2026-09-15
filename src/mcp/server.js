// src/mcp/server.js — MCP Server 入口（stdio + StreamableHTTP 双传输）
// 设计输入：总体设计 §6.13（无头暴露：MCP Server + HTTP API）+ mcp-pack-complete-plan 阶段2
// 对齐 P2P 惯例：3001 端口 /mcp 路径；stdio 供本地嵌入式智能体直接 spawn
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { buildMcpTools } from './tools.js';
import { mcpReadDirect, mcpWritePhase1, mcpReadSensitivePhase1, mcpConfirmPhase2 } from './gateway.js';
import { mcpLogin } from './auth.js';
import { MCP_CONFIG } from './config.js';
// 外部数据源适配器自注册（registerProvider）；MCP 通道此前漏调 → REGISTRY 恒空 →
// 拓客/富集静默零产出（无报错、测试仍绿，最隐蔽死接线）。此处显式注册（幂等，覆盖 stdio+http 两入口）。
import { registerBuiltinAdapters } from '../connectors/discovery/builtinAdapters.js';

// 建 MCP Server：注册全部读工具（直连）+ 2 个写阶段工具（两阶段协议）
export function createMcpServer() {
  registerBuiltinAdapters(); // 确保 discovery 适配器注册表已填充（否则 MCP 通道下数据源静默失效）；幂等，覆盖 stdio+http 两入口
  const server = new McpServer({
    name: MCP_CONFIG.server.name,
    version: MCP_CONFIG.server.version,
  });

  const { readTools, writeTools, readSensitiveTools, authTools } = buildMcpTools();

  // 读工具：直连（走 mcpReadDirect——第 0 闸读放行、凭证最小权限降级）
  // 注意 inputSchema 已是 zod raw shape（tools.js jsonSchemaToZod 产出），
  // 直接传，勿取 .properties（那会把协议字段 confirm_token/choice 剥掉，SDK 冒烟实测 2026-08-26 14:3x 暴露）
  for (const t of readTools) {
    server.registerTool(t.name, {
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }, async (params, extra) => {
      const headers = extra?.headers || {};
      const r = await mcpReadDirect(t.name, params || {}, headers);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    });
  }

  // 写工具：两阶段（阶段1 取表单 → 阶段2 确认执行），暴露为统一 write 调用入口
  // inputSchema 直接传 zod raw shape（tools.js 已含 protocolShape: confirm_token/choice），勿取 .properties
  for (const t of writeTools) {
    server.registerTool(t.name, {
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }, async (params, extra) => {
      const headers = extra?.headers || {};
      // MCP 工具调用默认视为 phase1（取表单）；携带 confirm_token 则视为 phase2（确认执行）
      if (params?.confirm_token) {
        const r = await mcpConfirmPhase2(params.confirm_token, '1', null, params, headers);
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      }
      const r = await mcpWritePhase1(t.name, params, headers);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    });
  }

  // 敏感读工具：经 gateway confirm 闸（阶段1 取表单含角色 → 阶段2 持 confirm_token 执行）
  // inputSchema 直接传 zod raw shape（含 confirm_token/choice 协议字段），勿取 .properties
  for (const t of readSensitiveTools) {
    server.registerTool(t.name, {
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }, async (params, extra) => {
      const headers = extra?.headers || {};
      if (params?.confirm_token) {
        const r = await mcpConfirmPhase2(params.confirm_token, '1', null, params, headers);
        return { content: [{ type: 'text', text: JSON.stringify(r) }] };
      }
      const r = await mcpReadSensitivePhase1(t.name, params, headers);
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    });
  }

  // 登录工具：免 token 即可调用（首次接入验证入口），handler 调 mcpLogin 校验用户名密码并颁发 token
  for (const t of authTools) {
    server.registerTool(t.name, {
      title: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }, async (params) => {
      const r = await mcpLogin(params || {});
      return { content: [{ type: 'text', text: JSON.stringify(r) }] };
    });
  }

  return server;
}

// stdio 入口（本地嵌入式智能体 spawn：node src/mcp/server.js --stdio）
export async function startMcpStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

// StreamableHTTP 入口（3001 /mcp；对齐 P2P 惯例独立端口，不占 3000）
// 注意：McpServer 与 transport 为 1:1 绑定（SDK 限制一次 connect 一个 transport），
// 故每个会话必须新建独立 McpServer 实例（createMcpServer 无副作用可重复调用），不能函数级单例复用——否则第二个会话 connect 抛
// "Already connected to a transport"（实测崩溃根因，见 2026-08-26 14:26 修复）。
export async function startMcpHttp(port = MCP_CONFIG.transport.streamableHttp.port) {
  const app = express();
  app.use(express.json());

  const transports = new Map(); // sessionId → { transport, server }（StreamableHTTP 会话级，1:1）

  app.post(MCP_CONFIG.transport.streamableHttp.path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports.has(sessionId)) {
      const { transport } = transports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    const server = createMcpServer(); // 每会话独立实例（1:1 绑定 transport）
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => { /* 会话就绪 */ },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // 注意：SDK 内部已设置 Mcp-Session-Id 响应头（StreamableHTTP 协议要求），此处勿再 res.setHeader。
    // 关键：transport.sessionId 由 SDK 在首次 handleRequest 时才生成，必须先处理后入库，
    // 否则 Map key 是 undefined，后续带 mcp-session-id 的请求命中不到 → 新建未初始化 server → 400。
    if (transport.sessionId) transports.set(transport.sessionId, { transport, server });
  });

  app.get(MCP_CONFIG.transport.streamableHttp.path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = sessionId && transports.get(sessionId);
    if (!entry) return res.status(404).json({ error: 'MCP session not found' });
    await entry.transport.handleRequest(req, res);
  });

  app.delete(MCP_CONFIG.transport.streamableHttp.path, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const entry = sessionId && transports.get(sessionId);
    if (!entry) return res.status(404).json({ error: 'MCP session not found' });
    await entry.transport.handleRequest(req, res);
  });

  const httpServer = app.listen(port, () => {
    console.log(`[mcp] StreamableHTTP 就绪: http://127.0.0.1:${port}${MCP_CONFIG.transport.streamableHttp.path}`);
  });
  return { httpServer, transports };
}

// CLI 入口：node src/mcp/server.js [--stdio|--http]
if (process.argv[1] && process.argv[1].endsWith('server.js') && process.argv[1].includes('mcp')) {
  const mode = process.argv[2] || '--http';
  if (mode === '--stdio') startMcpStdio().catch(e => { console.error('[mcp] stdio 启动失败:', e); process.exit(1); });
  else startMcpHttp().catch(e => { console.error('[mcp] http 启动失败:', e); process.exit(1); });
}