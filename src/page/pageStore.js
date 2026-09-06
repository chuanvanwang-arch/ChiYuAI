// src/page/pageStore.js — 门户页面生命周期（内存 Map，draft→published→revert）
// 设计输入：docs/2026-08-25-portal-page-generation-design.md §E（页面生命周期 draft→publish→revert）
// 纪律：guardNlInput 拦截注入（不解析/不落库）；parse→validate 全绿才 draft；显式发布不自动覆盖人工页
import { randomUUID } from 'node:crypto';
import { guardNlInput } from './guardrails.js';
import { parseNlToSchema } from './nlParser.js';
import { validatePageSchema } from './validator.js';
import { renderPage } from './renderer.js';

// 内存存储：page_id → {nl, schema, confidence, notes, status: 'draft'|'published', createdAt}
const pages = new Map();

export function createPageFromNl(nl) {
  // ① 输入层护栏：注入直接拒绝，不解析/不落库
  const g = guardNlInput(nl);
  if (!g.safe) return { ok: false, error: `input_guard: ${g.reason}` };

  // ② NL→Schema（确定性解析）
  const r = parseNlToSchema(nl);
  if (!r.schema) return { ok: false, error: 'parse_empty', needsClarification: true, notes: r.notes || [] };

  // ③ 结构层校验（4 粒子护栏）——未过不能 draft
  const v = validatePageSchema(r.schema);
  if (!v.ok) return { ok: false, error: 'schema_invalid', errors: v.errors, needsClarification: r.needsClarification };

  // ④ 预览渲染（唯一渲染出口，动态值转义）
  const preview = renderPage(r.schema, {});
  if (preview.warnings.some(w => w.startsWith('schema_invalid'))) {
    return { ok: false, error: 'render_rejected', warnings: preview.warnings };
  }

  // ⑤ 落 draft（内存）
  const pageId = randomUUID();
  const record = {
    page_id: pageId,
    nl,
    schema: r.schema,
    confidence: r.confidence,
    notes: r.notes || [],
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
  pages.set(pageId, record);

  return { ok: true, page_id: pageId, schema: r.schema, confidence: r.confidence, needsClarification: r.needsClarification, previewHtml: preview.html };
}

export function listPages() {
  return [...pages.values()].map(({ page_id, nl, status, confidence, createdAt }) => ({
    page_id, nl, status, confidence, createdAt,
  }));
}

// 显式发布：draft→published；已 published 幂等（不自动覆盖人工页语义）
export function publishPage(pageId) {
  const p = pages.get(pageId);
  if (!p) return { ok: false, error: 'page_not_found' };
  if (p.status === 'published') return { ok: true, page_id: pageId, idempotent: true, status: 'published' };
  p.status = 'published';
  return { ok: true, page_id: pageId, status: 'published' };
}

// 回退：published→draft（可再编辑）
export function revertPage(pageId) {
  const p = pages.get(pageId);
  if (!p) return { ok: false, error: 'page_not_found' };
  if (p.status === 'draft') return { ok: true, page_id: pageId, idempotent: true, status: 'draft' };
  p.status = 'draft';
  return { ok: true, page_id: pageId, status: 'draft' };
}

// 预览/渲染入口：注入空数据（四态 empty 由 renderer 处理）
export function getPageHtml(pageId) {
  const p = pages.get(pageId);
  if (!p) return { ok: false, error: 'page_not_found' };
  const rendered = renderPage(p.schema, {});
  return { ok: true, html: rendered.html, warnings: rendered.warnings };
}