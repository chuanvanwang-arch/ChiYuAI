// src/http/dealerRoutes.js — 经销商渠道门户接入面（厂商侧管理 + 经销商侧只读共享视图）
// 设计输入：docs/2026-09-18-dealer-portal-design.md（v2 §13 契约）
// 铁律：写操作过决策第0闸；跨租户只读授权（federationReadScope）；绝不跨租户写（守 cross_tenant_write_denied）
// 工厂范式对齐 tenantRouter.js（{ deps } DI 友好 + router.handlers 测试接缝）
import { Router } from 'express';
import { query, queryWrite } from '../db.js';
import { resolveMe as realResolveMe } from './auth.js';
import { produceDecision } from '../calibration/store.js'; // 第0闸：经销商准入/冲突解决留痕为决策
import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js'; // 租户注册 + 差异化键播种
import { canManageDealers } from '../rbac.js'; // 厂商渠道管理闸（含 feature:dealer-portal 总闸）
import {
  createFederation, grantSharedView, listDealers, listConflicts, resolveConflict, getFederation,
} from '../federation/config.js';
import { federationReadScope } from '../federation/scope.js';
import { detectTerritoryConflict } from '../federation/conflict.js';
import { readConfig as _readConfig } from '../config/configStore.js';

export function createDealerRouter({ deps } = {}) {
  const defaultDeps = {
    // 厂商渠道管理闸：channel_manager/ten_admin + 总闸 on + 同一厂商租户
    ensureChannelManager: async (req, res) => {
      const me = realResolveMe(req);
      if (!me?.ok) { res.status(401).json({ error: me?.error || 'unauthorized' }); return null; }
      const vendorTenant = req.params?.vendorTenant || req.body?.vendorTenant || me.tenantId;
      const allowed = await canManageDealers(me, vendorTenant);
      if (!allowed) {
        res.status(403).json({ error: '仅厂商 channel_manager/ten_admin（且 feature:dealer-portal 已开）可管理经销商' });
        return null;
      }
      return { ...me, vendorTenant };
    },
    // 建经销商租户 + 首个 dealer_user 登录账号（复用 tenant 注册链路，杜绝 DELETE）
    createDealerTenant: async ({ tenantId, dealerUser, dealerPass }) => {
      const { rows } = await query(`SELECT 1 FROM crm.crm_users WHERE username=$1`, [dealerUser]);
      if (rows.length) throw new Error('经销商登录账号已存在');
      await seedTenantDefaults(tenantId, { all: true, createdBy: null }).catch((e) => {
        console.error(`[dealer-router] seedTenantDefaults 失败（建经销商租户继续）: ${e?.message || e}`);
      });
      const pw = await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [dealerPass]);
      await queryWrite(
        `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id)
         VALUES ($1, $2, 'dealer_user', $3, $4)`,
        [dealerUser, pw.rows[0].h, dealerUser, tenantId]
      );
      return { tenantId, dealerUser };
    },
    // 第0闸（默认真实实现，测试可注入）
    produceDecision,
    resolveConflict,
    // 经销商准入编排：建租户 + 建 1:N 联邦 + 双向共享视图授权（均带 decision_id 第0闸）
    onboardDealer: async ({ vendorTenant, dealerTenant, dealerUser, dealerPass, dealerName, region, level, rebatePolicyRef, createdBy }) => {
      const t = await defaultDeps.createDealerTenant({ tenantId: dealerTenant, dealerUser, dealerPass });
      const decision = await D.produceDecision({ scenario_id: 'config_change', fields: ['dealer-onboard:' + dealerTenant] });
      const decisionId = decision?.decisionId || null;
      // 1) 建 1:N 联邦主记录（vendor_tenant 持有）
      await createFederation(
        { vendorTenant, dealers: [{ dealer_tenant: dealerTenant, contract_ref: rebatePolicyRef || null }], decisionId }
      );
      // 2) push：厂商→经销商只读共享视图（政策/价表/返利/库存）
      await grantSharedView({
        vendorTenant, toTenant: dealerTenant, direction: 'push',
        particleTypes: ['CRM_OFFER_POLICY', 'MFG_REBATE', 'MFG_CHANNEL_STOCK', 'MFG_PROJECT'],
        decisionId,
      });
      // 3) reflow：经销商报备→厂商只读聚合（撞单/窜货检测数据源）
      await grantSharedView({
        vendorTenant, toTenant: dealerTenant, direction: 'reflow',
        particleTypes: ['MFG_PROJECT'], decisionId,
      });
      return { tenant: t, decisionId };
    },
  };
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  // POST /api/dealers/onboard — 厂商准入经销商（自动建独立租户 + 1:N 联邦 + 双向共享视图）
  // body: { vendorTenant, dealerTenant, dealerUser, dealerPass, dealerName, region, level?, rebatePolicyRef? }
  const hOnboard = async (req, res) => {
    const me = await D.ensureChannelManager(req, res); if (!me) return;
    const b = req.body || {};
    const { vendorTenant, dealerTenant, dealerUser, dealerPass, dealerName, region } = b;
    if (!vendorTenant || !dealerTenant || !dealerUser || !dealerPass || !dealerName || !region) {
      return res.status(400).json({ error: 'vendorTenant/dealerTenant/dealerUser/dealerPass/dealerName/region required' });
    }
    try {
      const r = await D.onboardDealer({
        vendorTenant, dealerTenant, dealerUser, dealerPass, dealerName, region,
        level: b.level, rebatePolicyRef: b.rebatePolicyRef,
        createdBy: me.username,
      });
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  };

  // GET /api/dealers?vendorTenant= — 厂商查名下经销商列表（读 tenant-federation 聚合）
  const hListDealers = async (req, res) => {
    const me = await D.ensureChannelManager(req, res); if (!me) return;
    try {
      const vendors = me.vendorTenant ? [me.vendorTenant] : (req.query.vendorTenant ? [req.query.vendorTenant] : null);
      if (!vendors) return res.status(400).json({ error: 'vendorTenant required' });
      const out = [];
      for (const v of vendors) out.push(...(await listDealers(v)));
      res.json({ dealers: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };

  // GET /api/dealers/conflicts?vendorTenant= — 厂商查跨 N 经销商的撞单/窜货冲突日志
  const hListConflicts = async (req, res) => {
    const me = await D.ensureChannelManager(req, res); if (!me) return;
    const vendorTenant = me.vendorTenant || req.query.vendorTenant;
    if (!vendorTenant) return res.status(400).json({ error: 'vendorTenant required' });
    try { res.json({ conflicts: await listConflicts(vendorTenant) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  };

  // POST /api/dealers/conflicts/:id/resolve — 厂商仲裁解决冲突（带 decision_id 第0闸 + 写 resolved）
  const hResolveConflict = async (req, res) => {
    const me = await D.ensureChannelManager(req, res); if (!me) return;
    const { id } = req.params;
    const { resolution } = req.body || {};
    try {
      const decision = await D.produceDecision({ scenario_id: 'channel_conflict_resolve', fields: ['conflict:' + id] });
      const updated = await D.resolveConflict({ vendorTenant: me.vendorTenant, conflictId: id, resolution, decisionId: decision?.decisionId || null });
      if (!updated) return res.status(404).json({ error: '冲突记录不存在' });
      res.json({ ok: true, conflict: updated, decisionId: decision?.decisionId || null });
    } catch (e) { res.status(400).json({ error: e.message }); }
  };

  // GET /api/dealers/shared-view — 经销商查厂商下发的共享视图（federationReadScope 只读聚合）
  //   经销商自带租户 token；作用域解析出 [自身, 厂商]（数组）；只读，绝不写厂商
  const hSharedView = async (req, res) => {
    const me = realResolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: me?.error || 'unauthorized' });
    if (me.role !== 'dealer_user') return res.status(403).json({ error: '仅经销商账号可查共享视图' });
    try {
      const scope = await federationReadScope(me.tenantId); // 数组：[自身, 厂商]
      const fed = await getFederation(me.tenantId);
      const vendor = fed?.vendor_tenant || null;
      const grants = vendor
        ? ((await _readConfig('shared-view-grant', { tenantId: vendor }))?.value || [])
        : [];
      res.json({ actorTenant: me.tenantId, readableTenants: scope, vendorTenant: vendor, grants });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };

  // GET /api/dealers/shared-views?vendorTenant= — 厂商查已下发的共享视图配置（政策/价表/返利/库存）
  const hSharedViews = async (req, res) => {
    const me = await D.ensureChannelManager(req, res); if (!me) return;
    const vendorTenant = me.vendorTenant || req.query.vendorTenant;
    if (!vendorTenant) return res.status(400).json({ error: 'vendorTenant required' });
    try {
      const { readConfig } = await import('../config/configStore.js');
      const row = await readConfig('shared-view-grant', { tenantId: vendorTenant });
      res.json({ grants: row?.value?.grants || [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };

  router.post('/api/dealers/onboard', hOnboard);
  router.get('/api/dealers', hListDealers);
  router.get('/api/dealers/conflicts', hListConflicts);
  router.post('/api/dealers/conflicts/:id/resolve', hResolveConflict);
  router.get('/api/dealers/shared-view', hSharedView);
  router.get('/api/dealers/shared-views', hSharedViews);

  // 测试接缝：暴露原始 handler（DI 测试免 DB 直接调用）
  router.handlers = { hOnboard, hListDealers, hListConflicts, hResolveConflict, hSharedView, hSharedViews };
  router.onboardDealer = D.onboardDealer;
  router.ensureChannelManager = D.ensureChannelManager;
  return router;
}
