// scripts/migrate-stage-s.mjs — 幂等将 CRM_DEAL.payload.stage 英文→S1-S8（无 DELETE）
// 2026-08-31 统一术语：数据库层纯重命名（方案 B，最彻底一致）。
// 安全：仅 UPDATE jsonb stage 字段；回滚用 S_ALIAS_REV 反向 jsonb_set（S3→quoted）。
import { queryWrite } from '../src/db.js';

const MAP = [
  ['lead', 'S1'], ['opportunity', 'S2'], ['quoted', 'S3'], ['contracted', 'S4'],
  ['ordered', 'S5'], ['paid', 'S6'], ['lost', 'S7'], ['disqualified', 'S8'],
];

async function main() {
  for (const [old, neu] of MAP) {
    const r = await queryWrite(
      `UPDATE crm.particles SET payload = jsonb_set(payload, '{stage}', to_jsonb($2::text))
       WHERE type='CRM_DEAL' AND payload->>'stage'=$1`,
      [old, neu]
    );
    console.log(`stage ${old} -> ${neu}: ${r.rowCount} 行`);
  }
  console.log('MIGRATE_STAGE_S_DONE');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
