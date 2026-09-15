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

// 外部数据接入：加密凭据写端点（2026-09-14，T13）
// 仅 ADMIN/sysadmin 可写；明文不落库（persistSecret 加密后经 config_store 落库）。
// 读取不暴露 GET（凭据永不回传前端），由 resolveCredentials 内联解密后注入 ctx.credentials。
import { persistSecret as vaultPersistSecret } from '../connectors/discovery/credentialVault.js';

export function createIntegrationSecretRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const persist = deps.persistSecret || vaultPersistSecret;
  const router = Router();

  // 角色闸：仅 ADMIN / sysadmin（§15.1 平台级，sales 403）
  async function ensureAdmin(req, res) {
    const me = await D.resolveMe(req).catch(() => ({ ok: false }));
    if (!me?.ok) {
      res.status(403).json({ error: '需要登录' });
      return null;
    }
    if (!(me.role === 'admin' || me.role === 'sysadmin' || me.roles?.includes('ADMIN'))) {
      res.status(403).json({ error: '接入凭据仅 ADMIN/sysadmin 可写入（§15.1）' });
      return null;
    }
    return me;
  }

  const handlers = {
    post: async (req, res) => {
      try {
        const me = await ensureAdmin(req, res);
        if (!me) return;
        const { tenantId = 'system', providerId, raw } = req.body || {};
        if (!providerId || raw == null || raw === '') {
          return res.status(400).json({ error: 'providerId 与 raw 必填' });
        }
        // 写经决策第0闸：任何凭据写都产证（无决策不写）
        const decision = await D.produceDecision('config-change', { key: 'integration-secrets', providerId, tenantId });
        await persist({ tenantId, providerId, raw, deps: D });
        res.json({ ok: true, updated: true, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.post('/api/integration/secret', handlers.post);
  // 测试契约：handlers 直接暴露，注入式测试无需起服务器
  router.handlers = handlers;
  return router;
}

// 外部数据接入：租户自有实例声明 CRUD（2026-09-14 补充）
// 仅 ADMIN/sysadmin；数组形态存 config_store['integration-providers']（per-tenant，默认 'system'）。
// 禁物理删除铁律 → 只在「启停」上做软开关（enabled:false=不参与扫描），不对实例做 DELETE。
export function createIntegrationProviderRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const read = deps.readConfig || (async (key, opt) => storeRead(key, opt));
  const write = deps.writeConfig || (async (key, value, decisionId, opt) => storeWrite(key, value, opt));
  const router = Router();
  const VALID_KINDS = ['generic-rest', 'generic-mcp', 'generic-cli'];

  async function ensureAdmin(req, res) {
    const me = await D.resolveMe(req).catch(() => ({ ok: false }));
    if (!me?.ok) {
      res.status(403).json({ error: '需要登录' });
      return null;
    }
    if (!(me.role === 'admin' || me.role === 'sysadmin' || me.roles?.includes('ADMIN'))) {
      res.status(403).json({ error: '接入数据源仅 ADMIN/sysadmin 可管理（§15.1）' });
      return null;
    }
    return me;
  }

  async function loadList(tenantId) {
    const row = await read('integration-providers', { tenantId }).catch(() => null);
    const v = row && row.value;
    return Array.isArray(v) ? v : [];
  }

  // 平台级声明：写按 'system' 默认；支持显式 tenantId（预留多租户按需扩展）
  const handlers = {
    get: async (req, res) => {
      try {
        const me = await ensureAdmin(req, res);
        if (!me) return;
        const tenantId = req.query.tenantId || 'system';
        const list = await loadList(tenantId);
        res.json({ ok: true, instances: list });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    post: async (req, res) => {
      try {
        const me = await ensureAdmin(req, res);
        if (!me) return;
        const { tenantId = 'system', instance } = req.body || {};
        if (!instance || typeof instance !== 'object') return res.status(400).json({ error: 'instance 必填对象' });
        const { id, kind, enabled = true, endpoint, field_map, command } = instance;
        if (!id || !kind) return res.status(400).json({ error: 'id 与 kind 必填' });
        if (!VALID_KINDS.includes(kind)) return res.status(400).json({ error: `kind 须为 ${VALID_KINDS.join('/')}` });
        // generic-rest/mcp 必须有 field_map；generic-cli 必须有 command
        if (kind !== 'generic-cli' && !field_map) return res.status(400).json({ error: 'generic-rest/mcp 须提供 field_map' });
        if (kind === 'generic-cli' && !command) return res.status(400).json({ error: 'generic-cli 须提供 command' });
        const list = await loadList(tenantId);
        if (list.some((x) => x.id === id)) return res.status(409).json({ error: `实例 ${id} 已存在（禁重名；可编辑）` });
        const next = [...list, { id, kind, enabled, endpoint, field_map, command }];
        const decision = await D.produceDecision('config-change', { key: 'integration-providers', action: 'add', id });
        await write('integration-providers', next, decision?.decisionId || null, { tenantId });
        res.json({ ok: true, updated: true, instances: next, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const me = await ensureAdmin(req, res);
        if (!me) return;
        const { tenantId = 'system' } = req.body || {};
        const id = req.params.id;
        const patch = req.body?.patch || req.body;
        if (!id) return res.status(400).json({ error: 'id 必填' });
        const list = await loadList(tenantId);
        const idx = list.findIndex((x) => x.id === id);
        if (idx < 0) return res.status(404).json({ error: `实例 ${id} 不存在` });
        const cur = list[idx];
        const next = { ...cur, ...patch, id };
        if (patch.kind && !VALID_KINDS.includes(patch.kind)) return res.status(400).json({ error: `kind 须为 ${VALID_KINDS.join('/')}` });
        // enabled 为显式布尔才改（防 patch.enabled 缺省把 true 覆盖成 undefined）
        if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
        list[idx] = next;
        const decision = await D.produceDecision('config-change', { key: 'integration-providers', action: 'update', id });
        await write('integration-providers', list, decision?.decisionId || null, { tenantId });
        res.json({ ok: true, updated: true, instances: list, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    del: async (req, res) => {
      // 禁删铁律（§零容忍 DELETE）：实例物理删除不做，改为 enabled:false 软停用
      res.status(405).json({ error: '实例不支持物理删除（禁删铁律）——请用 PUT enabled:false 软停用' });
    },
  };

  router.get('/api/integration/providers', handlers.get);
  router.post('/api/integration/providers', handlers.post);
  router.put('/api/integration/providers/:id', handlers.put);
  router.delete('/api/integration/providers/:id', handlers.del);
  router.handlers = handlers;
  return router;
}

export { defaultDeps };
