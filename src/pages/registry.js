// src/pages/registry.js — 受控面注册表（蓝图 §3 逐面 schema 的单一入口）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 6 + 蓝图 §3
// 契约：registerPage(id, schema) 幂等覆盖；getPage(id) → schema|null；allPages() → [{id,schema}]
// 面 id 采用蓝图编号（S01–S33），schema 必须通过 validatePageSchema（渲染前强校验）
import { validatePageSchema } from '../page/validator.js';

const pages = new Map();

export function registerPage(id, schema) {
  const v = validatePageSchema(schema);
  if (!v.ok) throw new Error(`受控面 ${id} schema 非法: ${v.errors[0]}`);
  pages.set(id, schema);
  return { id, ok: true };
}

export function getPage(id) {
  return pages.get(id) || null;
}

export function allPages() {
  return [...pages.entries()].map(([id, s]) => ({ id, schema: s }));
}

export function clearPages() {
  pages.clear();
}