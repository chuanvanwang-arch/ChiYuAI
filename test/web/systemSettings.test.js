// test/web/systemSettings.test.js — 第 28 项 系统设置配置（S33）TDD 测试
// 注入式 handler（router.handlers）+ 假 deps，不依赖真实库；范式对齐 userManagement.test.js（21 例）
// 红线校验：写经决策第0闸（config_change）、非 sysadmin 写 403、字段白名单、审计日志只读
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateSystemSettingsPatch,
  renderSystemSettings,
  renderAuditLogs,
  createSystemSettingsRouter,
} from '../../src/portal/systemSettings.js';

// —— 纯函数：validateSystemSettingsPatch ——
describe('validateSystemSettingsPatch', () => {
  it('合法：site_name+default_theme+session_timeout+security_policy 全部通过', () => {
    const r = validateSystemSettingsPatch({
      site_name: 'CRM 平台', default_theme: 'dark', session_timeout: 120,
      security_policy: { password_min_len: 8, mfa_required: true, allow_external_login: false },
    });
    expect(r.ok).toBe(true);
    expect(r.normalized.default_theme).toBe('dark');
    expect(r.normalized.security_policy.mfa_required).toBe(true);
  });
  it('site_name 空 → 拒绝', () => {
    expect(validateSystemSettingsPatch({ site_name: '' }).ok).toBe(false);
    expect(validateSystemSettingsPatch({}).ok).toBe(false);
  });
  it('default_theme 非 light/dark → 拒绝', () => {
    expect(validateSystemSettingsPatch({ site_name: 'x', default_theme: 'blue' }).ok).toBe(false);
  });
  it('session_timeout 非整数/越界 → 拒绝', () => {
    expect(validateSystemSettingsPatch({ site_name: 'x', session_timeout: 30 }).ok).toBe(false);
    expect(validateSystemSettingsPatch({ site_name: 'x', session_timeout: 9999 }).ok).toBe(false);
    expect(validateSystemSettingsPatch({ site_name: 'x', session_timeout: 12.5 }).ok).toBe(false);
  });
  it('security_policy 未知键 → 拒绝', () => {
    const r = validateSystemSettingsPatch({
      site_name: 'x', security_policy: { password_min_len: 8, evil_key: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/security_policy|未知/);
  });
  it('未知字段 → 拒绝', () => {
    const r = validateSystemSettingsPatch({ site_name: 'x', evil: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/不可编辑|未知/);
  });
});

// —— 纯函数：renderSystemSettings ——
describe('renderSystemSettings', () => {
  it('渲染各字段值', () => {
    const html = renderSystemSettings({ site_name: 'CRM 平台', default_theme: 'dark', session_timeout: 120 });
    expect(html).toContain('CRM 平台');
    expect(html).toContain('dark');
  });
  it('空 → 降级', () => {
    expect(renderSystemSettings(null)).toContain('未配置');
  });
});

// —— 纯函数：renderAuditLogs ——
describe('renderAuditLogs', () => {
  it('渲染审计日志行', () => {
    const html = renderAuditLogs([
      { event_id: 'e1', event_type: 'config_change', scenario_id: 'system', payload: { type: 'system_settings_update' }, created_at: new Date() },
    ]);
    expect(html).toContain('system_settings_update');
    expect(html).toContain('e1');
  });
  it('空 → 降级', () => {
    expect(renderAuditLogs([])).toContain('无审计日志');
  });
});

// —— handler（fake deps，不触真实库）——
function makeDeps() {
  const recordDecisionEvent = vi.fn(async () => ({ event_id: 'ev-x' }));
  const resolveMe = vi.fn(async () => ({ ok: true, role: 'admin', display_name: 'Admin', username: 'admin' }));
  const readConfig = vi.fn(async (key) => {
    if (key !== 'system') return null;
    return { value: { site_name: 'CRM 平台', default_theme: 'light', session_timeout: 120 }, decision_id: 'd-old' };
  });
  const writeConfig = vi.fn(async (key, value, decisionId) => ({ key, ok: true }));
  const listAuditLogs = vi.fn(async () => [
    { event_id: 'e1', event_type: 'config_change', scenario_id: 'system', payload: { type: 'system_settings_update' }, created_at: new Date() },
  ]);
  return { recordDecisionEvent, resolveMe, readConfig, writeConfig, listAuditLogs };
}

describe('createSystemSettingsRouter handlers', () => {
  let d, router;
  beforeEach(() => {
    d = makeDeps();
    router = createSystemSettingsRouter(d);
  });

  it('GET /api/config/system → 当前系统设置', async () => {
    let body;
    await router.handlers.get({}, { json: (o) => (body = o) });
    expect(body.value.site_name).toBe('CRM 平台');
    expect(body.decision).toBe('d-old');
  });

  it('GET 未配置 → 404', async () => {
    d.readConfig.mockResolvedValueOnce(null);
    let status;
    await router.handlers.get({}, { json: () => {}, status: (s) => ((status = s), { json: () => {} }) });
    expect(status).toBe(404);
  });

  it('PUT /api/config/system → 落库 + 决策第0闸', async () => {
    let body;
    const req = { body: { value: { site_name: '新平台名', default_theme: 'dark', session_timeout: 180 } } };
    await router.handlers.put(req, { json: (o) => (body = o) });
    expect(body.ok).toBe(true);
    expect(d.writeConfig).toHaveBeenCalledWith('system', expect.objectContaining({ site_name: '新平台名' }), 'ev-x');
    expect(d.recordDecisionEvent).toHaveBeenCalledWith('config_change', expect.objectContaining({ type: 'system_settings_update' }));
  });

  it('PUT 非法字段 → 400', async () => {
    let status;
    await router.handlers.put(
      { body: { value: { site_name: '', default_theme: 'blue' } } },
      { json: () => {}, status: (s) => ((status = s), { json: () => {} }) }
    );
    expect(status).toBe(400);
  });

  it('非 sysadmin 写 → 403', async () => {
    d.resolveMe.mockResolvedValueOnce({ ok: true, role: 'sales' });
    let status, statusBody;
    await router.handlers.put(
      { body: { value: { site_name: 'x' } } },
      { json: () => {}, status: (s) => ((status = s), { json: (o) => ((statusBody = o), null) }) }
    );
    expect(status).toBe(403);
    expect(statusBody.error).toMatch(/sysadmin|权限/);
  });

  it('GET /api/config/system/audit-logs → 审计日志（只读）', async () => {
    let body;
    await router.handlers.getAuditLogs({}, { json: (o) => (body = o) });
    expect(body.logs.length).toBe(1);
    expect(body.logs[0].payload.type).toBe('system_settings_update');
  });
});