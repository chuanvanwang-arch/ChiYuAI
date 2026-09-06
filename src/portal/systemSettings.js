// src/portal/systemSettings.js — 系统设置配置（第 28 项，S33 端点 + 可编辑）
// 架构纪律（2026-08-27 QA 教训）：渲染纯函数已拆至 systemSettingsRender.js（浏览器 ESM 可加载），
// 本文件保留服务端 router + 从子模块 re-export 纯函数（vitest 与旧页面 import 兼容）。
// 设计输入：docs/superpowers/plans/2026-08-27-system-settings-config.md
// 后端事实：crm.config_store（KV，key='system'）；审计历史 = crm.decision_event（event_type='config_change'）
// 红线：写经决策第0闸、sysadmin 权限、审计日志只读（无写端点）、字段白名单（防任意 JSON 注入）
import { Router } from 'express';
import { query } from '../db.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
// 渲染/校验纯函数（单一事实源 = systemSettingsRender.js）
import {
  SYSTEM_FIELDS,
  THEMES,
  SECURITY_KEYS,
  validateSystemSettingsPatch,
  renderSystemSettings,
  renderAuditLogs,
} from './systemSettingsRender.js';

// re-export：测试与旧 import 从本文件取纯函数，保持兼容
export { SYSTEM_FIELDS, THEMES, SECURITY_KEYS, validateSystemSettingsPatch, renderSystemSettings, renderAuditLogs };

// —— 端点（注入式依赖，对齐 userManagement.js 范式）——
const defaultDeps = {
  readConfig: async (key) => {
    const r = await query(`SELECT value, decision_id FROM crm.config_store WHERE key=$1`, [key]);
    return r.rows[0] || null;
  },
  writeConfig: async (key, value, decisionId) => {
    await query(
      `INSERT INTO crm.config_store (key, value, decision_id, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET value=$2, decision_id=$3, updated_by=$4, updated_at=now()`,
      [key, JSON.stringify(value), decisionId, 'system']
    );
    return { key, ok: true };
  },
  // 审计日志直查 decision_event（config_change 最近 20 条）
  listAuditLogs: async () =>
    (await query(
      `SELECT event_id, event_type, scenario_id, payload, created_at
       FROM crm.decision_event WHERE event_type='config_change'
       ORDER BY created_at DESC LIMIT 20`
    )).rows,
  recordDecisionEvent,
  resolveMe,
};

export function createSystemSettingsRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const forbid = (res) => res.status(403).json({ error: '需要 sysadmin 权限' });

  const handlers = {
    // GET /api/config/system（sysadmin 读；未配置 → 404）
    get: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || me.role !== 'admin') return forbid(res);
        const rec = await D.readConfig('system');
        if (!rec) return res.status(404).json({ error: '系统设置未配置' });
        res.json({ key: 'system', value: rec.value, decision: rec.decision_id || null });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    // PUT /api/config/system（写经决策第0闸 + sysadmin + 字段白名单）
    put: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || me.role !== 'admin') return forbid(res);
        const { value } = req.body || {};
        if (value === undefined || value === null || typeof value !== 'object') {
          return res.status(400).json({ error: 'value 必填对象' });
        }
        const v = validateSystemSettingsPatch(value);
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
        const decision = await D.recordDecisionEvent('config_change', {
          type: 'system_settings_update',
          fields: Object.keys(v.normalized),
        });
        await D.writeConfig('system', v.normalized, decision?.event_id || null);
        res.json({ ok: true, key: 'system', value: v.normalized, decision: decision?.event_id || null, updated: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    // GET /api/config/system/audit-logs（只读，无写端点）
    getAuditLogs: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || me.role !== 'admin') return forbid(res);
        res.json({ logs: await D.listAuditLogs() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/system', handlers.get);
  router.put('/api/config/system', handlers.put);
  router.get('/api/config/system/audit-logs', handlers.getAuditLogs);
  router.handlers = handlers; // 注入式测试
  return router;
}