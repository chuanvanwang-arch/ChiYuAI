// src/skills/methodologySync.js — 方法论 SKILL → DB 镜像表 写时同步（§6.6 单一事实源纪律）
// 设计输入：总体设计 §6.6「SKILL 为唯一事实源，methodology_template/methodology_dimension 为物化镜像，
//           写时同步（禁止只改表不更 SKILL）」；ai-ontology-vector-build 写时构建（知识在写入点同步）。
//
// 关键约束（2026-08-26 审计发现接线缺口后补）：
//  1. DB 镜像表是引擎消费点（autonomyEngine.js:22 从 methodology_dimension 读维度、decision.test.js 断言
//     7 模板 / MEDDICC 7 维），也是 decision_scenario.methodology_ids 的引用目标；
//  2. skills/method-*/methodology.json 是 SKILL 事实源，但其 methodology_id/dim_key 编号与 DB 旧种子
//     存在漂移（MEDDICC 用 M1/E1/D1/D2/I1/C1/C2，DB 用 M/E/D1/D2/I/C1/C2；OPPORTUNITY_MATRIX vs OPP_MATRIX 等）；
//  3. 因此不可「按 SKILL 直接覆盖 DB」（会断 scenario 引用、打翻 7 方法论断言）。
//
// 本模块采用【保守镜像 + 等价登记】策略：
//  - mirrorId 映射表：SKILL methodology_id → DB 既有 methodology_id（无漂移者即自身）；
//  - syncMethodologyFromSkill(skillId)：读取 SKILL methodology.json →
//      ① 等价方法论不存在（如 PRESALES_SOLUTION）→ 新建 template + dimensions（幂等）；
//      ② 等价方法论已存在 → 逐维 upsert（SKILL 有而 DB 无的维度增量补入；skew 维度保持不动，
//        因为 SKILL 尚未统一编号前不做破坏性改名，只登记 evidence 映射供审计/后续对齐）。
//  - listMethodologySkew()：输出 SKILL ↔ DB 镜像的维度漂移清单（审计辅助，供后续统一编号决策）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, queryWrite } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_ROOT = join(__dirname, '..', '..', 'skills');

// SKILL methodology_id（事实源命名）→ DB 镜像 methodology_id（既有种子命名）
// 无漂移的方法论映射为其自身；漂移者显式登记，避免断 scenario 引用。
const MIRROR_ID = {
  BANT: 'BANT',
  MEDDICC: 'MEDDICC',
  MEDDICC_V2: 'MEDDICC',        // skills/method-meddicc methodology_id 为 MEDDICC（与 DB 同名，dim_key 漂移在维级）
  OPPORTUNITY_MATRIX: 'OPP_MATRIX', // SKILL 用 OPPORTUNITY_MATRIX，DB 种子用 OPP_MATRIX（模板 id 漂移 → 显式映射）
  ROLE_MAP: 'ROLE_MAP',
  RISK_TRADEOFF: 'RISK_TRADEOFF',
  STOP_LOSS: 'STOP_LOSS',
  FACT_VS_SCRIPT: 'FACT_VS_TALK',  // SKILL 用 FACT_VS_SCRIPT，DB 种子用 FACT_VS_TALK（模板 id 漂移 → 显式映射）
  PRESALES_SOLUTION: 'PRESALES_SOLUTION', // 售前（DB 种子无此模板 → 新建）
};

// SKILL 维键 → DB 镜像维键 归一映射（按方法论；防漂移维重复插入）
// 事实源 SKILL 用 M1/E1/I1（method-meddicc 等），DB 既有种子用 M/E/I — 同步时归一后 upsert。
// 2026-08-26 审计修正：F1 目标应为 DB 既有 win_prob（非当初臆造的 win_prob2）；P1 竞争定位是 SKILL
//   的真实独立维（DB 种子缺），归一到语义化键 competitive_position（新建维，不破坏既有 value/win_prob）。
const DIM_KEY_NORMALIZE = {
  MEDDICC: { M1: 'M', E1: 'E', I1: 'I' },       // 其余 D1/D2/C1/C2 同名
  OPPORTUNITY_MATRIX: { V1: 'value', F1: 'win_prob', P1: 'competitive_position' },
  ROLE_MAP: { D: 'economic_buyer', I: 'champion', U: 'blocker', S: 'sponsor' },
  RISK_TRADEOFF: { R: 'exposure', B: 'control', RD: 'upside', M: 'margin' },
  // STOP_LOSS：CB(投入预算上限 Cost Budget) 归一键须为 cost_budget，绝非 probability。
  // 旧版误归一为 probability（与 SKILL 事实源 methodology.json STOP_LOSS.CB 标签「投入预算上限 Cost Budget」
  // 自相矛盾，且使 listMethodologySkew 因两侧同口径归一报 dim_skew=false 形成审计假绿）。
  STOP_LOSS: { NV: 'burn', CB: 'cost_budget', EG: 'exit_guard' },
  FACT_VS_SCRIPT: { F: 'coach_fact', S: 'client_claim', E: 'evidence' },
};

