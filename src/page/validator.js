// src/page/validator.js — Schema 结构层校验（4 粒子护栏 + navigation 强制）
// 设计输入：ai-portal-page-generation 三层护栏②结构层；4 粒子校验规则
import {
  PAGE_TYPES, COMPONENT_KINDS, THEMES, FILTER_OPS, AGG_FUNCS,
  PARTICLE_TYPES_ENUM, ACTION_WHITELIST, CANONICAL_NAV,
  STATE_FIELDS_PER_TYPE, SNAPSHOT_FIELDS_PER_TYPE,
  ATTR_FIELD_TYPES, AGGREGATE_KINDS,
} from './schema.js';

// 校验 Schema → {ok, errors[]}
// 4 粒子护栏：① 粒子值域（旧值直接拒绝非静默映射）② 状态字段 filter 仅 eq 且不可聚合 ③ 存量快照仅 latest ④ Action 白名单
export function validatePageSchema(schema) {
  if (!schema || typeof schema !== 'object') return { ok: false, errors: ['schema 缺失'] };
  const errors = [];

  // 基本结构
  if (!PAGE_TYPES.includes(schema.type)) errors.push(`页面类型非法: ${schema.type}`);
  if (!schema.title || typeof schema.title !== 'string') errors.push('title 必填字符串');
  if (!CANONICAL_NAV.includes(schema.navigation?.to)) errors.push(`navigation.to 非法: ${schema.navigation?.to}`);
  if (!Array.isArray(schema.components) || !schema.components.length) errors.push('components 至少 1 个');

  // 布局
  if (schema.layout) {
    if (!THEMES.includes(schema.layout.theme)) errors.push(`theme 非法: ${schema.layout.theme}`);
    if (!schema.layout.columns || schema.layout.columns < 1 || schema.layout.columns > 4) errors.push('columns 须 1-4');
  }

  for (const [i, comp] of (schema.components || []).entries()) {
    if (!COMPONENT_KINDS.includes(comp.kind)) { errors.push(`组件[${i}] kind 非法: ${comp.kind}`); continue; }
    // G1 T6 attr-field：元模型受控组件不走粒子数据源（attrSlug/attrType 直供，无 dataBinding）
    if (comp.kind === 'attr-field') {
      const { attrSlug, attrType } = comp;
      if (!attrSlug || typeof attrSlug !== 'string') errors.push(`组件[${i}] attr-field attrSlug 必填字符串`);
      if (!attrType || !ATTR_FIELD_TYPES.includes(attrType)) {
        errors.push(`组件[${i}] attr-field attrType 不在 19 类型集内: ${attrType}`);
      }
      continue;  // attr-field 属元模型配置面，跳过粒子四护栏
    }
    // 决策2 折叠容器（2026-08-29 completion plan Task 1）：纯布局容器，无 dataBinding，跳过粒子四护栏；
    // 仅校验其 components[] 子组件为非空数组（子组件自身仍走对应 kind 的护栏）。
    if (comp.kind === 'collapse') {
      if (!Array.isArray(comp.components) || !comp.components.length) {
        errors.push(`组件[${i}] collapse 须包含非空 components 子组件数组`);
      }
      continue;
    }
    // 两 TAB 任务监控（2026-08-29）：tabs 纯布局容器（仿 collapse），task-monitor 自定义数据源，均跳过粒子四护栏
    if (comp.kind === 'tabs') {
      if (!Array.isArray(comp.tabs) || !comp.tabs.length) {
        errors.push(`组件[${i}] tabs 须包含非空 tabs 子组件数组`);
      }
      continue;
    }
    if (comp.kind === 'task-monitor') {
      continue; // 自定义数据源（crm.tasks），不绑定粒子
    }
    // Task 4 契约合规矩阵：自定义数据源 source=contract，不走粒子四护栏（渲染器硬编码列头与取数）。
    if (comp.kind === 'contract-matrix') {
      continue;
    }
    // S13 目标达标卡（2026-08-29）：自定义数据面组件（data.components['target-card'] 直接提供
    // tier/target/window/actual/pass），不绑定粒子数据源 → 跳过粒子四护栏；渲染器 renderTargetCard 消费。
    if (comp.kind === 'target-card') {
      continue;
    }
    // 数字化指标重设计（2026-08-28 §3.2）：聚合型组件走 aggregate 契约
    // 理由：交易金额四联跨 2 类粒子、LTC 管道跨 6 类，单值 particleType 无法诚实表达。
    // 仍保留的护栏：sources[] 逐项粒子值域、metrics[] 必填、Action 白名单。
    if (AGGREGATE_KINDS.includes(comp.kind)) {
      const adb = comp.dataBinding;
      if (!adb || adb.source !== 'aggregate') {
        errors.push(`组件[${i}] ${comp.kind} 数据源须为 aggregate`);
        continue;
      }
      if (!Array.isArray(adb.sources) || !adb.sources.length) {
        errors.push(`组件[${i}] ${comp.kind} sources 必填非空数组`);
      } else {
        for (const t of adb.sources) {
          if (!PARTICLE_TYPES_ENUM.includes(t)) errors.push(`组件[${i}] sources 粒子类型非法: ${t}`);
        }
      }
      if (!Array.isArray(adb.metrics) || !adb.metrics.length) {
        errors.push(`组件[${i}] ${comp.kind} metrics 必填非空数组`);
      } else {
        for (const m of adb.metrics) {
          if (!m || typeof m.key !== 'string' || !m.key) errors.push(`组件[${i}] metric.key 必填非空字符串`);
          if (m.agg && !AGG_FUNCS.includes(m.agg)) errors.push(`组件[${i}] 聚合非法: ${m.agg}`);
        }
      }
      for (const a of comp.actions || []) {
        const allowed = [...ACTION_WHITELIST.read, ...ACTION_WHITELIST.write];
        if (!allowed.includes(a.action)) {
          errors.push(`组件[${i}] 动作 ${a.action} 不在 Action 白名单`);
        }
      }
      continue;
    }
    const db = comp.dataBinding;
    if (!db || db.source !== 'particle') { errors.push(`组件[${i}] 数据源非粒子`); continue; }

    // ① 粒子值域（旧值 DEAL/ACCOUNT 直接拒绝，非静默映射）
    if (!PARTICLE_TYPES_ENUM.includes(db.particleType)) {
      errors.push(`组件[${i}] 粒子类型非法(旧值/未知): ${db.particleType}`);
      continue;
    }

    // ② 状态字段：filter 仅 eq；禁止聚合状态字段
    const stateFields = STATE_FIELDS_PER_TYPE[db.particleType] || [];
    for (const f of db.filters || []) {
      if (!FILTER_OPS.includes(f.op)) errors.push(`组件[${i}] 过滤算子非法: ${f.op}`);
      if (stateFields.includes(f.field) && f.op !== 'eq') {
        errors.push(`组件[${i}] 状态字段 ${f.field} 仅支持 eq，不支持 ${f.op}`);
      }
    }
    for (const m of db.metrics || []) {
      if (!AGG_FUNCS.includes(m.agg)) errors.push(`组件[${i}] 聚合非法: ${m.agg}`);
      if (stateFields.includes(m.field)) errors.push(`组件[${i}] 状态字段 ${m.field} 不可聚合`);
    }

    // ③ 存量快照字段仅 latest
    const snapshotFields = SNAPSHOT_FIELDS_PER_TYPE[db.particleType] || [];
    for (const m of db.metrics || []) {
      if (snapshotFields.includes(m.field) && m.agg !== 'latest') {
        errors.push(`组件[${i}] 存量快照字段 ${m.field} 仅支持 latest，不支持 ${m.agg}`);
      }
    }

    // ④ Action 白名单
    for (const a of comp.actions || []) {
      const allowed = [...ACTION_WHITELIST.read, ...ACTION_WHITELIST.write];
      if (!allowed.includes(a.action)) {
        errors.push(`组件[${i}] 动作 ${a.action} 不在 Action 白名单`);
      }
    }

    // ⑤ table 行内操作按钮白名单（rowActions）
    if (comp.kind === 'table' && Array.isArray(db.rowActions)) {
      for (const a of db.rowActions) {
        if (!a || typeof a.action !== 'string') {
          errors.push(`组件[${i}] rowActions 项须含 action 字符串`);
          continue;
        }
        const allowed = [...ACTION_WHITELIST.read, ...ACTION_WHITELIST.write];
        if (!allowed.includes(a.action)) {
          errors.push(`组件[${i}] rowActions 动作 ${a.action} 不在 Action 白名单`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}