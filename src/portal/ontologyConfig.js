// src/portal/ontologyConfig.js — 粒子模型 / 本体 / 词汇配置（第 22 项，S27 端点 + 可编辑）
// 架构纪律（2026-08-27 QA 教训）：渲染纯函数已拆至 ontologyConfigRender.js（浏览器 ESM 可加载），
// 本文件保留服务端 Router + 从子模块 re-export 纯函数（vitest 与旧页面 import 兼容）。
// 后端事实：
//   · 词汇事实源 = CRM_KNOWLEDGE 粒子（vocabulary.js 写时登记），本模块同源读写（不建独立 ontology 表）
//   · 粒子模型事实源 = particleModel.js 代码常量（PARTICLE_TYPES/SEMANTIC_TAGS/ATTRIBUTE_TYPE_SET）
//     —— **服务端单一事实源**：render 子模块零 import（2026-08-29 ontology 加载卡死根因教训），
//        任何浏览器侧 ESM 不再 import '../particles/...'，粒子模型由本文件导入并通过 API/SSR 注入前端。
//   · 配置快照落 crm.config_store（key='ontology-model'，只读审计副本）
// 红线：词汇禁删（停用=软标记 state='INACTIVE'）、写经决策第0闸、非租户级角色 403、模型快照只读
// 2026-09-05 用户决议：#22 自系统级移入租户级——词汇是租户主数据（CRM_KNOWLEDGE 粒子按 tenant_id 隔离），
// 闸放宽为 tan_admin(本租户)/sysadmin/ADMIN；数据层读写强制 tenant_id 过滤（admin=system 通配全量）。
import { Router } from 'express';
import { query } from '../db.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
import { hasAnyRole, TENANT_LEVEL_ROLES } from '../http/middleware/rbac.js';
// 粒子模型服务端事实源（仅服务端 import；浏览器侧 render 子模块不可见）
import {
  PARTICLE_TYPES,
  SEMANTIC_TAGS,
  ATTRIBUTE_TYPE_SET,
} from '../particles/particleModel.js';
// 渲染/校验纯函数（单一事实源 = ontologyConfigRender.js；浏览器可加载）
import {
  VOCAB_EDITABLE_FIELDS,
  VOCAB_STATES,
  validateVocabularyPatch,
  renderVocabulary,
  CORE_PARTICLE_IDS,
  renderModelSnapshot,
} from './ontologyConfigRender.js';

// 服务端粒子模型快照（事实源 = particleModel.js 的代码常量）
// 仅服务端组装 + 注入；浏览器侧不可见，规避历史 ESM 跨目录 404 卡死
const PARTICLE_MODEL = {
  particleTypes: PARTICLE_TYPES,
  semanticTags: SEMANTIC_TAGS,
  attributeTypeSet: [...ATTRIBUTE_TYPE_SET],
  coreParticleIds: CORE_PARTICLE_IDS,
};

// re-export：测试与旧 import 从本文件取纯函数，保持兼容
export {
  VOCAB_EDITABLE_FIELDS,
  VOCAB_STATES,
  validateVocabularyPatch,
  renderVocabulary,
  CORE_PARTICLE_IDS,
  PARTICLE_MODEL,
  renderModelSnapshot,
};