// 归一 SKILL 维度：
//  - 方法论在 DIM_KEY_NORMALIZE 有映射（漂移键 → DB 键）→ 命中键改写；
//  - 有映射方法论的【同名键】透传（如 MEDDICC 的 D1/D2/C1/C2 与 DB 同名，不跳过）；
//  - 仅显式登记为 null 的键（无 DB 对应）才丢弃；
//  - 无归一映射方法论（BANT / PRESALES_SOLUTION 等 SKILL 键与 DB 键同名或 DB 尚无此模板）→ 原样保留全部维度，
//    否则新建模板（如 PRESALES_SOLUTION）会因全部键被跳过而零维度落库（2026-08-26 审计修复）。
export function normalizeDims(skillsMeta, dims = []) {
  const map = DIM_KEY_NORMALIZE[skillsMeta.methodology_id];
  if (!map) return [...dims];                      // 无映射方法论：原样保留（不漂移过滤）
  const out = [];
  for (const d of dims) {
    const k = map[d.dim_key];
    if (k === null) continue;                      // 显式跳过（P1 → competitive_position 等无 DB 对应，但此处已归一；真正的显式跳过留 null 键）
    out.push({ ...d, dim_key: k === undefined ? d.dim_key : k }); // 命中映射→改写；未命中（同名键）→透传原键
  }
  return out;
}

