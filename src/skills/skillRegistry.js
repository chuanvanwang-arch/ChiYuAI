// src/skills/skillRegistry.js — SKILL 注册表持久化（§6.6 后台启停）
// 设计输入：docs/superpowers/plans/2026-08-28-skill-registry-config.md
// 职责：
//  · 出厂声明：扫描 skills/ 下全部 SKILL 目录（method-* + crm-*），读各目录 registry.json
//    （skill_id/category/rbac_roles/enabled/methodology_id 出厂默认）；
//  · DB 持久化：skill_registry 表——DB 为启停权威源；首启幂等灌种子、不禁删只改 enabled；
//  · 快照：listSkillRegistry() = DB 行 ⊕ 出厂声明（DB enabled 覆盖；无 DB 行则取 SKILL 声明）；
//  · 启停写：setSkillEnabled() 只改 enabled + 同步内存 Map（引擎接线，立即生效，无需重启）。
import { query, queryWrite } from '../db.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSkillEnabled as syncMemory } from './registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(__dirname, '..', '..', 'skills');

// 读 SKILL 目录 registry.json（缺失/损坏 → null）
export function readSkillRegistryJson(skillDir) {
  try {
    return JSON.parse(readFileSync(join(SKILLS_ROOT, skillDir, 'registry.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 扫描 skills/ 全部 SKILL 目录，取出厂声明
export function listSkillDeclarations() {
  const out = [];
  let entries = [];
  try { entries = readdirSync(SKILLS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const reg = readSkillRegistryJson(e.name);
    if (!reg) continue;
    out.push({
      skill_id: reg.skill_id || e.name,
      category: reg.category || 'methodology',
      enabled: reg.enabled !== false,
      rbac_roles: reg.rbac_roles || [],
      methodology_id: reg.methodology_id || null,
    });
  }
  return out.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
}

// 首启幂等灌种子：SKILL 目录出厂声明 → DB（ON CONFLICT DO NOTHING，不覆盖既有 DB 状态）
export async function seedSkillRegistry() {
  const decls = listSkillDeclarations();
  let inserted = 0;
  for (const d of decls) {
    const r = await queryWrite(
      `INSERT INTO crm.skill_registry (skill_id, category, enabled, rbac_roles, methodology_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (skill_id) DO NOTHING`,
      [d.skill_id, d.category, d.enabled, d.rbac_roles, d.methodology_id]
    );
    inserted += r.rowCount || 0;
  }
  return { total: decls.length, inserted };
}

// DB 快照（管理页 GET）：DB 行 ⊕ 出厂声明——DB enabled 为权威，无 DB 行取声明
export async function listSkillRegistry() {
  const decls = listSkillDeclarations();
  let dbRows = [];
  try {
    dbRows = (await query(`SELECT skill_id, category, enabled, rbac_roles, methodology_id FROM crm.skill_registry ORDER BY skill_id`)).rows;
  } catch { /* DB 不可用（未 migrate）：退回纯出厂声明，管理页仍可读 */ }
  const dbMap = new Map(dbRows.map((r) => [r.skill_id, r]));
  return decls.map((d) => {
    const db = dbMap.get(d.skill_id);
    return {
      skill_id: d.skill_id,
      category: db?.category || d.category,
      enabled: db ? db.enabled : d.enabled,
      rbac_roles: db?.rbac_roles || d.rbac_roles,
      methodology_id: db?.methodology_id || d.methodology_id,
      source: db ? 'db' : 'skill',  // 供审计：该行启停来自 DB 还是 SKILL 声明
    };
  });
}

// 启停写（PUT）：只改 enabled；禁删（物理行保留）；同步内存立即生效
export async function setSkillEnabled(skillId, enabled) {
  const r = await queryWrite(
    `UPDATE crm.skill_registry SET enabled=$2, updated_by=$3, updated_at=now()
     WHERE skill_id=$1
     RETURNING skill_id, category, enabled, rbac_roles, methodology_id`,
    [skillId, !!enabled, 'admin']
  );
  if (!r.rows.length) throw new Error(`skill_registry 无 ${skillId}（未种子）`);
  syncMemory(skillId, !!enabled); // 引擎接线：内存注册表立即生效
  return r.rows[0];
}

// 启动接线（server.js 启动时调用一次）：把 DB 权威启停态应用到内存注册表
// 与 listSkillRegistry() 的 D2 合成逻辑完全一致（DB 行优先、无 DB 行用 SKILL 声明）
// → 使内存 enabled == DB 权威态，避免「DB 已停用但内存仍 enabled」的漂移
export async function applySkillRegistryToMemory() {
  const rows = await listSkillRegistry();
  let applied = 0;
  for (const r of rows) {
    if (syncMemory(r.skill_id, r.enabled)) applied++; // 只同步内存确实注册了的 slug
  }
  return { total: rows.length, applied };
}