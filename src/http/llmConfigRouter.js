// src/http/llmConfigRouter.js — 多条 LLM 配置管理端点（T3）
// 设计：docs/2026-09-02-llm-multi-config-design.md
// 契约：
//   GET    /api/config/llm-configs            → {items:[...]}（api_key 掩码）
//   POST   /api/config/llm-configs            → 新增（name 唯一）
//   PUT    /api/config/llm-configs/:id        → 改（api_key 未传则保留既有）
//   DELETE /api/config/llm-configs/:id        → 软删；default 拒绝 → 400 cannot_delete_default
//   POST   /api/config/llm-configs/:id/set-default → 设默认（清旧默认，唯一）
//   POST   /api/config/llm-configs/:id/test   → 测试连通（单次实调，返回 ok/ms/error）
// 治理：
//   · 角色闸：仅 ADMIN（§15.2 LLM 配置=系统级；原 sysadmin 级已按用户决议收紧）
//   · 第0闸：写操作（create/update/remove/set-default）一律经 produceDecision，无决策不落库
//   · 密钥：api_key 落库前加密，出参一律掩码（明文不入客户端/日志）
//   · 禁物理 DELETE：deleteConfig 内部软删 is_deleted
//   router.handlers = {list, create, update, remove, setDefault, test}（注入式测试无需起服务器）
import { Router } from 'express';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe as realResolveMe } from './auth.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { hasRole } from './middleware/rbac.js'; // §15.2 LLM 配置=系统级，收紧为仅 ADMIN（原 sysadmin 级）
import { encryptSecret, decryptSecret } from '../llm/secret.js';
import {
  listConfigs, getByName, upsertConfig, deleteConfig, setDefault,
} from '../llm/llmConfigStore.js';

const defaultDeps = {
  listConfigs: (tenantId) => listConfigs(tenantId),
  getByName: (name, tenantId) => getByName(name, tenantId),
  upsertConfig: (p) => upsertConfig(p),
  deleteConfig: (id, tenantId) => deleteConfig(id, tenantId),
  setDefault: (id, tenantId) => setDefault(id, tenantId),
  // 第0闸：写一律需决策；场景不可辨识时降级为记录事件，不硬抛（与 configRouter 同语义）
  produceDecision: async (scene, ctx) => {
    try {
      const r = await requireDecision(scene, ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { scenario_id: scene, trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
  resolveMe: async (req) => realResolveMe(req),
  encryptSecret: (plain) => encryptSecret(plain),
  maskSecret: () => '********',
  // 连通测试：真实单次 chat/completions；失败返回 {ok:false,error}，不抛
  testConnect: async (cfg) => {
    const apiKey = cfg.api_key ? decryptSecret(cfg.api_key) : null;
    const base = String(cfg.base_url || '').replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    if (!apiKey || !url || url === '/chat/completions') {
      return { ok: false, error: 'missing_api_key_or_base_url' };
    }
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, temperature: 0 }),
        signal: ctrl.signal,
      });
      return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: e?.message || 'connect_failed', ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  },
};

const ROLE = 'sysadmin';
const SECRET_FIELD = 'api_key';

// 出参脱敏：api_key 一律掩码（明文绝不出网）
function maskRow(row, maskSecret) {
  if (!row) return row;
  const out = { ...row };
  if (out[SECRET_FIELD] != null) out[SECRET_FIELD] = maskSecret(out[SECRET_FIELD]);
  return out;
}

// 入参校验：name/provider/model 必填；name 重复 → 409
// 注意：name 在 DB 层为全局 UNIQUE，更新改名同样会撞约束 → 必须在此拦截，
// 否则用户拿到的是 500（约束违反）而非可读的 409。
async function validatePayload(body, { isUpdate, deps, tenantId, id }) {
  const { name, provider, model, base_url, api_key, temp, max_tokens, is_default } = body || {};
  if (isUpdate) {
    if (name !== undefined && !String(name).trim()) return { error: 'name 不能为空' };
    if (name) {
      const dup = await deps.getByName(String(name).trim(), tenantId);
      if (dup && dup.id !== id) return { error: 'name 已存在', code: 409 };
    }
  } else {
    if (!name || !String(name).trim()) return { error: 'name 必填' };
    if (!provider || !model) return { error: 'provider 与 model 必填' };
    const dup = await deps.getByName(String(name).trim(), tenantId);
    if (dup) return { error: 'name 已存在', code: 409 };
  }
  if (temp !== undefined && temp !== null && Number.isNaN(Number(temp))) return { error: 'temp 必须为数字' };
  if (max_tokens !== undefined && max_tokens !== null && Number.isNaN(Number(max_tokens))) return { error: 'max_tokens 必须为整数' };
  return { ok: true };
}

