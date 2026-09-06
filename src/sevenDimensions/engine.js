// src/sevenDimensions/engine.js — 七维完整性校验引擎（D3：决策场景级完整性校验）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §2.4 七维校验引擎
// 运行期契约：sevenDimensionsCheck(scenarioId, ctx) → {required, missing:[{dim,on_missing}], level, allowed}
//   required：全必填维清单（{dim,on_missing} 数组），供 attribution 物化复用，单一事实源，不另算
//   缺失 required 维且 on_missing='block' → level='block', allowed=false（写引擎返回 missing_context 拒写）
//   缺失 on_missing='warn' → level='warn'（可写但打标，禁止 AI 脑补）
// 无 required_dims 列时（Task 9 迁移前）→ 默认 warn 语义（不阻断，避免误伤既有写流程）
import { query as defaultQuery } from '../db.js';

export async function sevenDimensionsCheck(scenarioId, ctx = {}, { query: q = defaultQuery } = {}) {
  let required = [];
  try {
    const r = await q(`SELECT required_dims FROM decision_scenario WHERE scenario_id=$1`, [scenarioId]);
    required = r.rows[0]?.required_dims || [];
    if (!Array.isArray(required)) required = [];
  } catch {
    // 列不存在（迁移前）或场景不存在：默认不阻断（warn 语义）
    required = [];
  }

  const missing = [];
  for (const r of required) {
    const dim = typeof r === 'string' ? r : r?.dim;
    if (!dim) continue;
    const val = ctx?.[dim];
    if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
      missing.push({ dim, on_missing: (typeof r === 'string' ? 'warn' : (r?.on_missing || 'warn')) });
    }
  }

  const blocked = missing.filter((m) => m.on_missing === 'block');
  return {
    required, // 全必填维清单（单一事实源，attribution 物化复用，不另算）
    missing,
    level: blocked.length ? 'block' : (missing.length ? 'warn' : 'ok'),
    allowed: blocked.length === 0,
  };
}

