// test/web/browserLoadable.test.js — 浏览器 ESM 可加载性守卫（RED 起点）
// 根因：4 个混合 portal 模块顶层 import express/db.js/decision → 浏览器原生 ESM 加载
// 报 "Failed to resolve module specifier 'express'" → 页面脚本整体崩溃（列表不渲染/按钮不绑定）
// 修复：渲染纯函数抽到 <name>Render.js 子模块（零服务端 import），页面 import 子模块。
// 本测试断言：①子模块存在；②子模块源码不含浏览器不可解析的 bare import（express/db.js/decision/events…）；
// ③页面 import 指向子模块而非混合原文件。
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const src = fileURLToPath(new URL('../../src', import.meta.url));
const web = fileURLToPath(new URL('../../src/web', import.meta.url));

const CASES = [
  { render: 'approvalFlowRender.js', page: 'approval-flow.html', mixed: 'approvalFlow.js' },
  { render: 'alertRuleConfigRender.js', page: 'alert-rules.html', mixed: 'alertRuleConfig.js' },
  { render: 'mcpIdentityRender.js', page: 'mcp-identities.html', mixed: 'mcpIdentity.js' },
  { render: 'businessTierRender.js', page: 'business-tier.html', mixed: 'businessTier.js' },
  { render: 'decisionScenarioRender.js', page: 'decision-scenarios.html', mixed: 'decisionScenario.js' },
  { render: 'rbacMatrixRender.js', page: 'rbac.html', mixed: 'rbacMatrix.js' },
  { render: 'userManagementRender.js', page: 'users.html', mixed: 'userManagement.js' },
  { render: 'ontologyConfigRender.js', page: 'ontology.html', mixed: 'ontologyConfig.js' },
  { render: 'agentConfigRender.js', page: 'agent-config.html', mixed: 'agentConfig.js' },
  { render: 'systemSettingsRender.js', page: 'system.html', mixed: 'systemSettings.js' },
  { render: 'memoryConfigRender.js', page: 'memory.html', mixed: 'memoryConfig.js' },
  { render: 'businessClosureRender.js', page: 'business-closure.html', mixed: 'businessBoard.js' },
  { render: 'llmConfigRender.js', page: 'llm.html', mixed: null },
  { render: 'sevenDimRender.js', page: 'seven-dim.html', mixed: null },
  { render: 'poolConfigRender.js', page: 'pool-config.html', mixed: null },
  { render: 'skillRegistryRender.js', page: 'skills.html', mixed: 'skillRegistry.js' },
];

const BROWSER_FORBIDDEN = /import\s+[^;]*from\s+['"](express|\.\.\/db\.js|\.\.\/decision\/[^'"]+|\.\.\/alerts\/[^'"]+|\.\.\/events\/[^'"]+|\.\.\/monitor\/[^'"]+|\.\.\/http\/[^'"]+|\.\.\/kanban\/[^'"]+|\.\.\/particles\/particleRepo[^'"]*|\.\.\/memory\/[^'"]+|\.\.\/action\/[^'"]+)['"]/;
const PARTICLE_MODEL_ALLOWED = /import\s+[^;]*from\s+['"]\.\.\/particles\/particleModel\.js['"]/;

test('15 个配置页的渲染子模块存在且浏览器可加载', () => {
  for (const c of CASES) {
    const p = path.join(src, 'portal', c.render);
    const txt = readFileSync(p, 'utf8');
    expect(txt.length, `${c.render} 应为非空`).toBeGreaterThan(0);
    // 浏览器 ESM 禁止 bare specifier（express）与相对服务端模块（db/decision/alerts/events）
    const bad = txt.match(BROWSER_FORBIDDEN);
    expect(bad, `${c.render} 不得含浏览器不可解析 import: ${bad?.[0] || ''}`).toBeNull();
    // 允许粒子模型纯数据依赖（particleModel.js 零服务端 import），但禁止任何其它相对模块 import
    const relOther = txt.match(/import\s+[^;]*from\s+['"]\.\.\/particles\/(?!particleModel\.js)[^'"]+['"]/);
    expect(relOther, `${c.render} 若有粒子依赖必须只来自 particleModel.js`).toBeNull();
    // 渲染子模块应导出页面使用的主要渲染函数
    expect(txt).toMatch(/export function render/);
  }
});

test('15 个页面 import 均指向渲染子模块（不再 import 混合原文件）', () => {
  for (const c of CASES) {
    const html = readFileSync(path.join(web, c.page), 'utf8');
    expect(html).toContain(`/portal/${c.render}`);
    expect(html).not.toContain(`/portal/${c.mixed}`);
    // 页面不 import 混合原文件（服务端 router 仍由 node 路由引用，但页面只 import 纯渲染子模块）
    expect(html).not.toMatch(new RegExp(`import\\s+[^;]*from\\s+['"]\\/portal\\/${c.mixed}['"]`));
  }
});

test('混合原文件仍保留服务端 router（routes.js 继续 import 它；纯新建页面无混合原文件则跳过）', () => {
  const routes = readFileSync(path.join(src, 'http', 'routes.js'), 'utf8');
  for (const c of CASES) {
    if (!c.mixed) continue; // llm/seven-dim/pool-config 无混合原文件（Render 子模块=唯一实现）
    expect(routes).toContain(`../portal/${c.mixed}`);
  }
});