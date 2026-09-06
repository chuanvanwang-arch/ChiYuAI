// src/skill/skillScope.js — P3 D2 Skill 三层作用域（统一设计 v3 §3.5 / §11.5-D2）
//
// 职责：Skill（可重复工作流）的三层作用域治理 —— system / workspace / user，
//       以及「个人试跑 → 推广」路径（user 试跑成熟后 promote 到 workspace / system）。
//
// 判据（§3.5）：Knowledge = 每次都要重复讲的公司背景；Skill = 给新人讲过三遍的可重复工作流。
//   本项目 Skill 内容仍以 method-* SKILL 文件为事实源；本表只治理「作用域与启用」，
//   不托管 SKILL 体（避免与文件系统双源）——content 层边界清晰，符合铁律「单一事实源」。
//
// 冲突消解（纯函数可单测）：user > workspace > system。同一 skill 在多层均存在时，
//   高层（user）覆盖低层（system）的启用态；仅当高层未声明时才回落低层。

export const SCOPE_LEVELS = ['system', 'workspace', 'user'];

/**
 * 纯函数：从原始 scope 行解析「生效 Skill 集合」。
 * @param {Array} rows  [{ skill, scope_level, owner, enabled, promoted_from }]
 * @param {object} [scope]  { workspace?:string, user?:string } 用于筛选归属
 * @returns {Map<string,{skill,scope_level,owner,enabled,promoted_from}>} 生效集合（已按层优先级归并）
 */
export function resolveEffectiveSkills(rows, scope = {}) {
  const wk = scope.workspace || null;
  const us = scope.user || null;
  const tn = scope.tenantId || null;
  // 归并：按 (skill, owner, tenant) 收集各层声明（tenant 轴为新增，默认无 tenant 时行为不变）
  const byKey = new Map(); // `${skill}|${owner}|${tenant}` -> {system, workspace, user, tenantScope}
  for (const r of rows || []) {
    const lvl = r.scope_level;
    if (!SCOPE_LEVELS.includes(lvl)) continue;
    const owner = r.owner ?? null;
    const tenant = r.tenant_id ?? null;
    // 作用域筛选：workspace 行须匹配 scope.workspace；user 行须匹配 scope.user；tenant 行须匹配 scope.tenantId
    if (lvl === 'workspace' && wk && owner && owner !== wk) continue;
    if (lvl === 'user' && us && owner && owner !== us) continue;
    if (tenant && tn && tenant !== tn) continue;
    const k = `${r.skill}|${owner ?? ''}|${tenant ?? ''}`;
    const slot = byKey.get(k) || { skill: r.skill, owner, tenant, system: null, workspace: null, user: null, tenantScope: null, tenantScopeLevel: null };
    slot[lvl] = { enabled: !!r.enabled, promoted_from: r.promoted_from ?? null, id: r.id ?? null };
    if (tenant) { slot.tenantScope = slot[lvl]; slot.tenantScopeLevel = lvl; }
    byKey.set(k, slot);
  }
  // 优先级归并：user > workspace > tenant > system（tenant 轴介于 user/workspace 与 system 之间）
  const eff = new Map();
  for (const slot of byKey.values()) {
    const pick = slot.user || slot.workspace || slot.tenantScope || slot.system;
    if (!pick) continue;
    const scopeLevel = slot.user ? 'user' : slot.workspace ? 'workspace' : slot.tenantScope ? (slot.tenantScopeLevel || 'tenant') : 'system';
    eff.set(slot.skill, {
      skill: slot.skill,
      owner: slot.owner,
      tenant_id: slot.tenant,
      scope_level: scopeLevel,
      enabled: pick.enabled,
      promoted_from: pick.promoted_from,
    });
  }
  return eff;
}

/**
 * 从 DB 读取并解析生效 Skill 集合（system 全量 + 指定 workspace/user 行）。
 * @param {object} pool
 * @param {object} [scope] { workspace?, user? }
 */
export async function effectiveSkillSet(pool, scope = {}) {
  const rows = (
    await pool.query(
      `SELECT id, skill, scope_level, owner, enabled, promoted_from, tenant_id
       FROM crm.skill_scope
       WHERE scope_level='system'
          OR (scope_level='workspace' AND (owner IS NULL OR $1::text IS NULL OR owner=$1))
          OR (scope_level='user' AND (owner IS NULL OR $2::text IS NULL OR owner=$2))
          OR (tenant_id IS NOT NULL AND (tenant_id = $3::text OR $3::text IS NULL))`,
      [scope.workspace ?? null, scope.user ?? null, scope.tenantId ?? null]
    )
  ).rows;
  const eff = resolveEffectiveSkills(rows, scope);
  return { skills: [...eff.values()], enabled: [...eff.values()].filter((s) => s.enabled).map((s) => s.skill) };
}

