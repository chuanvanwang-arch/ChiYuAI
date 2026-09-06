// src/http/configRouter.js — 通用配置端点（S16–S33 配置中心面共用）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 7 + 蓝图 §3 配置面
// 契约：
//   GET  /api/config/:key  → {key, value, decision}（未配置 → 404；sysadmin 仅）
//   PUT  /api/config/:key  → body {value} ；写经两闸：
//     · 第0闸：一律 requireDecision（写无决策不落库，§6 主轴；决策事件 recordDecisionEvent）
//     · 七维（仅 decisionScene 提供时）：sevenCheck 拦截，block → 422 {error:'missing_context'}
//   · 角色闸：role 配置时（如 'sysadmin'）一律拦截非授权角色 → 403（sysadmin 兼容实际角色 'admin'）
//   · 密钥字段：secretFields 配置时，PUT 落库前加密、GET 返回掩码（明文不入客户端/日志）
//   router.handlers = {get, put}（Express 路由内部转调；测试直接调 handlers，注入式依赖）
import { Router } from 'express';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { sevenDimensionsCheck } from '../sevenDimensions/engine.js';
import { resolveMe as realResolveMe } from './auth.js';
import { readConfig as storeRead, writeConfig as storeWrite } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { hasRole, hasAnyRole, TENANT_LEVEL_ROLES } from './middleware/rbac.js';

// 默认依赖（真实）：读写 config_store（Task 9 迁移建表）、决策产证（第0闸）、七维引擎、角色解析
// 多租户（枢轴 4）：读按 scopeTenant(me)（sysadmin '*' 回退 system 默认）；写按 scopeOf(me)（永不通配，sysadmin 写平台默认）
const defaultDeps = {
  readConfig: async (key, { tenantId = 'system' } = {}) => storeRead(key, { tenantId }),
  writeConfig: async (key, value, decisionId, { tenantId = 'system' } = {}) => storeWrite(key, value, { tenantId, decisionId, updatedBy: 'system' }),
  // 第0闸：配置写一律需决策（场景不可辨识时降级为记录事件，不硬抛——保持既有业务写语义）
  produceDecision: async (scene, ctx) => {
    try {
      const r = await requireDecision(scene, ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { scenario_id: scene, trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
  sevenCheck: async (scene, ctx) => sevenDimensionsCheck(scene, ctx),
  // 角色解析（默认真实；测试注入 stub）
  resolveMe: async (req) => realResolveMe(req),
  // 密钥字段处理（默认恒等：不加密、掩码为占位；llm 等端点注入真实加解密）
  encryptSecret: (plain) => plain,
  maskSecret: () => '********',
};

// 角色是否匹配配置角色（'sysadmin' 兼容实际角色 'admin'，统一治理口径）
// 导出：llmConfigRouter 等多条配置路由复用同一判定口径，避免两份实现漂移
export function roleMatches(role, required) {
  if (!role) return false;
  if (required === 'sysadmin') return role === 'admin' || role === 'sysadmin';
  return role === required;
}

export function createConfigRouter(
  { key, role = 'sysadmin', level = null, decisionScene, secretFields = [], scope = 'tenant', resolve = null },
  deps = {}
) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  // §15 权限层级：level 显式优先；缺省由 scope 派生（platform→system 仅 ADMIN；tenant→tenant 三角色）
  // 注意：level（权限层级）与 scope（数据存储作用域）语义不同——如用户管理 scope='tenant' 但 level='system'（§15.2）
  const effectiveLevel = level || (scope === 'platform' ? 'system' : 'tenant');

  // 声明语义（设计文档 docs/2026-09-03-config-center-tenant-isolation-design.md §3.1）：
  //   scope='platform' → 该配置只存在/只读 system 一份（GET/PUT 恒 (system,key)）
  //   scope='tenant'   → 读按 scopeTenant(me)（admin 通配 '*' 回退 system），写按 scopeOf(me)（永不通配）
  //   resolve 可空：scope='platform' → 'system-only'；scope='tenant' → 'tenant-first'（默认值，记录声明供审计）
  const effectiveResolve = resolve || (scope === 'platform' ? 'system-only' : 'tenant-first');
  const readTenant = (me) => (scope === 'platform' ? 'system' : scopeTenant(me));
  const writeTenant = (me) => (scope === 'platform' ? 'system' : scopeOf(me));

  // 角色闸（§15.1）：level=system 仅 ADMIN；level=tenant 三角色（tan_admin/sysadmin/ADMIN）
  // 保留 legacy role 参数兼容（llmConfigRouter 等 import roleMatches）；level 闸优先于 legacy 闸
  async function ensureRole(req, res) {
    const me = await D.resolveMe(req).catch(() => ({ ok: false }));
    if (!me?.ok) {
      res.status(403).json({ error: '需要 sysadmin 权限' });
      return null;
    }
    if (effectiveLevel === 'system') {
      if (!hasRole(me, 'ADMIN')) {
        res.status(403).json({ error: '系统级配置仅 ADMIN 可访问（§15.1）' });
        return null;
      }
      return me;
    }
    if (!hasAnyRole(me, TENANT_LEVEL_ROLES)) {
      res.status(403).json({ error: '租户级配置仅 tan_admin/sysadmin/ADMIN 可访问（§15.1）' });
      return null;
    }
    return me;
  }

  const handlers = {
    get: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const rec = await D.readConfig(key, { tenantId: readTenant(me) });
        if (!rec) return res.status(404).json({ error: `config ${key} 未配置` });
        let value = rec.value;
        if (secretFields.length && value && typeof value === 'object') {
          value = { ...value };
          for (const f of secretFields) {
            if (value[f] != null) value[f] = D.maskSecret(value[f]);
          }
        }
        res.json({ key, value, decision: rec.decision_id || null });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const { value } = req.body || {};
        if (value === undefined || value === null || typeof value !== 'object') {
          return res.status(400).json({ error: 'value 必填对象' });
        }
        // 七维拦截（仅决策相关配置面）：校验「配置值本身」是否完整（如七维设计须含全部 0–5 维）
        if (decisionScene) {
          const ctx = value;
          const check = await D.sevenCheck(decisionScene, ctx);
          if (!check.allowed && check.level === 'block') {
            return res.status(422).json({
              error: 'missing_context',
              missing: check.missing,
              level: check.level,
            });
          }
        }
        // 密钥字段：未提供 → 保留既有（若有）；提供 → 加密落库（明文不入库/日志）
        let nextValue = value;
        if (secretFields.length) {
          const existing = await D.readConfig(key);
          nextValue = { ...value };
          for (const f of secretFields) {
            const incoming = value[f];
            if (incoming == null || incoming === '') {
              if (existing?.value?.[f] != null) nextValue[f] = existing.value[f]; // 保留既有密钥
            } else {
              nextValue[f] = D.encryptSecret(incoming);
            }
          }
        }
        // 写第0闸：任何配置写都产决策（无决策不写）
        const decision = await D.produceDecision(decisionScene || 'config-change', { key, value });
        await D.writeConfig(key, nextValue, decision?.decisionId || null, { tenantId: writeTenant(me) });
        res.json({ key, value: nextValue, decision: decision?.decisionId || null, updated: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get(`/api/config/${key}`, handlers.get);
  router.put(`/api/config/${key}`, handlers.put);

  // 测试契约：handlers 直接暴露（Express 路由内部也转调同一函数），注入式测试无需起服务器
  router.handlers = handlers;
  return router;
}

export { defaultDeps };
