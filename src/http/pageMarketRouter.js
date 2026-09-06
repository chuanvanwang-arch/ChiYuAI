// src/http/pageMarketRouter.js — 页面市场端点（方案 C 收口：33 受控 schema 可枚举 + 可预览）
// 设计输入：docs/2026-08-26-design-audit.md 方案 C（未链接页面收口）
// 契约：
//   GET /api/page-market            → { total, pages: [{id,title,type,navigation,layout}] }（列表，不含 schema 大对象）
//   GET /api/page-market/:id        → { id, schema, html, warnings }（单个预览；renderPage 唯一渲染出口）
//   GET /page-market                → 页面市场静态页（卡片流 + 预览 iframe srcdoc）
// 与 registry.allPages() 单一事实源对齐：列表/详情均从受控注册表枚举，不重复维护面清单。
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { allPages, getPage } from '../pages/registry.js';
import { renderPage } from '../page/renderer.js';

export function buildList() {
  return allPages().map(({ id, schema }) => ({
    id,
    title: schema.title || id,
    type: schema.type || 'unknown',
    navigation: schema.navigation || {},
    layout: schema.layout || {},
  }));
}

export function createPageMarketRouter({ deps = {} } = {}) {
  const D = {
    render: (schema, data) => renderPage(schema, data),
    ...deps,
  };
  const router = Router();

  // 列表：轻量元数据（不含 schema，避免大响应；前端按 id 拉详情）
  router.get('/api/page-market', async (req, res) => {
    try {
      const pages = buildList();
      res.json({ total: pages.length, pages });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 详情：schema + 渲染预览（空数据走四态 empty；前端 iframe srcdoc 消费 html）
  router.get('/api/page-market/:id', async (req, res) => {
    try {
      const schema = getPage(req.params.id);
      if (!schema) return res.status(404).json({ error: `页面 ${req.params.id} 未注册` });
      const rendered = D.render(schema, {});
      res.json({ id: req.params.id, schema, html: rendered.html, warnings: rendered.warnings || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 页面市场静态页（卡片流 + 单击预览 iframe srcdoc）— admin 独享
  // 守卫改为前端 me() 校验（与 config.html 同约定）：token 存 localStorage，整页 <a> 跳转不带 Authorization 头，
  // 服务端若放 requireAdmin 会在无头跳转时判未登录 → 403；故此处只发静态页，角色由页面内 me() 拦截。
  router.get('/page-market', (req, res) => {
    res.sendFile(fileURLToPath(new URL('../web/page-market.html', import.meta.url)));
  });
  router.get('/page-market.html', (req, res) => {
    res.sendFile(fileURLToPath(new URL('../web/page-market.html', import.meta.url)));
  });

  return router;
}