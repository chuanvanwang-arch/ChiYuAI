// src/http/billingRoutes.js — 平台级计费域 HTTP 端点
// 设计基线：docs/2026-09-04-tenant-billing-page-design.md
// 端点：
//   GET  /api/billing/plans                (公开只读) 档位 + 计费设置
//   POST /api/admin/tenant-plan            (admin/sysadmin) 设定租户生效档位（tenants.plan）
//   GET  /api/billing/summary              (自助：本租户；admin 集中：全量/指定租户) 本期账单明细
//   POST /api/billing/statement/issue      (admin/sysadmin) 出账
//   GET  /api/billing/reconcile            (admin/sysadmin) 对账聚合
//   GET  /api/billing/export               (admin/sysadmin，scope 感知) 导出 CSV
//   POST /api/billing/pay                  (本租户缴费；admin 可代付) 平台内缴费流
// 租户隔离：读经 applyTenantOverride(req,me) 收敛；写经 scopeTenant(me) 强制本租户
import express from 'express';
import { query, queryWrite } from '../db.js';
import { readConfig, writeConfig } from '../config/configStore.js';
import { assignIndustry, removeIndustry } from '../config/profileMerger.js';
import { resolveMe } from './auth.js';
import { applyTenantOverride, scopeTenant } from './tenantScope.js';
import { resolveEntitlements } from '../billing/entitlements.js';
import { validatePlans, KNOWN_ENTITLEMENTS, entitlementCatalog } from '../billing/planSchema.js';
import {
  computeStatement, issueStatement, flipOverdue, pay, reconcile, exportCsv,
  tokenQuota, tokenByAccount, tokenByAction,
  updateBillingPlans, updateBillingSettings,
} from '../billing/billingService.js';
import { produceDecision } from '../calibration/store.js';

// settings.billing_intro 的兜底默认（仅在 settings 字段整体缺失时补，绝不覆盖现网）
//   单一事实源 = pricing.billing_intro_defaults，与 landing.html / billing.html 的前端 fallback 一致
const BILLING_INTRO_DEFAULTS = Object.freeze({
  headline: '套餐',
  subtitle: '档位与价格均由后台配置驱动（配置中心 · 套餐管理），改配置即改页面。',
  legend: [
    '档位与价格均由后台配置（配置中心 · 套餐管理）驱动',
    '功能权益按档解锁，不为「AI 加价」单独收费',
    '私有化与定制需求请联系我们另行报价',
  ],
});

function withBillingIntroDefaults(s) {
  const base = (s && typeof s === 'object') ? s : {};
  if (base.billing_intro && typeof base.billing_intro === 'object') return base;
  return { ...base, billing_intro: { ...BILLING_INTRO_DEFAULTS } };
}

function isPrivileged(me) {
  return me && (me.role === 'admin' || me.role === 'sysadmin' || me.role === 'ten_admin');
}
function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