// 读 SKILL methodology.json（不存在返回 null）
export function readMethodologyJson(skillId) {
  try {
    const p = join(SKILLS_ROOT, skillId, 'methodology.json');
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// 列出全部 method-* SKILL 及其 DB 等价格（审计/同步入口）
export function listMethodologySkills() {
  const out = [];
  let entries = [];
  try { entries = readdirSync(SKILLS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('method-')) continue;
    const m = readMethodologyJson(e.name);
    if (!m || !m.methodology_id) continue;
    out.push({
      skill_id: e.name,
      methodology_id: m.methodology_id,
      mirror_id: MIRROR_ID[m.methodology_id] || m.methodology_id,
      role: m.role || null,
      dimensions: (m.dimensions || []).map((d) => ({ dim_key: d.dim_key, label: d.label, weight: d.weight, required: !!d.required })),
    });
  }
  return out;
}

// 等价方法论是否存在（DB 镜像侧）
async function templateExists(mirrorId) {
  const r = await query(`SELECT 1 FROM methodology_template WHERE methodology_id=$1`, [mirrorId]);
  return r.rows.length > 0;
}

// 方法论 SKILL → DB 镜像写时同步（幂等、保守；失败仅 trace，不阻断调用方主流程）
export async function syncMethodologyFromSkill(skillId, { dryRun = false } = {}) {
  const m = readMethodologyJson(skillId);
  if (!m) return { ok: false, reason: `SKILL ${skillId} 无 methodology.json` };
  const mirrorId = MIRROR_ID[m.methodology_id] || m.methodology_id;

  const ops = [];
  if (!(await templateExists(mirrorId))) {
    // 等价方法论不存在 → 新建模板 + 维度（幂等）
    ops.push(`INSERT template ${mirrorId} (new)`);
    if (!dryRun) {
      await queryWrite(
        `INSERT INTO methodology_template (methodology_id, name, description, structure)
         VALUES ($1,$2,$3, $4::jsonb)
         ON CONFLICT (methodology_id) DO NOTHING`,
        [mirrorId, m.name || skillId, m.description || m.priority_rule || '', JSON.stringify({ dimensions: (m.dimensions || []).map((d) => d.dim_key) })]
      );
    }
  }

  // 归一 SKILL 维度（漂移键→DB 键；未知键保守跳过）→ 逐维增量 upsert（已存在同 key 不动，防破坏既有断言）
  const dims = normalizeDims(m, m.dimensions || []);
  let added = 0;
  for (const d of dims) {
    const exist = await query(
      `SELECT 1 FROM methodology_dimension WHERE methodology_id=$1 AND dim_key=$2`,
      [mirrorId, d.dim_key]
    );
    if (!exist.rows.length) {
      ops.push(`INSERT dim ${mirrorId}.${d.dim_key} (new)`);
      added++;
      if (!dryRun) {
        await queryWrite(
          `INSERT INTO methodology_dimension (methodology_id, dim_key, label, weight, required)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (methodology_id, dim_key) DO NOTHING`,
          [mirrorId, d.dim_key, d.label || d.dim_key, d.weight ?? 1.0, !!d.required]
        );
      }
    }
  }

  return {
    ok: true, skill_id: skillId, methodology_id: m.methodology_id, mirror_id: mirrorId,
    dry_run: dryRun, ops, added,
  };
}

// 全量同步（遍历 method-*；幂等）
export async function syncAllMethodologies({ dryRun = false } = {}) {
  const results = [];
  for (const s of listMethodologySkills()) {
    try { results.push(await syncMethodologyFromSkill(s.skill_id, { dryRun })); }
    catch (e) { results.push({ ok: false, skill_id: s.skill_id, error: String(e?.message || e) }); }
  }
  return results;
}

// SKILL ↔ DB 镜像 维度漂移清单（审计辅助；供后续统一编号决策，不自动改名）
//
// 2026-08-31 审计修复：本函数此前用 SKILL【原始】dim_key 直接比对 DB，而 syncMethodologyFromSkill
//   落库时走的是 normalizeDims（DIM_KEY_NORMALIZE 别名归一，如 MEDDICC M1→M、ROLE_MAP D→economic_buyer）。
//   两侧口径不一致 → 6 个方法 SKILL 全被误报为「维度漂移」（假漂移），知识闭环条据此误判为断点。
//   现改为：比对前先 normalizeDims，与同步口径对齐；并把漂移拆成两级：
//     - dim_skew（维度级真漂移）：归一后仍有 missing_in_db / missing_in_skill → 需人工对齐（真断点）
//     - mapped（模板 id 已映射）：仅 methodology_id ≠ mirror_id 且该映射已在 MIRROR_ID 显式登记 → 已治理，非断点
//   原有字段（skill_id/methodology_id/mirror_id/db_dims/skill_dims/missing_in_db/missing_in_skill）保持不变，向后兼容。
export async function listMethodologySkew({ dryRun = false } = {}) {
  const out = [];
  for (const s of listMethodologySkills()) {
    const dbDims = (await query(
      `SELECT dim_key FROM methodology_dimension WHERE methodology_id=$1 ORDER BY dim_key`,
      [s.mirror_id]
    )).rows.map((r) => r.dim_key);
    // 归一后比对：与 syncMethodologyFromSkill 落库口径一致（消除别名造成的假漂移）
    const skillDims = normalizeDims(s, s.dimensions).map((d) => d.dim_key);
    const missingInDb = skillDims.filter((k) => !dbDims.includes(k));
    const missingInSkill = dbDims.filter((k) => !skillDims.includes(k));
    const dimSkew = missingInDb.length > 0 || missingInSkill.length > 0;
    const idSkew = s.methodology_id !== s.mirror_id;
    // 模板 id 漂移是否已被 MIRROR_ID 显式登记（已治理）→ true 表示「已知映射」，非待办断点
    const mapped = idSkew && Object.prototype.hasOwnProperty.call(MIRROR_ID, s.methodology_id);
    if (dimSkew || idSkew) {
      out.push({
        skill_id: s.skill_id, methodology_id: s.methodology_id, mirror_id: s.mirror_id,
        db_dims: dbDims, skill_dims: skillDims,
        missing_in_db: missingInDb, missing_in_skill: missingInSkill,
        dim_skew: dimSkew,   // 维度级真漂移（需处理）
        id_skew: idSkew,     // 模板 id 命名漂移
        mapped,              // id 漂移已由 MIRROR_ID 显式映射（已治理）
      });
    }
  }
  return out;
}