export function createLlmConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  async function ensureRole(req, res) {
    const me = await D.resolveMe(req).catch(() => ({ ok: false }));
    // §15.1：LLM 配置属系统级 → 仅 ADMIN（sysadmin 不再放行，用户决议 2026-09-04）
    if (!me?.ok || !hasRole(me, 'ADMIN')) {
      res.status(403).json({ error: '系统级配置仅 ADMIN 可访问（§15.1）' });
      return null;
    }
    return me;
  }

  const handlers = {
    list: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const rows = await D.listConfigs(scopeTenant(me));
        res.json({ items: rows.map((r) => maskRow(r, D.maskSecret)) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },

    create: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const tenantId = scopeOf(me);
        const v = await validatePayload(req.body, { isUpdate: false, deps: D, tenantId });
        if (!v.ok) return res.status(v.code || 400).json({ error: v.error });
        const b = req.body || {};
        const decision = await D.produceDecision('llm-config-change', { action: 'create', name: b.name });
        const apiKey = b.api_key ? D.encryptSecret(b.api_key) : null;
        const row = await D.upsertConfig({
          name: String(b.name).trim(), provider: b.provider, model: b.model, base_url: b.base_url,
          api_key: apiKey, temp: b.temp, max_tokens: b.max_tokens, is_default: !!b.is_default,
          tenantId, updated_by: me.username || 'system',
        });
        res.status(201).json({ item: maskRow(row, D.maskSecret), decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },

    update: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const tenantId = scopeOf(me);
        const { id } = req.params;
        const v = await validatePayload(req.body, { isUpdate: true, deps: D, tenantId, id });
        if (!v.ok) return res.status(v.code || 400).json({ error: v.error });
        const b = req.body || {};
        const decision = await D.produceDecision('llm-config-change', { action: 'update', id });
        const row = await D.upsertConfig({
          id, name: b.name, provider: b.provider, model: b.model, base_url: b.base_url,
          api_key: b.api_key ? D.encryptSecret(b.api_key) : undefined,
          temp: b.temp, max_tokens: b.max_tokens, is_default: b.is_default,
          tenantId, updated_by: me.username || 'system',
        });
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.json({ item: maskRow(row, D.maskSecret), decision: decision?.decisionId || null, updated: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },

    remove: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const decision = await D.produceDecision('llm-config-change', { action: 'delete', id: req.params.id });
        const r = await D.deleteConfig(req.params.id, scopeOf(me));
        if (!r.ok) return res.status(400).json({ error: r.error });
        res.json({ deleted: true, soft: true, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },

    setDefault: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const decision = await D.produceDecision('llm-config-change', { action: 'set-default', id: req.params.id });
        const row = await D.setDefault(req.params.id, scopeOf(me));
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.json({ item: maskRow(row, D.maskSecret), decision: decision?.decisionId || null, is_default: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },

    test: async (req, res) => {
      try {
        const me = await ensureRole(req, res);
        if (!me) return;
        const rows = await D.listConfigs(scopeTenant(me));
        const row = rows.find((r) => r.id === req.params.id);
        if (!row) return res.status(404).json({ error: 'not_found' });
        const r = await D.testConnect(row);
        res.json({ id: row.id, name: row.name, ...r });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/llm-configs', handlers.list);
  router.post('/api/config/llm-configs', handlers.create);
  router.put('/api/config/llm-configs/:id', handlers.update);
  router.delete('/api/config/llm-configs/:id', handlers.remove);
  router.post('/api/config/llm-configs/:id/set-default', handlers.setDefault);
  router.post('/api/config/llm-configs/:id/test', handlers.test);

  router.handlers = handlers;
  return router;
}

export { defaultDeps as llmConfigDefaultDeps };
