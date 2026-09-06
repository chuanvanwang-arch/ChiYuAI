// src/http/tenantRouter.js — 租户管理面（admin/sysadmin 闸 + 决策第0闸）
// 设计输入：docs/2026-08-31-multi-tenant-design.md（system=种子租户；租户创建=插 crm_users，配置留空走 read-fallback）
// 禁删铁律：建租户只 INSERT 新用户（tenant_id=新租户），绝不 DELETE/TRUNCATE；系统配置不预置（回退 system 默认）。
import { Router } from 'express';
import { query, queryWrite } from '../db.js';
import { resolveMe as realResolveMe } from './auth.js';
import { produceDecision } from '../calibration/store.js'; // 第0闸：建租户记为 config_change 决策（审计留痕）
import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js'; // T10：租户注册 + 差异化键播种（生命周期 §3.4.2）
import { resolveSysadminRef } from '../rbac.js'; // 责任 sysadmin 归属解析（设计 §D2）

export function createTenantRouter({ deps } = {}) {
  const defaultDeps = {
    // admin/sysadmin 跨租户；普通用户拒（403）
    ensureAdmin: async (req, res) => {
      const me = realResolveMe(req); // 同步返回 {ok:false} 或 {ok:true, role, ...}
      if (!me?.ok || (me.role !== 'admin' && me.role !== 'sysadmin')) {
        res.status(403).json({ error: '需要 admin 权限' });
        return null;
      }
      return me;
    },
    // 建租户=插新 admin 用户（tenant_id=新租户）；用户名已存在则报错
    // 生命周期对齐设计 §3.4.2：注册（seedTenantDefaults 内幂等 INSERT crm.tenants）→ 播种 → 引导账号
    createTenant: async ({ tenantId, adminUser, adminPass, createdBy }) => {
      const { rows } = await query(`SELECT 1 FROM crm.crm_users WHERE username=$1`, [adminUser]);
      if (rows.length) throw new Error('用户名已存在');
      // ① 租户注册 + 差异化键播种（2026-09-05 G6：all=true 播全量 8 租户级键——完全独立不共享，
      //   新租户立即自持一份 8 键默认，不再运行时回退 system；createdBy 责任归属见设计 §D2）
      await seedTenantDefaults(tenantId, { all: true, createdBy }).catch((e) => {
        // 播种失败不阻断建租户主链路（fail-open，设计 §3.5.1）；留痕 trace
        console.error(`[tenant-router] seedTenantDefaults 失败（建租户继续）: ${e?.message || e}`);
      });
      // ② 引导账号（admin 用户）
      const pw = await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [adminPass]);
      await queryWrite(
        `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id)
         VALUES ($1, $2, 'admin', $3, $4)`,
        [adminUser, pw.rows[0].h, adminUser, tenantId]
      );
      return { tenantId, adminUser };
    },
    // 列出租户 + 每租户用户数/粒子数（平台级只读聚合）；并暴露责任 sysadmin 归属 created_by_username（设计 §D2）
    listTenants: async (createdBy) => {
      const where = createdBy ? `WHERE t.created_by_username ILIKE $1` : '';
      const params = createdBy ? [`%${createdBy}%`] : [];
      const r = await query(
        `SELECT t.tenant_id,
                t.name,
                t.status,
                t.created_by_username,
                count(DISTINCT u.username) AS users,
                (SELECT count(*) FROM particles p WHERE p.tenant_id=t.tenant_id) AS particles
         FROM crm.tenants t
         LEFT JOIN crm.crm_users u ON u.tenant_id = t.tenant_id
         ${where}
         GROUP BY t.tenant_id, t.name, t.status, t.created_by_username
         ORDER BY t.tenant_id`,
        params
      );
      return r.rows;
    },
  };
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  // GET /api/tenants（admin/sysadmin）；支持 ?createdBy= 按创建者筛选
  router.get('/api/tenants', async (req, res) => {
    const me = await D.ensureAdmin(req, res); if (!me) return;
    try { res.json({ tenants: await D.listTenants(req.query.createdBy) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/tenants（admin/sysadmin + 决策第0闸：建租户留痕为 config_change 决策）
  router.post('/api/tenants', async (req, res) => {
    const me = await D.ensureAdmin(req, res); if (!me) return;
    const { tenantId, adminUser, adminPass } = req.body || {};
    if (!tenantId || !adminUser || !adminPass) {
      return res.status(400).json({ error: 'tenantId/adminUser/adminPass required' });
    }
    try {
      // 第0闸：建租户=配置变更，落真实决策行（审计闭环，禁删铁律）
      const decision = await produceDecision({ scenario_id: 'config_change', fields: ['tenant:' + tenantId] });
      // 责任 sysadmin 归属（设计 §D2）：解析当前操作人（admin/sysadmin）是否为 sysadmin 角色
      const ref = await resolveSysadminRef(me.username);
      const t = await D.createTenant({
        tenantId, adminUser, adminPass,
        createdBy: ref ? { user_id: ref.user_id, username: ref.username } : null,
      });
      res.json({ ok: true, tenant: t, decisionId: decision?.decisionId || null });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 供注入式单测复用（与 plan T6 Step1 契约一致）
  router.handlers = { post: router.post.bind(router), get: router.get.bind(router) };
  // 测试接缝：暴露默认实现便于 DB-BACKED 单测直接验证真实 SQL（不影响运行期行为）
  router.listTenants = D.listTenants;
  router.createTenant = D.createTenant;
  return router;
}
