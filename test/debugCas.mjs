import { query, queryWrite } from '../src/db.js';
import { getParticle, updateParticle } from '../src/particles/particleRepo.js';

const tenantId = 'tDBG';
const r = await queryWrite(
  `INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
   VALUES ($1, 'CRM_DEAL', 'crm-deal', $2, 'ACTIVE', $3::jsonb, NULL) RETURNING id`,
  [tenantId, 'dbg', JSON.stringify({ name: 'dbg', stage: 'S0', source: 'discovery' })]
);
const id = r.rows[0].id;
console.log('inserted', id);
const cur = await getParticle(id);
console.log('cur.payload', JSON.stringify(cur.payload));
console.log('cur.tenant_id', cur.tenant_id);
try {
  const updated = await updateParticle(id, {
    patch: {
      ...cur.payload,
      stage: 'S0P',
      owner_id: 'picker',
      prev_owner_id: null,
      picked_at: new Date().toISOString(),
      pool_id: 'p1', pool_type: 'new',
    },
    requireDecisionId: 'dec-1', tenantId,
    casExpectStage: 'S0', casExpectOwnerEmpty: true,
  });
  console.log('OK updated stage=', updated.payload.stage, 'owner=', updated.payload.owner_id);
} catch (e) {
  console.log('THROW:', e.message);
}
process.exit(0);
