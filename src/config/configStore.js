// src/config/configStore.js —— config_store 统一读写（per-tenant + autoSeed）
// 多租户设计枢轴 4（全量 per-tenant）：业务/配置均按租户隔离。
// 2026-09-05 用户决策「完全独立不共享」：租户缺键 → 读时自动从 system 模板落默认到该租户（_seeded 标记），
//   此后该租户完全自持一份；system 仅作模板源，不再运行时回退（G1 修复）。
// 禁删铁律：写用 upsert（ON CONFLICT DO UPDATE），绝不物理删除配置行。
import { query, queryWrite } from '../db.js';
import { mergeProfile } from './profileMerger.js';

const PLATFORM = 'system';
const WILDCARD = '*'; // admin/sysadmin 通配视界（scopeTenant 返回值）——非真实租户，禁 autoSeed 落行

// 读：先查 (tenantId, key)；缺 → 从 (system, key) 模板 autoSeed 落租户（只读触发、幂等）→ 再无返回 null
// 返回 { value, decision_id } 或 null（与历史 configRouter 契约一致）
// ⚠ '*' 是 admin/sysadmin 通配视界（scopeTenant），不是真实租户——不 autoSeed 写（避免污染 '*' 伪租户行），
//   直接读 system 模板（通配读语义 = 看平台默认）。2026-09-05 修复：此前 '*' 读触发 autoSeed 落 '*' 行。
async function rawRead(key, tenantId = PLATFORM) {
  if (tenantId !== PLATFORM && tenantId !== WILDCARD) {
    const r = await query(
      `SELECT value, decision_id FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
      [tenantId, key]
    );
    if (r.rows[0]) return r.rows[0];
    // autoSeed：租户缺键 → 从 system 模板落租户（幂等：INSERT ... ON CONFLICT DO NOTHING）
    const s = await query(
      `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
      [PLATFORM, key]
    );
    if (s.rows[0]) {
      // 深拷贝 + _seeded 标记（审计：该值来自系统模板，租户尚未定制）
      const seededValue = { ...s.rows[0].value, _seeded: 'system-template' };
      await queryWrite(
        `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
         VALUES ($1, $2, $3::jsonb, NULL, 'system', now())
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId, key, JSON.stringify(seededValue)]
      );
      const r2 = await query(
        `SELECT value, decision_id FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
        [tenantId, key]
      );
      if (r2.rows[0]) return r2.rows[0];
    }
  }
  const r = await query(
    `SELECT value, decision_id FROM crm.config_store WHERE tenant_id=$1 AND key=$2`,
    [PLATFORM, key]
  );
  return r.rows[0] || null;
}

export async function readConfig(key, { tenantId = PLATFORM } = {}) {
  const row = await rawRead(key, tenantId);
  if (!row) return null;
  // 多行业画像（tenant-profile）：把多 industry 合并成扁平对象（prototypes/calculations/approvalDomains），
  // 下游三消费点（resolvePrototype / isControlledPredicateConfig / runProfileCalculations）接口零变动。
  // v1 单行业格式（无 industries 数组）原样返回（兼容未迁移租户）。design §4.3。
  if (key === 'tenant-profile') {
    return { ...row, value: mergeProfile(row.value) };
  }
  return row;
}

// 写：按 tenantId 落 (tenant_id, key)；冲突更新（禁删铁律）
export async function writeConfig(key, value, { tenantId = PLATFORM, decisionId = null, updatedBy = 'system' } = {}) {
  await queryWrite(
    `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=$3::jsonb, decision_id=$4, updated_by=$5, updated_at=now()`,
    [tenantId, key, JSON.stringify(value), decisionId, updatedBy]
  );
  return { ok: true, tenantId, key };
}
