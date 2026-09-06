// src/portal/agentConfig.js — 配置中心第 23 项「智能体配置」服务端 Router（只读聚合）
// 渲染纯函数在 agentConfigRender.js（浏览器可加载子模块）；本文件只服务端用（Node import）。
// 设计输入：docs/superpowers/plans/2026-08-28-agent-config.md
// 数据源：agentSpecs（src/agent/agentSpec.js 六段式定义）+ assertAgentAssembly（src/agent/agents.js 六条装配断言）
// 特性：纯只读聚合（agentSpec 是代码层定义，本次不做配置写入；写=改代码+重启，超出配置页范围）
import { Router } from 'express';

export function createAgentConfigRouter(deps = {}) {
  const router = Router();

  const handlers = {
    // GET /api/agent-config — 聚合 3 Agent specs + 装配断言 + 能力摘要
    get: async (req, res) => {
      try {
        const specs = typeof deps.getSpecs === 'function' ? await deps.getSpecs() : {};
        const asm = typeof deps.getAssembly === 'function' ? await deps.getAssembly() : { results: [] };
        // 兼容注入：测试可注入数组或 { results }；真实 assertAgentAssembly 返回 { ok, results, failed }
        const asmResults = Array.isArray(asm) ? asm : (Array.isArray(asm?.results) ? asm.results : []);
        res.json({
          agents: Object.keys(specs),
          specs,
          assembly: asmResults,
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  };

  router.get('/api/agent-config', handlers.get);
  router.handlers = handlers; // 注入式测试
  return router;
}