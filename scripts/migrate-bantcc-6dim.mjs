// scripts/migrate-bantcc-6dim.mjs — BANTCC 五维 → 六维迁移（幂等）
// 背景：evaluator.js 原把 coach（内线）与 competition（竞争）混进单一 C，现按 SKILL 拆为
//   C1 = Competition 竞争情况、C2 = Company & Condition 公司支持与条件，分母 5 → 6。
// 迁移动作：为尚未落 bantcc_detail（六维明细）的 CRM_DEAL 补算并写入 payload.ai.bantcc_detail。
// 幂等：已落库且为六键的跳过；重复执行 changed=0。全量覆盖不删除任何字段（禁 DELETE 铁律）。
// 用法：node scripts/migrate-bantcc-6dim.mjs
import { pool } from '../src/db.js';
import { deterministicEval } from '../src/aiAttributes/evaluator.js';

const SIX_KEYS = ['B', 'A', 'N', 'T', 'C1', 'C2'];

function isSixDim(detail) {
  if (!detail || typeof detail !== 'object') return false;
  const keys = Object.keys(detail);
  return keys.length >= SIX_KEYS.length && SIX_KEYS.every((k) => k in detail);
}

/**
 * 执行一次迁移。
 * @returns {Promise<{scanned:number, changed:number, skipped:number}>}
 */
export async function migrateBantcc6Dim() {
  const { rows } = await pool.query(
    `SELECT id, type, payload FROM crm.particles WHERE type = 'CRM_DEAL'`,
  );
  let scanned = 0, changed = 0, skipped = 0;
  for (const row of rows) {
    scanned++;
    const payload = row.payload || {};
    const existing = payload.ai?.bantcc_detail?.value;
    if (isSixDim(existing)) { skipped++; continue; }
    const r = deterministicEval('CRM_DEAL', payload, { key: 'bantcc_detail' });
    if (!isSixDim(r?.value)) { skipped++; continue; }
    const ai = {
      ...(payload.ai || {}),
      bantcc_detail: {
        value: r.value,
        axis: 'J_Judge',
        source: '规则+AI确认',
        confidence: 0.8,
        rationale: r.rationale,
        generated_at: new Date().toISOString(),
        degraded: true, // 确定性兜底（无 LLM）
      },
    };
    // 全量覆盖 payload（合并 ai），不删任何既有字段
    await pool.query(
      `UPDATE crm.particles SET payload = $2, updated_at = now() WHERE id = $1`,
      [row.id, JSON.stringify({ ...payload, ai })],
    );
    changed++;
  }
  return { scanned, changed, skipped };
}

// 直接执行入口
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateBantcc6Dim()
    .then((r) => { console.log('BANTCC 六维迁移完成', r); return pool.end(); })
    .then(() => process.exit(0))
    .catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
}