// —— 端点（注入式依赖，对齐 userManagement.js 范式）——
// tenantId 语义：admin 会话 tenantId='system' → 通配全量；其他租户级角色 → 仅本租户（数据层 WHERE tenant_id 硬过滤）
const defaultDeps = {
  // 词汇直查 CRM_KNOWLEDGE 粒子（事实源；不建独立 ontology 表）
  listVocabulary: async (tenantId) =>
    (await query(
      `SELECT id, payload->>'term' AS term, payload->>'type' AS type, payload->>'layer' AS layer,
              CASE WHEN state='ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END AS state
       FROM crm.particles
       WHERE type='CRM_KNOWLEDGE' AND ($1::text IS NULL OR tenant_id=$1)
       ORDER BY state='ACTIVE' DESC, created_at DESC`,
      [tenantId === 'system' ? null : tenantId || null]
    )).rows,
  // 词汇写入：幂等 upsert——(id, patch, tenantId) 编辑/停用；(term, type, layer, state, tenantId) 新增。
  // 软停用=state INACTIVE；一切读写限定 tenant_id（admin 通配 system），跨租户改写在 WHERE 层被挡
  upsertVocabulary: async (arg1, arg2, arg3, arg4, tenantId) => {
    const tid = tenantId || 'system';
    // 形态一：(id, patch, tenantId) —— 编辑/停用（软标记）
    if (arg2 && typeof arg2 === 'object') {
      const patch = arg2;
      const r = await query(
        `UPDATE crm.particles SET
           state = COALESCE($3, state),
           payload = payload || jsonb_build_object(
             'term', COALESCE($4, payload->>'term'),
             'type', COALESCE($5, payload->>'type'),
             'layer', COALESCE($6, payload->>'layer')),
           updated_at = now()
         WHERE id=$1 AND tenant_id=$2 RETURNING id`,
        [arg1, tid, patch.state || null, patch.term || null, patch.type || null, patch.layer || null]
      );
      return r.rows[0] || null;
    }
    // 形态二：(term, type, layer, state, tenantId) —— 按 term 幂等新增（查重限本租户）
    const term = arg1;
    const exists = await query(
      `SELECT id FROM crm.particles WHERE type='CRM_KNOWLEDGE' AND tenant_id=$2 AND payload->>'term'=$1 LIMIT 1`,
      [term, tid]
    );
    if (exists.rows[0]) {
      const r = await query(
        `UPDATE crm.particles SET state=$3, payload=jsonb_set(payload, '{type}', to_jsonb($4::text)) ||
                jsonb_set(payload, '{layer}', to_jsonb($5::text)), updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING id`,
        [exists.rows[0].id, tid, arg4 || 'ACTIVE', arg2, arg3]
      );
      return r.rows[0];
    }
    const r = await query(
      `INSERT INTO crm.particles (tenant_id, type, slug, title, state, payload, decision_id)
       VALUES($6, 'CRM_KNOWLEDGE', $2, $1, $3,
              jsonb_build_object('term', $1, 'type', $4, 'layer', $5), NULL)
       RETURNING id`,
      [term, slugify(term), arg4 || 'ACTIVE', arg2, arg3, tid]
    );
    return r.rows[0];
  },
  // 服务端组装粒子模型快照（事实源 = particleModel.js，单一来源；渲染子模块零 import 注入）
  modelSnapshot: async () => PARTICLE_MODEL,
  resolveMe,
  recordDecisionEvent,
};

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'vocab';
}

export function createOntologyRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const forbid = (res) => res.status(403).json({ error: '需要 tan_admin(本租户)/sysadmin/ADMIN 权限' });

  // 租户级闸（2026-09-05 #22 移租户级）：tan_admin 限本租户（数据层 tenant_id 二次硬过滤）
  const ensureTenantLevel = (me) => me?.ok && hasAnyRole(me, TENANT_LEVEL_ROLES);

  const handlers = {
    // GET /api/config/ontology/vocabulary（租户级读；ten_admin 仅本租户，admin 通配全量）
    getVocabulary: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!ensureTenantLevel(me)) return forbid(res);
        res.json({ vocabulary: await D.listVocabulary(me.tenantId) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    // PUT /api/config/ontology/vocabulary（新增/编辑/停用，决策第0闸 + 数据层 tenant_id 隔离）
    putVocabulary: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!ensureTenantLevel(me)) return forbid(res);
        const { id, patch } = req.body || {};
        if (!patch) return res.status(400).json({ error: 'patch 必填' });
        const v = validateVocabularyPatch(patch);
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
        const decision = await D.recordDecisionEvent('config_change', {
          type: 'vocabulary_upsert',
          id: id || null,
          term: v.normalized.term,
          fields: Object.keys(v.normalized),
        });
        // 有 id → 停用/编辑（软标记）；无 id → 按 term 幂等新增；写入限定会话租户
        const row = id
          ? await D.upsertVocabulary(id, v.normalized, me.tenantId)
          : await D.upsertVocabulary(v.normalized.term, v.normalized.type, v.normalized.layer, v.normalized.state, me.tenantId);
        res.json({ ok: true, id: row?.id || null, decision: decision?.event_id || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    // GET /api/config/ontology/model（只读模型快照；模型为平台代码常量，仅闸不隔离）
    getModel: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!ensureTenantLevel(me)) return forbid(res);
        res.json({ model: await D.modelSnapshot() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/ontology/vocabulary', handlers.getVocabulary);
  router.put('/api/config/ontology/vocabulary', handlers.putVocabulary);
  router.get('/api/config/ontology/model', handlers.getModel);
  router.handlers = handlers; // 注入式测试
  return router;
}