/**
 * 启用/停用某作用域的 skill（幂等 upsert）。
 * @param {object} pool
 * @param {object} p { skill, scope_level, owner?, enabled=true }
 */
export async function setSkillEnabled(pool, { skill, scope_level, owner = null, enabled = true }) {
  if (!SCOPE_LEVELS.includes(scope_level)) throw new Error(`非法 scope_level: ${scope_level}`);
  if (!skill) throw new Error('skill 必填');
  await pool.query(
    `INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (skill, scope_level, COALESCE(owner,''))
     DO UPDATE SET enabled=$4, created_at=now()`,
    [skill, scope_level, owner, enabled]
  );
  return { ok: true, skill, scope_level, owner, enabled };
}

/**
 * 个人试跑 → 推广路径：把 user 试跑成熟的 skill 提升到 workspace / system。
 * 写一条带 promoted_from 的 scope 行（保留溯源），并 emit trace 留痕（不静默）。
 * @param {object} pool
 * @param {object} p { skill, from:'user', to:'workspace'|'system', by, note? }
 */
export async function promoteSkill(pool, { skill, from, to, by, note = null, tenantId = null }) {
  // 轴 B：tenant→system（方法论升为平台默认）。复制租户级定制行到 system 行并溯源。
  if (from === 'tenant') {
    if (!tenantId) throw new Error('promoteSkill(from=tenant) 需要 tenantId 来源租户');
    if (to !== 'system') throw new Error('tenant 轴推广当前仅支持 to=system（方法论升为平台默认）');
    if (!skill || !by) throw new Error('promoteSkill 需要 skill 与 by');
    const src = await pool.query(
      `SELECT * FROM crm.skill_scope WHERE skill=$1 AND tenant_id=$2 LIMIT 1`,
      [skill, tenantId]
    );
    if (!src.rows[0]) throw new Error(`租户 ${tenantId} 无 skill ${skill} 的定制行，无法推广`);
    const promotedFrom = `tenant:${tenantId}:${skill}`;
    const r = await pool.query(
      `INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled, promoted_from, note, tenant_id)
       VALUES ($1,'system',NULL,true,$2,$3,NULL)
       ON CONFLICT (skill, scope_level, COALESCE(owner,''))
       DO UPDATE SET promoted_from=$2, note=$3, enabled=true, created_at=now() RETURNING *`,
      [skill, promotedFrom, note]
    );
    try {
      const { emit } = await import('../events/bus.js');
      emit('trace', 'skill-promoted', { skill, from, to, tenantId, by });
    } catch { /* emit 不可用不阻塞 */ }
    return { ok: true, skill, from, to, promoted_from: promotedFrom, row: r.rows[0] };
  }
  if (from !== 'user') throw new Error('promoteSkill 仅支持从 user 试跑推广（from=user）');
  if (!SCOPE_LEVELS.includes(to) || to === 'user') throw new Error(`非法推广目标: ${to}`);
  if (!skill || !by) throw new Error('promoteSkill 需要 skill 与 by');
  // 推广目标层的 owner 归并规则：user 行挂推广人；workspace/system 为「该层全局」(owner=null)，
  // 避免按 owner 过滤时被排除（effectiveSkillSet 对 workspace 行按 owner 匹配，null 视为全局生效）。
  const targetOwner = to === 'user' ? by : null;
  const r = await pool.query(
    `INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled, promoted_from, note)
     VALUES ($1,$2,$3,true,$4,$5)
     ON CONFLICT (skill, scope_level, COALESCE(owner,''))
     DO UPDATE SET promoted_from=$4, note=$5, enabled=true, created_at=now()
     RETURNING *`,
    [skill, to, targetOwner, from, note]
  );
  // 反假绿 / 不静默：emit 留痕
  try {
    const { emit } = await import('../events/bus.js');
    emit('trace', 'skill-promoted', { skill, from, to, by });
  } catch { /* emit 不可用不阻塞 */ }
  return { ok: true, skill, from, to, row: r.rows[0] };
}
