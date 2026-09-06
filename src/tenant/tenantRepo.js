// src/tenant/tenantRepo.js — 租户注册表运行时查询封装（T9）
// 设计：docs/2026-09-03-config-center-tenant-isolation-design.md §3.4
// 铁律：禁 DELETE（停用=status 字段）；本模块只读，不提供写（写入走 SQL/种子/维护脚本或未来控制台）
import { query, queryWrite } from '../db.js';

// 活动租户列表（巡检循环/派发使用；status='active'）
// 返回 [{ tenant_id, name }]；异常回退 [system]（fail-open 不阻断巡检，见 timers.js 消费点）
export async function listActiveTenants() {
  try {
    const r = await query(
      `SELECT tenant_id, name FROM crm.tenants WHERE status='active' ORDER BY tenant_id`
    );
    const rows = r.rows || [];
    if (!rows.some((t) => t.tenant_id === 'system')) rows.unshift({ tenant_id: 'system', name: '平台默认租户' });
    return rows;
  } catch {
    return [{ tenant_id: 'system', name: '平台默认租户' }];
  }
}

// 任意状态租户（生命周期管理面用）
export async function listTenants({ status = null } = {}) {
  const r = await query(
    status
      ? `SELECT tenant_id, name, status, created_at, suspended_at, retired_at FROM crm.tenants WHERE status=$1 ORDER BY tenant_id`
      : `SELECT tenant_id, name, status, created_at, suspended_at, retired_at FROM crm.tenants ORDER BY tenant_id`
  );
  return r.rows || [];
}

// 断言至少 system 存在（迁移/巡检前置检查，幂等）
export async function ensureSystemTenant() {
  const r = await query(`SELECT 1 FROM crm.tenants WHERE tenant_id='system'`);
  if (!r.rows.length) {
    // 写走 queryWrite（主池）——src/db.js 的 query 是读池，INSERT 必须经写池（以实际源码为准修正）
    await queryWrite(
      `INSERT INTO crm.tenants (tenant_id, name, status) VALUES ('system','平台默认租户','active')
       ON CONFLICT (tenant_id) DO NOTHING`
    ).catch(() => {}); // 竞态容错：并发首个写入胜出，重复 INSERT 幂等失败可忽略
  }
  return true;
}