export function createBillingRouter() {
  const router = express.Router();

  // T2：档位 + 计费设置（公开只读，前端渲染功能矩阵用）
  router.get('/api/billing/plans', async (req, res) => {
    try {
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
      // known_entitlements：套餐表单权益勾选清单（单一事实源=planSchema 白名单，前端动态渲染不硬编码）
      // entitlement_catalog：权益 key→中文标签目录（单一事实源=planSchema，前端矩阵不得硬编码标签）
      res.json({
        plans: plansRow?.value || [],
        settings: withBillingIntroDefaults(settingsRow?.value),
        known_entitlements: KNOWN_ENTITLEMENTS,
        entitlement_catalog: entitlementCatalog(),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T3：admin/sysadmin 设定租户生效档位（零信任：仅角色闸，无决策第0闸——属配置面管理操作，由调用方经平台管理插件护持）
  router.post('/api/admin/tenant-plan', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, planId } = req.body || {};
    if (!tenantId || !planId) return res.status(400).json({ error: 'tenantId & planId required' });
    // 2026-09-06 收紧（P1）：① 写走写池 queryWrite（原误用读池 query）；② 校验 planId 必须真实存在
    //   ——此前可把租户设成任意字符串，随后 getPlan 静默回退 plans[0]（免费档）→ 权益被悄悄降级。
    try {
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
      if (!plans.some((p) => p.plan_id === planId)) {
        return res.status(400).json({ error: `planId 不存在：${planId}（可选：${plans.map((p) => p.plan_id).join(',')}）` });
      }
      const r = await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [tenantId, planId]);
      res.json({ ok: true, updated: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T4：账单汇总（自助 + 集中）
  router.get('/api/billing/summary', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = applyTenantOverride(req, me); // '*' 或具体租户
    const period = req.query.period || currentPeriod();
    try {
      await flipOverdue();
      const tenants = scope === '*'
        ? (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map((r) => r.tenant_id)
        : [scope];
      const rows = [];
      for (const t of tenants) rows.push(await computeStatement(t, period));
      res.json({ rows, period });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T4：出账（admin/sysadmin）
  router.post('/api/billing/statement/issue', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, period, cycle } = req.body || {};
    if (!tenantId || !period) return res.status(400).json({ error: 'tenantId & period required' });
    try {
      const s = await issueStatement(tenantId, period, cycle);
      res.json({ ok: true, statement: s });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T4：对账聚合（admin/sysadmin）
  router.get('/api/billing/reconcile', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const period = req.query.period || currentPeriod();
    try {
      await flipOverdue();
      res.json({ rows: await reconcile(period), period });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T4：导出 CSV（admin/sysadmin，scope 感知：admin 可 ?tenant= 收窄，普通不可越权已由 applyTenantOverride 强制）
  router.get('/api/billing/export', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const scope = applyTenantOverride(req, me);
    const period = req.query.period || currentPeriod();
    try {
      const csv = await exportCsv(period, scope);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="billing-${period}.csv"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T4：缴费（平台内缴费流：插入 billing_payment + 状态机流转）
  router.post('/api/billing/pay', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = scopeTenant(me); // 普通用户仅本租户；admin '*'
    const { statementId, method, note, txn_ref } = req.body || {};
    if (!statementId) return res.status(400).json({ error: 'statementId required' });
    try {
      const st = await query(`SELECT tenant_id FROM crm.billing_statement WHERE id=$1`, [statementId]);
      if (!st.rows[0]) return res.status(404).json({ error: 'not found' });
      if (scope !== '*' && st.rows[0].tenant_id !== scope) {
        return res.status(403).json({ error: 'cannot pay other tenant' });
      }
      const r = await pay(statementId, { method, note, txn_ref });
      res.json(r);
    } catch (e) {
      if (e.message === 'statement not found') return res.status(404).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // T4：套餐档位 CRUD（admin/sysadmin，零信任决策第0闸由调用方/页面 HITL 护持；禁物理删——enabled 软停用；INSERT..ON CONFLICT 幂等）
  router.post('/api/admin/billing-plans', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { plans } = req.body || {};
    if (!Array.isArray(plans) || !plans.length) return res.status(400).json({ error: 'plans array required' });
    // schema 校验闸（2026-09-05 表单化配套）：plan_id 查重/数值合法/权益白名单/超量模式枚举，fail-closed
    const v = validatePlans(plans);
    if (!v.ok) {
      return res.status(400).json({ error: '套餐校验失败：' + v.errors.join('；'), details: v.errors });
    }
    try {
      const r = await updateBillingPlans(plans, me.username || 'admin');
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T4：计费设置维护（含 stripe 凭据，admin/sysadmin；禁物理删）
  router.post('/api/admin/billing-settings', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { settings } = req.body || {};
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required' });
    try {
      const r = await updateBillingSettings(settings, me.username || 'admin');
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // T5：Token 额度/使用明细（租户隔离：自助=本租户，admin=可指定/全量）
  router.get('/api/billing/token-usage', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = applyTenantOverride(req, me);
    const period = req.query.period || currentPeriod();
    try {
      if (scope === '*') {
        const tenants = (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map((r) => r.tenant_id);
        const tenantsOut = [];
        for (const t of tenants) {
          tenantsOut.push({
            tenant_id: t,
            quota: await tokenQuota(t, period),
            byAccount: await tokenByAccount(t, period),
            byAction: await tokenByAction(t, period),
          });
        }
        return res.json({ period, scope, tenants: tenantsOut });
      }
      return res.json({
        period, scope,
        quota: await tokenQuota(scope, period),
        byAccount: await tokenByAccount(scope, period),
        byAction: await tokenByAction(scope, period),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 当前订阅（租户自助；返回档/到期/状态/剩余天数）
  router.get('/api/billing/subscription', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = scopeTenant(me);           // 自助仅本租户
    try {
      const tenants = scope === '*' ? (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map(r => r.tenant_id) : [scope];
      const rows = [];
      for (const t of tenants) {
        const s = await query(`SELECT * FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [t]);
        if (s.rows[0]) rows.push(s.rows[0]);
      }
      res.json({ rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 管理台租户订阅全景（admin/sysadmin）：列出全部租户，含推荐人、生效套餐、订阅到期、席位/Token 用量 + 行业画像概要
  router.get('/api/billing/tenant-subscriptions', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const scope = applyTenantOverride(req, me);
    const period = req.query.period || currentPeriod();
    try {
      const { computeLiveCost } = await import('../billing/subscriptionService.js');
      const tq = scope === '*' ? '' : `WHERE tenant_id=$1`;
      const tenants = await query(`SELECT tenant_id, name, status, plan, created_by_username FROM crm.tenants ${tq} ORDER BY created_at DESC`, scope === '*' ? [] : [scope]);
      // 批量取行业画像（避免 N+1）：tenant_id -> { industries:[{id,label}] }
      // v2（industries 数组）→ 抽 id/label；v1（无 industries）→ 退化单 legacy chip
      const profRows = await query(
        `SELECT tenant_id,
           CASE WHEN jsonb_typeof(value->'industries') = 'array' THEN
             (SELECT jsonb_agg(jsonb_build_object('id', e->>'id', 'label', e->>'label'))
              FROM jsonb_array_elements(value->'industries') e)
           ELSE
             jsonb_build_array(jsonb_build_object('id','legacy','label', coalesce(value->'meta'->>'industry_label','—')))
           END AS industries
         FROM crm.config_store WHERE key='tenant-profile' AND tenant_id = ANY($1)`,
        [tenants.rows.map((t) => t.tenant_id)]);
      const profMap = new Map(profRows.rows.map((r) => [r.tenant_id, { industries: Array.isArray(r.industries) ? r.industries : [] }]));
      const rows = [];
      for (const t of tenants.rows) {
        const s = await query(`SELECT plan_id, status, started_at, expires_at, grace_until, upgraded_from FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [t.tenant_id]);
        rows.push({
          tenant_id: t.tenant_id,
          tenant_name: t.name,
          tenant_status: t.status,
          referrer: t.created_by_username || null,
          tenant_plan: t.plan || null,
          subscription: s.rows[0] || null,
          live_cost: await computeLiveCost(t.tenant_id),
          quota: await tokenQuota(t.tenant_id, period),
          profile_summary: profMap.get(t.tenant_id) || null,
        });
      }
      res.json({ rows, period, scope });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 行业画像模板清单（admin/sysadmin 只读）
  router.get('/api/billing/tenant-admin/profile-templates', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    try {
      const rows = (await query(
        `SELECT key, value FROM crm.config_store WHERE tenant_id='system' AND key LIKE 'tenant-profile-template-%'`
      )).rows;
      const templates = rows.map((r) => {
        const v = r.value || {};
        const id = String(r.key).replace('tenant-profile-template-', '');
        const protos = v.prototypes && typeof v.prototypes === 'object' ? Object.keys(v.prototypes).length : 0;
        return { template_id: id, industry_label: (v.meta && v.meta.industry_label) || id, prototype_count: protos };
      });
      res.json({ templates });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 租户管理操作台（admin/sysadmin；第0闸 produceDecision；system 硬拒；幂等）──
  // 第0闸：写前落真实决策行；失败则整动作失败（不半截提交）。ctx.by_id/by_role 取自登录身份。
  async function gateDecision(me, fields) {
    const d = await produceDecision({ fields, by_id: me?.username, by_role: me?.role || 'sysadmin' });
    return d?.decisionId || null;
  }

  router.post('/api/billing/tenant-admin/freeze', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, reason } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可冻结' });
    try {
      const cur = (await query(`SELECT status FROM crm.tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'tenant not found' });
      if (cur.status === 'retired') return res.status(400).json({ error: 'retired 租户不可冻结（终态）' });
      if (cur.status === 'suspended') return res.json({ ok: true, noop: true, status: 'suspended' });
      await gateDecision(me, [`tenant:${tenantId}`, 'freeze', reason || ''].filter(Boolean));
      const r = await queryWrite(`UPDATE crm.tenants SET status='suspended', suspended_at=now() WHERE tenant_id=$1`, [tenantId]);
      res.json({ ok: true, updated: r.rowCount, status: 'suspended' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/unfreeze', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    try {
      const cur = (await query(`SELECT status FROM crm.tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'tenant not found' });
      if (cur.status === 'retired') return res.status(400).json({ error: 'retired 租户不可解冻（终态）' });
      if (cur.status === 'active') return res.json({ ok: true, noop: true, status: 'active' });
      await gateDecision(me, [`tenant:${tenantId}`, 'unfreeze']);
      const r = await queryWrite(`UPDATE crm.tenants SET status='active', suspended_at=NULL WHERE tenant_id=$1`, [tenantId]);
      res.json({ ok: true, updated: r.rowCount, status: 'active' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/extend', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, days } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (days === null || days === undefined) return res.status(400).json({ error: 'days required' });
    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 365) return res.status(400).json({ error: 'days 须为 1-365 整数' });
    try {
      const sub = (await query(`SELECT id, status FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [tenantId])).rows[0];
      if (!sub) return res.status(400).json({ error: '该租户无订阅记录，无法延期（请先开通订阅）' });
      await gateDecision(me, [`tenant:${tenantId}`, `extend:${d}d`]);
      const r = await queryWrite(`UPDATE crm.tenant_subscription SET expires_at = expires_at + ($1)::interval, updated_at=now() WHERE id=$2`, [d + ' days', sub.id]);
      res.json({ ok: true, updated: r.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/cancel', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, reason } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可退订' });
    try {
      const cur = (await query(`SELECT status FROM crm.tenants WHERE tenant_id=$1`, [tenantId])).rows[0];
      if (!cur) return res.status(404).json({ error: 'tenant not found' });
      if (cur.status === 'retired') return res.json({ ok: true, noop: true, status: 'retired' });
      await gateDecision(me, [`tenant:${tenantId}`, 'cancel', reason || ''].filter(Boolean));
      const r1 = await queryWrite(`UPDATE crm.tenants SET status='retired', retired_at=now() WHERE tenant_id=$1`, [tenantId]);
      const r2 = await queryWrite(`UPDATE crm.tenant_subscription SET status='canceled', updated_at=now() WHERE tenant_id=$1 AND status IN ('active','grace')`, [tenantId]);
      res.json({ ok: true, tenantUpdated: r1.rowCount, subCancelled: r2.rowCount, status: 'retired' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/change-plan', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, planId } = req.body || {};
    if (!tenantId || !planId) return res.status(400).json({ error: 'tenantId & planId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可改套餐' });
    try {
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
      if (!plans.some((p) => p.plan_id === planId)) return res.status(400).json({ error: `planId 不存在：${planId}` });
      await gateDecision(me, [`tenant:${tenantId}`, `plan->${planId}`]);
      await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [tenantId, planId]);
      await queryWrite(`UPDATE crm.tenant_subscription SET status='canceled' WHERE tenant_id=$1 AND status IN ('active','grace')`, [tenantId]);
      await queryWrite(
        `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, started_at, expires_at, upgraded_from)
         VALUES ($1,$2,'active',now(),now()+'1 month','admin-grant')`, [tenantId, planId]);
      res.json({ ok: true, plan: planId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/billing/tenant-admin/assign-profile', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, templateIds } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可分配画像' });
    const ids = Array.isArray(templateIds) ? templateIds : (templateIds ? [templateIds] : []);
    if (!ids.length) return res.status(400).json({ error: 'templateIds required' });
    try {
      // 读取现有（原始，不走 readConfig 自动合并）
      const cur = (await query(`SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [tenantId])).rows[0];
      const rawValue = cur ? cur.value : null;
      let next = rawValue;
      let merge_meta = { conflict_keys: [] };
      let skippedAll = true;
      for (const templateId of ids) {
        const tpl = (await query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key=$1`, ['tenant-profile-template-' + templateId])).rows[0];
        if (!tpl) return res.status(400).json({ error: `模板不存在：${templateId}` });
        const dId = await gateDecision(me, [`tenant:${tenantId}`, `profile+=${templateId}`]);
        const r = assignIndustry(next, { template: tpl.value, templateId, decisionId: dId });
        next = r.next;
        merge_meta = r.merge_meta;
        if (!r.skipped) skippedAll = false;
      }
      await writeConfig('tenant-profile', next, { tenantId, decisionId: null, updatedBy: 'admin' });
      res.json({ ok: true, skipped: skippedAll, industries: (next.industries || []).map((i) => ({ id: i.id, label: i.label })), merge_meta });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 移除某一行业画像（软移除：drop industries 元素 + 整体 UPDATE；禁物理 DELETE）
  router.post('/api/billing/tenant-admin/remove-profile', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, industryId } = req.body || {};
    if (!tenantId || !industryId) return res.status(400).json({ error: 'tenantId & industryId required' });
    if (tenantId === 'system') return res.status(400).json({ error: 'system 租户不可移除画像' });
    try {
      const cur = (await query(`SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [tenantId])).rows[0];
      if (!cur) return res.status(400).json({ error: '该租户无画像' });
      await gateDecision(me, [`tenant:${tenantId}`, `profile-=${industryId}`]);
      let next, removed;
      try {
        ({ next, removed } = removeIndustry(cur.value, industryId));
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.startsWith('INDUSTRY_NOT_FOUND')) return res.status(400).json({ error: `行业不存在：${industryId}` });
        if (msg.startsWith('INVALID_PROFILE')) return res.status(400).json({ error: '画像格式非法（非 v2）' });
        throw e;
      }
      await writeConfig('tenant-profile', next, { tenantId, decisionId: null, updatedBy: 'admin' });
      res.json({ ok: true, removed: { id: removed.id, label: removed.label }, industries: (next.industries || []).map((i) => ({ id: i.id, label: i.label })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 创建/续费/升级 → 国内网关（微信/支付宝）默认；stripe 仅 enabled 时可选
  router.post('/api/billing/subscribe', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const { tenantId, planId, cycle = 'monthly', mode = 'upgrade', provider } = req.body || {};
    if (!tenantId || !planId) return res.status(400).json({ error: 'tenantId & planId required' });
    const scope = scopeTenant(me);
    if (scope !== '*' && scope !== tenantId) return res.status(403).json({ error: 'cannot subscribe other tenant' });
    try {
      const { createPayment, loadSettings } = await import('../billing/domesticGateway.js');
      const s = await loadSettings();
      const prov = provider || s.default_provider || 'wechat';
      if (prov === 'stripe') {
        if (!s.stripe?.enabled) return res.status(403).json({ error: 'stripe disabled' });
        const { buildCheckoutSession } = await import('../billing/stripeGateway.js');
        const session = await buildCheckoutSession(planId, cycle, tenantId, mode);
        return res.json({ ok: true, provider: 'stripe', url: session.url, session_id: session.id });
      }
      const pay = await createPayment({ provider: prov, planId, cycle, tenantId, mode });
      if (pay.disabled) return res.status(403).json({ error: 'provider disabled', provider: pay.provider });
      return res.json({ ok: true, ...pay });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 微信支付异步通知（验签+解密 → 落 payment_order → 状态机）
  router.post('/api/billing/wechat/notify', async (req, res) => {
    try {
      const { verifyWechatNotify, markOrderPaid, applyPaymentResult } = await import('../billing/domesticGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.wechat || {};
      const rawBodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
      const dec = await verifyWechatNotify(req.headers, rawBodyStr, { apiV3Key: s.api_v3_key, platformCertPem: s.platform_cert_pem });
      if (!dec) return res.status(400).json({ error: 'invalid signature' });
      if (dec.trade_state === 'SUCCESS') {
        const po = await query(`SELECT tenant_id, plan_id, mode FROM crm.payment_order WHERE out_trade_no=$1`, [dec.out_trade_no]);
        if (po.rows[0]) {
          await markOrderPaid(dec.out_trade_no);
          await applyPaymentResult({ tenantId: po.rows[0].tenant_id, planId: po.rows[0].plan_id, mode: po.rows[0].mode, outTradeNo: dec.out_trade_no });
        }
      }
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 支付宝异步通知（验签 → 落 payment_order → 状态机）
  router.post('/api/billing/alipay/notify', async (req, res) => {
    try {
      const { verifyAlipayNotify, markOrderPaid, applyPaymentResult } = await import('../billing/domesticGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.alipay || {};
      const dec = await verifyAlipayNotify(req.body || {}, { alipayPubKey: s.alipay_public_key });
      if (!dec) return res.status(400).json({ error: 'invalid signature' });
      if (dec.trade_status === 'TRADE_SUCCESS' || dec.trade_status === 'TRADE_FINISHED') {
        const po = await query(`SELECT tenant_id, plan_id, mode FROM crm.payment_order WHERE out_trade_no=$1`, [dec.out_trade_no]);
        if (po.rows[0]) {
          await markOrderPaid(dec.out_trade_no);
          await applyPaymentResult({ tenantId: po.rows[0].tenant_id, planId: po.rows[0].plan_id, mode: po.rows[0].mode, outTradeNo: dec.out_trade_no });
        }
      }
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 退款（admin/sysadmin）：调网关退款 + 写 refunded + 订阅转 grace（fail-open）
  router.post('/api/billing/refund', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { outTradeNo, reason } = req.body || {};
    if (!outTradeNo) return res.status(400).json({ error: 'outTradeNo required' });
    try {
      const { requestRefund } = await import('../billing/refundService.js');
      const r = await requestRefund({ outTradeNo, reason });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 微信退款回调（验签+解密 → 标记 refunded）
  router.post('/api/billing/wechat/refund-notify', async (req, res) => {
    try {
      const { verifyWechatNotify, markOrderRefunded } = await import('../billing/domesticGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.wechat || {};
      const rawBodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});
      const dec = await verifyWechatNotify(req.headers, rawBodyStr, { apiV3Key: s.api_v3_key, platformCertPem: s.platform_cert_pem });
      if (!dec) return res.status(400).json({ error: 'invalid signature' });
      if (dec.trade_state === 'REFUND.SUCCESS') await markOrderRefunded(dec.out_trade_no);
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 支付宝退款回调（验签 → 标记 refunded）
  router.post('/api/billing/alipay/refund-notify', async (req, res) => {
    try {
      const { verifyAlipayNotify, markOrderRefunded } = await import('../billing/domesticGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.alipay || {};
      const dec = await verifyAlipayNotify(req.body || {}, { alipayPubKey: s.alipay_public_key });
      if (!dec) return res.status(400).json({ error: 'invalid signature' });
      if (dec.trade_status === 'TRADE_SUCCESS' || dec.trade_status === 'TRADE_FINISHED') await markOrderRefunded(dec.out_trade_no);
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 开发期模拟支付确认（simulate 模式）
  router.post('/api/billing/subscribe/simulate-confirm', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const { order } = req.body || {};
    if (!order) return res.status(400).json({ error: 'order required' });
    const scope = scopeTenant(me);
    if (scope !== '*' && scope !== order.tenantId) return res.status(403).json({ error: 'cannot confirm other tenant' });
    try {
      const { applyPaymentResult } = await import('../billing/domesticGateway.js');
      const r = await applyPaymentResult(order);
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Stripe webhook（验签 → 状态机 → 缴费即开通）
  router.post('/api/billing/stripe/webhook', async (req, res) => {
    try {
      const { verifyWebhook, handleCheckoutCompleted } = await import('../billing/stripeGateway.js');
      const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value?.stripe || {};
      const raw = req.rawBody || JSON.stringify(req.body);
      const sig = (req.headers['stripe-signature'] || '').split(',')[0];
      if (!(await verifyWebhook(raw, sig, s.webhook_secret))) return res.status(400).json({ error: 'invalid signature' });
      const evt = req.body;
      if (evt?.type === 'checkout.session.completed') {
        await handleCheckoutCompleted(evt.data?.object || {});
      }
      res.json({ received: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 实时费用
  router.get('/api/billing/live-cost', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = scopeTenant(me);
    try {
      const { computeLiveCost } = await import('../billing/subscriptionService.js');
      const tenants = scope === '*' ? (await query(`SELECT tenant_id FROM crm.tenants WHERE status='active'`)).rows.map(r => r.tenant_id) : [scope];
      const rows = [];
      for (const t of tenants) rows.push(await computeLiveCost(t));
      res.json({ rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 模块用量 + 开关（自助读 / admin 写）
  router.get('/api/billing/module-usage', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
    const scope = applyTenantOverride(req, me);
    try {
      const rows = scope === '*'
        ? (await query(`SELECT module, enabled, calls, tokens_in, tokens_out, period FROM crm.module_usage ORDER BY module`)).rows
        : (await query(`SELECT module, enabled, calls, tokens_in, tokens_out, period FROM crm.module_usage WHERE tenant_id=$1 ORDER BY module`, [scope])).rows;
      res.json({ rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/api/billing/module-usage/toggle', async (req, res) => {
    const me = resolveMe(req);
    if (!isPrivileged(me)) return res.status(403).json({ error: 'forbidden' });
    const { tenantId, module, enabled } = req.body || {};
    if (!tenantId || !module) return res.status(400).json({ error: 'tenantId & module required' });
    try {
      await queryWrite(`UPDATE crm.module_usage SET enabled=$3, updated_at=now() WHERE tenant_id=$1 AND module=$2`, [tenantId, module, !!enabled]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 当前租户权益集（前端导航门禁消费）
  router.get('/api/billing/entitlements', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: 'unauthorized' });
      const scope = applyTenantOverride(req, me); // 自助=本租户；admin='*' 时取自身租户
      const tid = scope === '*' ? (me.tenantId || 'system') : scope;
      const ents = await resolveEntitlements(tid);
      const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tid]);
      const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
      const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
      const plan = plans.find((p) => p.plan_id === t.rows[0]?.plan) || plans[0] || {};
      res.json({ tenant_id: tid, plan_id: plan.plan_id, plan_name: plan.name, entitlements: [...ents] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
