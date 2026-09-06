// src/sales/importService.js — 导入 upsert 批量写（T3-10；设计 §H27：导入新建/更新双模式，幂等）
// 原生机制：导入/导出 = 批量写/读 Action 的工程通道（§5ter-quater Q.18：不是独立功能，是写粒子管线的两个方向）
// upsert = 按粒子唯一 ID 匹配（存在更新/不存在新增），幂等（重复导入不产生重复粒子）
// 批量过闸：crm-import-batch confirm:'critical'（写通道确认必需）+ autoDecision 第 0 闸
import { emit } from '../events/bus.js';

// —— upsert 分派（纯逻辑，可本地单测）：rows 按「有无 id」切分 insert/update ——
// rows: [{ id?, ...payload }]
// 返回值：{ toCreate, toUpdate } —— toUpdate 仅保留有 id 的行（id 为匹配键）
export function partitionRows(rows, mode) {
  const list = rows || [];
  if (mode === 'insert') return { toCreate: list, toUpdate: [] };
  // upsert 模式：有 id → 更新通道；无 id → 新建通道
  const toCreate = list.filter((r) => r.id == null);
  const toUpdate = list.filter((r) => r.id != null);
  return { toCreate, toUpdate };
}

// —— 每行写前校验（轻量闸）：关键字段缺者拒（行级），不中断整批 ——
// required: string[] —— 缺任一 → 记 reason 跳过（导入失败不污染）
export function validateRows(rows, required = []) {
  const errors = [];
  (rows || []).forEach((r, i) => {
    for (const f of required) {
      if (r[f] == null || r[f] === '') {
        errors.push({ row: i + 1, field: f, reason: `${f} 必填缺失` });
        break;
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

// —— 批量写（幂等 upsert 执行）：建=createParticle / 更=updateParticle ——
// 返回统计：{ created, updated, skipped, errors }
export async function importBatch({ particle_type, rows, mode = 'upsert', required = [], tenantId = 'system', accountGuard = false, decisionId = null }) {
  const { createParticle, updateParticle } = await import('../particles/particleRepo.js');
  const { toCreate, toUpdate } = partitionRows(rows, mode);
  // 写前校验（create 侧 required 必填；update 侧只要求 id）
  const check = validateRows(toCreate, required);
  const stats = { created: 0, updated: 0, skipped: 0, errors: [] };
  stats.skipped += check.errors.length;
  stats.errors.push(...check.errors.map((e) => `行${e.row}: ${e.reason}`));
  // 逐个创建（跳过校验失败行）
  for (const r of toCreate) {
    if (check.errors.some((e) => rows.indexOf(r) + 1 === e.row)) continue;
    // §5 防复发：CRM_DEAL 写前账户归属守护（软外键 + 名称一致 + find-or-create）
    if (particle_type === 'CRM_DEAL' && accountGuard) {
      try {
        const { resolveDealAccount } = await import('./accountGuard.js');
        const { account_id } = await resolveDealAccount({ payload: r, tenantId, actor: r.owner || null });
        if (account_id) r.account_id = account_id;
      } catch (e) {
        stats.errors.push(`行${rows.indexOf(r) + 1}: 账户归属校验失败 ${e.message}`);
        stats.skipped += 1;
        continue;
      }
    }
    try {
      await createParticle(particle_type, { ...r, invalid: false }, { tenantId, requireDecisionId: decisionId });
      stats.created += 1;
    } catch (e) {
      stats.errors.push(`创建失败: ${e.message}`);
    }
  }
  // 逐个更新（id 匹配键；重复 id 幂等覆盖）
  for (const r of toUpdate) {
    // §5 防复发：CRM_DEAL 重绑写前账户归属守护（account_id 必须真实存在 + 名称一致）
    if (particle_type === 'CRM_DEAL' && accountGuard && (r.account_id || r.customer || r.customer_name)) {
      try {
        const { resolveDealAccount } = await import('./accountGuard.js');
        const { account_id } = await resolveDealAccount({ payload: r, tenantId, actor: r.owner || null });
        if (account_id) r.account_id = account_id;
      } catch (e) {
        stats.errors.push(`更新失败(行 id=${r.id}): 账户归属校验失败 ${e.message}`);
        stats.skipped += 1;
        continue;
      }
    }
    try {
      await updateParticle(r.id, { patch: { ...r, id: undefined }, requireDecisionId: decisionId });
      stats.updated += 1;
    } catch (e) {
      stats.errors.push(`更新失败(行 id=${r.id}): ${e.message}`);
    }
  }
  emit('crm', 'import-batch-done', { particle_type, mode, ...stats });
  return stats;
}

// —— 导出侧：补唯一 ID（匹配键闭环，§H27 验收③ 导出默认带唯一 id）——
export function toExportRows(particles) {
  return (particles || []).map((p) => ({ id: p.id, ...(p.payload || {}) }));
}