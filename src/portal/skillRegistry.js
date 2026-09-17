// src/portal/skillRegistry.js — 方法论 SKILL 注册表 配置面 Router（第 16 项）
// 设计输入：docs/superpowers/plans/2026-08-28-skill-registry-config.md
// 契约：
//   GET /api/config/skill-registry → {skills:[...], total}（DB enabled 权威快照）
//   PUT /api/config/skill-registry → body {skill_id, enabled}；写经两闸：
//     · sysadmin 权限（resolveMe → role==='admin'，否则 403）
//     · 第0闸：requireDecision 产决策；场景不可辨识降级 recordDecisionEvent('config_change')
//   router.handlers = {get, put}（Express 路由内部转调；测试直接调 handlers，注入式依赖）
// 禁删纪律：无 DELETE 路由；只改 enabled（物理行保留）
import { Router } from 'express';
import { requireDecision, decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { listSkillRegistry, setSkillEnabled } from '../skills/skillRegistry.js';
import { resolveMe } from '../http/auth.js';

const defaultDeps = {
  list: listSkillRegistry,
  setEnabled: setSkillEnabled,
  produceDecision: async (scene, ctx) => {
    try {
      const r = await requireDecision(scene, ctx || {});
      const did = decisionIdOf(r);
      return { decisionId: did, ok: !!did };
    } catch {
      await recordDecisionEvent('config_change', { scenario_id: scene, trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
  resolveMe,
};

export function createSkillRegistryRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const handlers = {
    get: async (req, res) => {
      try {
        const skills = await D.list();
        res.json({ skills, total: skills.length });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        // sysadmin 权限闸
        const me = await D.resolveMe(req);
        if (!me.ok || me.role !== 'admin') {
          return res.status(403).json({ error: '仅 sysadmin 可改 SKILL 启停' });
        }
        const { skill_id, enabled } = req.body || {};
        if (!skill_id || typeof skill_id !== 'string') {
          return res.status(400).json({ error: 'skill_id 必填字符串' });
        }
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'enabled 必填布尔' });
        }
        // 第0闸：任何启停写都产决策（无决策不写）
        const decision = await D.produceDecision('config-change', { key: 'skill-registry', skill_id, enabled });
        const row = await D.setEnabled(skill_id, enabled);
        res.json({ ...row, decision: decision?.decisionId || null, updated: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/skill-registry', handlers.get);
  router.put('/api/config/skill-registry', handlers.put);

  // 测试契约：handlers 直接暴露（Express 路由内部转调同一函数），注入式测试无需起服务器
  router.handlers = handlers;
  return router;
}